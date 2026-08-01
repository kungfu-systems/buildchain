import fs from "node:fs";

import path from "node:path";

function classifyPreviewAlias(alias) {
  if (/^pr-\d+$/.test(alias)) {
    return {
      kind: "pr",
      mutable: true,
      retentionClass: "preview-pr-ephemeral",
      retentionKey: "pr_days",
    };
  }
  if (/^sha-[0-9a-f]{6,40}$/i.test(alias)) {
    return {
      kind: "sha",
      mutable: false,
      retentionClass: "preview-sha-immutable",
      retentionKey: "sha_days",
    };
  }
  return {
    kind: "custom",
    mutable: true,
    retentionClass: "preview-custom-ephemeral",
    retentionKey: "pr_days",
  };
}

function resolveChannelUrl(channel, alias) {
  if (channel.urlPattern) {
    if (!alias) {
      throw new Error(`channel ${channel.name} requires alias for url_pattern`);
    }
    return channel.urlPattern.replaceAll("{alias}", alias);
  }
  return channel.url;
}

function resolvePathOnlyUrl(channel, sourcePath, alias) {
  const base = resolveChannelUrl(channel, alias);
  const url = new URL(base);
  const normalizedPath = normalizeSurfacePath(sourcePath);
  if (normalizedPath === "/") {
    return `${url.origin}/`;
  }
  return new URL(
    normalizedPath.replace(/^\//, ""),
    `${url.origin}/`,
  ).toString();
}

function resolveSurfaceUrl({ surface, channel, channelName, alias }) {
  if (channelName === "preview" && surface.previewUrlPattern) {
    if (!alias) {
      throw new Error(
        `surface ${surface.name} requires alias for preview_url_pattern`,
      );
    }
    return surface.previewUrlPattern.replaceAll("{alias}", alias);
  }
  if (channelName === "staging" && surface.stagingUrl) {
    return surface.stagingUrl;
  }
  if (channelName === "production" && surface.productionUrl) {
    return surface.productionUrl;
  }
  if (surface.pathOnly) {
    return resolvePathOnlyUrl(channel, surface.path, alias);
  }
  const key =
    channelName === "preview" ? "preview_url_pattern" : `${channelName}_url`;
  throw new Error(
    `surfaces.${surface.name}.${key} is required for channel ${channelName}`,
  );
}

function manifestPrefixFor(deployConfig) {
  return deployConfig.manifest_prefix || ".buildchain/deployments";
}

function objectPrefixFor(deployConfig, alias) {
  if (Object.hasOwn(deployConfig, "prefix")) {
    return normalizeS3Key(deployConfig.prefix);
  }
  return alias || "preview";
}

function normalizeSurfacePath(value) {
  const normalized = `/${String(value || "/").replace(/^\/+/, "")}`.replace(
    /\/{2,}/g,
    "/",
  );
  if (normalized === "/") {
    return normalized;
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function surfaceDeployConfig(deployConfig, surfaceName) {
  const overrides = deployConfig.surfaces?.[surfaceName];
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return deployConfig;
  }
  return {
    ...deployConfig,
    ...overrides,
    cacheControl:
      deployConfig.cacheControl || overrides.cacheControl
        ? {
            ...(deployConfig.cacheControl || {}),
            ...(overrides.cacheControl || {}),
          }
        : undefined,
    surfaces: deployConfig.surfaces,
    secretRefs: [
      ...new Set([
        ...(deployConfig.secretRefs || []),
        ...(Array.isArray(overrides.secretRefs) ? overrides.secretRefs : []),
      ]),
    ],
    artifactPath: overrides.artifactPath || deployConfig.artifactPath,
  };
}

function surfaceObjectPrefixFor({ deployConfig, surface, alias }) {
  const effective = surfaceDeployConfig(deployConfig, surface.name);
  if (Object.hasOwn(effective, "prefix")) {
    return normalizeS3Key(effective.prefix);
  }
  const root = objectPrefixFor(deployConfig, alias);
  const surfacePath = normalizeS3Key(surface.path);
  if (!surfacePath) {
    return root;
  }
  return joinS3Key(root, surfacePath);
}

function normalizeS3Key(value) {
  return String(value || "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

function joinS3Key(...parts) {
  return normalizeS3Key(parts.filter(Boolean).join("/"));
}

function joinUrlPath(...parts) {
  const raw = parts.join("/");
  const normalized = normalizeS3Key(raw);
  if (!normalized) {
    return "/";
  }
  return raw.endsWith("/") ? `/${normalized}/` : `/${normalized}`;
}

function urlWithPath(baseUrl, requestPath) {
  const url = new URL(baseUrl);
  url.pathname = joinUrlPath(requestPath);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function s3Uri(bucket, key = "") {
  if (!bucket) {
    throw new Error("aws-s3-cloudfront adapter requires a bucket or target");
  }
  const normalizedKey = normalizeS3Key(key);
  return normalizedKey ? `s3://${bucket}/${normalizedKey}` : `s3://${bucket}`;
}

function cdnPath(value) {
  const normalized = normalizeS3Key(value);
  return normalized ? `/${normalized}` : "/";
}

function cdnWildcardPath(value) {
  const normalized = normalizeS3Key(value);
  return normalized ? `/${normalized}/*` : "/*";
}

function viewerWildcardPath(binding) {
  try {
    return cdnWildcardPath(new URL(binding.url).pathname);
  } catch {
    return cdnWildcardPath(binding.objectPrefix);
  }
}

function surfaceArtifactPrefix(binding) {
  return normalizeS3Key(binding.sourcePath);
}

function surfaceArtifactRootFor({ artifactRoot, binding }) {
  const prefix = normalizeS3Key(
    binding.artifactPathPrefix || surfaceArtifactPrefix(binding),
  );
  const root = prefix ? path.join(artifactRoot, prefix) : artifactRoot;
  if (fs.existsSync(root)) {
    return root;
  }
  return artifactRoot;
}

function syncStaticArtifactArgs({
  artifactRoot,
  bucket,
  objectPrefix,
  deleteExcludes = [],
  cacheControl = "",
}) {
  const args = [
    "s3",
    "sync",
    artifactRoot,
    s3Uri(bucket, objectPrefix),
    "--delete",
  ];
  if (!objectPrefix) {
    args.push("--exclude", ".buildchain/*");
  }
  for (const pattern of deleteExcludes) {
    args.push("--exclude", pattern);
  }
  if (cacheControl) {
    args.push("--cache-control", cacheControl);
  }
  return args;
}

function mutableCacheControlArgs({
  artifactRoot,
  bucket,
  objectPrefix,
  cacheControl = "",
  excludePatterns = [],
}) {
  if (!cacheControl) return [];
  const args = [
    "s3",
    "cp",
    artifactRoot,
    s3Uri(bucket, objectPrefix),
    "--recursive",
    "--exclude",
    "*",
    "--include",
    "*.html",
    "--include",
    "*.json",
    "--include",
    "*.xml",
  ];
  for (const pattern of excludePatterns) {
    args.push("--exclude", pattern);
  }
  args.push("--cache-control", cacheControl);
  return args;
}

export {
  classifyPreviewAlias,
  resolveChannelUrl,
  resolvePathOnlyUrl,
  resolveSurfaceUrl,
  manifestPrefixFor,
  objectPrefixFor,
  normalizeSurfacePath,
  surfaceDeployConfig,
  surfaceObjectPrefixFor,
  normalizeS3Key,
  joinS3Key,
  joinUrlPath,
  urlWithPath,
  s3Uri,
  cdnPath,
  cdnWildcardPath,
  viewerWildcardPath,
  surfaceArtifactPrefix,
  surfaceArtifactRootFor,
  syncStaticArtifactArgs,
  mutableCacheControlArgs,
};

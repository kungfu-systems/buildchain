import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBuildchainConfig, validateBuildchainConfig } from "../packages/core/buildchain-config.js";
import { createSurfaceTimestampPolicy } from "../packages/core/surface-manifest.js";

const DEFAULT_RETENTION = Object.freeze({
  preview: {
    pr_days: 14,
    sha_days: 90,
  },
  staging: {
    days: 90,
    keep_deploys: 10,
  },
  production: {
    days: 365,
  },
});

function assertWebSurfaceConfig(loadedConfig) {
  if (loadedConfig?.config?.project?.type !== "web-surface") {
    throw new Error('buildchain.toml project.type must be "web-surface"');
  }
  return loadedConfig.config;
}

function assertSha(value, label) {
  const sha = String(value || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha.toLowerCase();
}

function assertHash(value, label) {
  const hash = String(value || "").trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`${label} must be a 64-character SHA-256 hash`);
  }
  return hash.toLowerCase();
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function listFiles(root, rel) {
  const target = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!fs.existsSync(target)) {
    throw new Error(`artifact path does not exist: ${rel}`);
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [target];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => listFiles(root, path.join(target, entry.name)));
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function addDays(iso, days) {
  if (days === undefined || days === null) {
    return "";
  }
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString();
}

function retentionConfig(config, channel) {
  return {
    ...(DEFAULT_RETENTION[channel] || {}),
    ...(config.retention?.[channel] || {}),
  };
}

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
  return new URL(normalizedPath.replace(/^\//, ""), `${url.origin}/`).toString();
}

function resolveSurfaceUrl({ surface, channel, channelName, alias }) {
  if (channelName === "preview" && surface.previewUrlPattern) {
    if (!alias) {
      throw new Error(`surface ${surface.name} requires alias for preview_url_pattern`);
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
  const key = channelName === "preview"
    ? "preview_url_pattern"
    : `${channelName}_url`;
  throw new Error(`surfaces.${surface.name}.${key} is required for channel ${channelName}`);
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
  const normalized = `/${String(value || "/").replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
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
  const prefix = normalizeS3Key(binding.artifactPathPrefix || surfaceArtifactPrefix(binding));
  const root = prefix ? path.join(artifactRoot, prefix) : artifactRoot;
  if (fs.existsSync(root)) {
    return root;
  }
  return artifactRoot;
}

function syncStaticArtifactArgs({ artifactRoot, bucket, objectPrefix }) {
  const args = ["s3", "sync", artifactRoot, s3Uri(bucket, objectPrefix), "--delete"];
  if (!objectPrefix) {
    args.push("--exclude", ".buildchain/*");
  }
  return args;
}

function directoryIndexAliasKeys({ objectPrefix, relativeIndexPath }) {
  const normalizedPrefix = normalizeS3Key(objectPrefix);
  if (!normalizedPrefix) {
    return [];
  }
  const normalizedIndexPath = normalizeS3Key(relativeIndexPath);
  if (!normalizedIndexPath.endsWith("index.html")) {
    return [];
  }
  const directory = normalizeS3Key(normalizedIndexPath.slice(0, -"index.html".length));
  const aliasBase = joinS3Key(normalizedPrefix, directory);
  return [...new Set([aliasBase, `${aliasBase}/`].filter(Boolean))];
}

function directoryIndexAliasOperations({ surfaceArtifactRoot, bucket, binding }) {
  if (binding.directoryIndexResolution === false || !bucket || !binding.objectPrefix || !fs.existsSync(surfaceArtifactRoot)) {
    return [];
  }
  return listFiles(surfaceArtifactRoot, ".")
    .filter((filePath) => path.basename(filePath) === (binding.directoryIndex || "index.html"))
    .flatMap((filePath) => {
      const relativeIndexPath = toPosix(path.relative(surfaceArtifactRoot, filePath));
      return directoryIndexAliasKeys({ objectPrefix: binding.objectPrefix, relativeIndexPath }).map((key) => ({
        action: "write-directory-index-alias",
        surface: binding.surface,
        command: "aws",
        args: [
          "s3api",
          "put-object",
          "--bucket",
          bucket,
          "--key",
          key,
          "--body",
          filePath,
          "--content-type",
          "text/html",
        ],
        routing: {
          ...(binding.routing || {}),
          directoryIndexAlias: key,
          directoryIndexSource: relativeIndexPath,
        },
      }));
    });
}

function defaultCommandRunner({ command, args, stdin = "" }) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: stdin,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${stderr ? `: ${stderr}` : ""}`);
  }
  return {
    exitCode: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function runAdapterOperation({ operation, dryRun, commandRunner }) {
  if (dryRun) {
    return {
      ...operation,
      status: "planned",
      executed: false,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }
  try {
    const commandResult = commandRunner(operation);
    const exitCode = commandResult?.exitCode ?? 0;
    return {
      ...operation,
      status: exitCode === 0 ? "applied" : "failed",
      executed: true,
      exitCode,
      stdout: commandResult?.stdout || "",
      stderr: commandResult?.stderr || "",
    };
  } catch (error) {
    return {
      ...operation,
      status: "failed",
      executed: true,
      exitCode: null,
      stdout: "",
      stderr: String(error.message || error),
    };
  }
}

function runAdapterOperations({ operations, dryRun, commandRunner }) {
  const results = [];
  for (const operation of operations) {
    const result = runAdapterOperation({ operation, dryRun, commandRunner });
    results.push(result);
    if (result.status === "failed") {
      break;
    }
  }
  return results;
}

function appliedStatus({ dryRun, operations, noOp = false }) {
  if (noOp) {
    return "no-op";
  }
  if (operations.some((operation) => operation.status === "failed")) {
    return "failed";
  }
  return dryRun ? "planned" : "applied";
}

function isPlaceholderValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "pending" ||
    normalized.startsWith("pending-") ||
    normalized.startsWith("pending_") ||
    normalized.includes("placeholder") ||
    normalized.includes("example.")
  );
}

function assertConcreteAwsDeployConfig({ deployConfig, channel, operation }) {
  const bucket = deployConfig.bucket || deployConfig.target || "";
  const distribution = deployConfig.cloudfront_distribution || deployConfig.distribution || "";
  if (isPlaceholderValue(bucket)) {
    throw new Error(`web-surface ${operation} apply requires concrete deploy.${channel}.bucket or deploy.${channel}.target`);
  }
  if (isPlaceholderValue(distribution)) {
    throw new Error(
      `web-surface ${operation} apply requires concrete deploy.${channel}.cloudfront_distribution or deploy.${channel}.distribution`,
    );
  }
}

function urlHost(value = "") {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function wildcardHostMatches(alias = "", host = "") {
  const normalizedAlias = String(alias || "").toLowerCase();
  const normalizedHost = String(host || "").toLowerCase();
  if (!normalizedAlias.startsWith("*.")) return false;
  const suffix = normalizedAlias.slice(1);
  return normalizedHost.endsWith(suffix) && normalizedHost.slice(0, -suffix.length).indexOf(".") === -1;
}

function aliasMatchesHost(aliases = [], host = "") {
  const normalizedHost = String(host || "").toLowerCase();
  return aliases.some((alias) => {
    const normalizedAlias = String(alias || "").toLowerCase();
    return normalizedAlias === normalizedHost || wildcardHostMatches(normalizedAlias, normalizedHost);
  });
}

function parseCloudFrontAliases(stdout = "") {
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout);
    const aliases = parsed?.Distribution?.DistributionConfig?.Aliases?.Items ||
      parsed?.DistributionConfig?.Aliases?.Items ||
      parsed?.Aliases?.Items ||
      parsed?.Aliases ||
      [];
    return Array.isArray(aliases) ? aliases : [];
  } catch {
    return [];
  }
}

async function defaultDnsResolver(host) {
  try {
    const answers = await dns.resolve(host);
    return answers.map((address) => ({ type: "A", value: address }));
  } catch (error) {
    if (error?.code === "ENODATA" || error?.code === "ENOTFOUND") {
      const answers = await dns.resolve6(host);
      return answers.map((address) => ({ type: "AAAA", value: address }));
    }
    throw error;
  }
}

function preflightCheck({ name, status = "pass", details = {}, message = "" }) {
  return { name, status, message, details };
}

function preflightStatus(checks) {
  return checks.some((check) => check.status === "fail") ? "failed" : "passed";
}

function deployManifestKey(deployConfig, manifest) {
  return joinS3Key(manifestPrefixFor(deployConfig), `${manifest.alias || manifest.channel}.json`);
}

function deploySurfaceManifestKey(deployConfig, binding) {
  const suffix = binding.surface === "default"
    ? `${binding.alias || binding.channel}.json`
    : `${binding.alias || binding.channel}/${binding.surface}.json`;
  return joinS3Key(manifestPrefixFor(deployConfig), suffix);
}

function assertDeployPlan(plan) {
  if (plan?.contract !== "kungfu-buildchain-web-surface-deploy-plan") {
    throw new Error("web-surface deploy apply requires a deploy plan");
  }
  if (!plan.manifest) {
    throw new Error("web-surface deploy plan is missing manifest");
  }
  if (!plan.artifact?.hash) {
    throw new Error("web-surface deploy plan is missing artifact hash");
  }
  if (plan.manifest.artifactHash !== plan.artifact.hash) {
    throw new Error("web-surface deploy plan artifact hash does not match manifest");
  }
  return plan;
}

function verifyDeployPlanArtifact({ cwd, plan }) {
  const artifactPath = plan.artifact.path || ".";
  const actual = createWebSurfaceArtifactHash({ cwd, artifactPath });
  if (actual.artifactHash !== plan.artifact.hash) {
    throw new Error(
      `web-surface deploy plan artifact hash mismatch: expected ${plan.artifact.hash}, got ${actual.artifactHash}`,
    );
  }
  return {
    ...plan,
    artifact: {
      ...plan.artifact,
      path: artifactPath,
      files: actual.files,
    },
  };
}

function assertCleanupPlan(plan) {
  if (plan?.contract !== "kungfu-buildchain-web-surface-cleanup-plan") {
    throw new Error("web-surface cleanup apply requires a cleanup plan");
  }
  if (!Array.isArray(plan.entries)) {
    throw new Error("web-surface cleanup plan is missing entries");
  }
  return plan;
}

function retentionFor({ config, channelName, alias, deployedAt }) {
  if (channelName === "preview") {
    const classified = classifyPreviewAlias(alias);
    const days = retentionConfig(config, "preview")[classified.retentionKey];
    return {
      aliasKind: classified.kind,
      mutableAlias: classified.mutable,
      retentionClass: classified.retentionClass,
      expiresAt: addDays(deployedAt, days),
      retentionDays: days,
    };
  }
  if (channelName === "staging") {
    const retention = retentionConfig(config, "staging");
    return {
      aliasKind: "",
      mutableAlias: true,
      retentionClass: "staging-protected",
      expiresAt: addDays(deployedAt, retention.days),
      retentionDays: retention.days,
      keepDeploys: retention.keep_deploys,
    };
  }
  const retention = retentionConfig(config, "production");
  return {
    aliasKind: "",
    mutableAlias: false,
    retentionClass: "production-canonical",
    expiresAt: addDays(deployedAt, retention.days),
    retentionDays: retention.days,
  };
}

function configuredSurfaces(config) {
  if (config.surfaces && Object.keys(config.surfaces).length > 0) {
    return Object.values(config.surfaces);
  }
  return [{
    name: "default",
    path: "/",
    pathOnly: false,
    canonical: true,
  }];
}

function resolveSurfaceBindings({ config, channelName, alias, deployConfig }) {
  const channel = config.channels?.[channelName];
  if (!channel) {
    throw new Error(`unknown web-surface channel: ${channelName}`);
  }
  return configuredSurfaces(config).map((surface) => {
    const effectiveDeploy = surfaceDeployConfig(deployConfig, surface.name);
    const url = surface.name === "default" && !config.surfaces
      ? resolveChannelUrl(channel, alias)
      : resolveSurfaceUrl({ surface, channel, channelName, alias });
    const objectPrefix = surface.name === "default" && !config.surfaces
      ? objectPrefixFor(deployConfig, alias || channelName)
      : surfaceObjectPrefixFor({ deployConfig, surface, alias: alias || channelName });
    const bucket = effectiveDeploy.bucket || effectiveDeploy.target || "";
    const distributionId = effectiveDeploy.cloudfront_distribution || effectiveDeploy.distribution || "";
    return {
      surface: surface.name,
      channel: channelName,
      alias,
      url,
      sourcePath: normalizeSurfacePath(surface.path),
      artifactPathPrefix: surfaceArtifactPrefix({ sourcePath: surface.path }),
      viewerPathPrefix: "/",
      directoryIndex: "index.html",
      directoryIndexResolution: true,
      canonicalUrl: surface.productionUrl || (channelName === "production" ? url : ""),
      pathOnly: Boolean(surface.pathOnly),
      bucket,
      distributionId,
      originPath: effectiveDeploy.origin_path || effectiveDeploy.originPath || "",
      objectPrefix,
      manifestKey: "",
      noindex: channel.noindex,
      accessControl: channel.accessControl,
    };
  }).map((binding) => ({
    ...binding,
    manifestKey: deploySurfaceManifestKey(deployConfig, binding),
  }));
}

function relativeArtifactPath({ artifactPath, filePath }) {
  const normalizedArtifact = normalizeS3Key(artifactPath);
  const normalizedFile = normalizeS3Key(filePath);
  if (!normalizedArtifact) {
    return normalizedFile;
  }
  return normalizedFile === normalizedArtifact
    ? ""
    : normalizedFile.startsWith(`${normalizedArtifact}/`)
      ? normalizedFile.slice(normalizedArtifact.length + 1)
      : normalizedFile;
}

function requestPathFromArtifactPath({ binding, artifactPath, filePath }) {
  const relative = relativeArtifactPath({ artifactPath, filePath });
  const prefix = normalizeS3Key(binding.artifactPathPrefix || surfaceArtifactPrefix(binding));
  if (prefix && relative !== prefix && !relative.startsWith(`${prefix}/`)) {
    return "";
  }
  const surfaceRelative = prefix
    ? relative.slice(prefix.length).replace(/^\/+/, "")
    : relative;
  if (!surfaceRelative || surfaceRelative === "index.html") {
    return "/";
  }
  if (surfaceRelative.endsWith("/index.html")) {
    const directoryPath = normalizeS3Key(surfaceRelative.slice(0, -"index.html".length));
    return directoryPath ? `/${directoryPath}/` : "/";
  }
  return joinUrlPath(surfaceRelative);
}

function smokeUrlsForBinding({ binding, artifactPath, files }) {
  const rootUrl = urlWithPath(binding.url, "/");
  const candidates = (files || [])
    .map((file) => requestPathFromArtifactPath({ binding, artifactPath, filePath: file.path }))
    .filter(Boolean)
    .filter((requestPath) => requestPath !== "/")
    .filter((requestPath) => requestPath.endsWith("/") || requestPath.endsWith(".html"))
    .sort();
  const nestedPath = candidates[0] || "";
  return [
    {
      kind: "root",
      requestPath: "/",
      url: rootUrl,
      required: true,
    },
    ...(nestedPath
      ? [{
          kind: "nested",
          requestPath: nestedPath,
          url: urlWithPath(binding.url, nestedPath),
          required: true,
        }]
      : []),
  ];
}

function withSurfaceRoutingEvidence(bindings, { artifactPath, files }) {
  return bindings.map((binding) => ({
    ...binding,
    artifactPathPrefix: normalizeS3Key(binding.artifactPathPrefix || surfaceArtifactPrefix(binding)),
    viewerPathPrefix: binding.viewerPathPrefix || "/",
    directoryIndex: binding.directoryIndex || "index.html",
    directoryIndexResolution: binding.directoryIndexResolution !== false,
    routing: {
      contract: "kungfu-buildchain-web-surface-path-prefix-rewrite",
      viewerPathPrefix: binding.viewerPathPrefix || "/",
      artifactPathPrefix: normalizeS3Key(binding.artifactPathPrefix || surfaceArtifactPrefix(binding)),
      objectPrefix: binding.objectPrefix,
      directoryIndex: binding.directoryIndex || "index.html",
      directoryIndexResolution: binding.directoryIndexResolution !== false,
    },
    smokeUrls: smokeUrlsForBinding({ binding, artifactPath, files }),
  }));
}

export function validateWebSurfaceProject(cwd = process.cwd()) {
  const summary = validateBuildchainConfig(cwd, {
    requireConfig: true,
  });
  if (summary.project?.type !== "web-surface") {
    throw new Error('buildchain.toml project.type must be "web-surface"');
  }
  return summary;
}

export function createWebSurfaceArtifactHash({ cwd = process.cwd(), artifactPath = "" } = {}) {
  const root = path.resolve(cwd);
  const files = listFiles(root, artifactPath || ".")
    .sort()
    .map((filePath) => {
      const stat = fs.statSync(filePath);
      const relative = toPosix(path.relative(root, filePath));
      return {
        path: relative,
        size: stat.size,
        sha256: sha256File(filePath),
      };
    });
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return {
    artifactHash: digest.digest("hex"),
    files,
  };
}

export function createWebSurfaceDeploymentManifest({
  cwd = process.cwd(),
  channel = "preview",
  alias = "",
  sourceSha = "",
  artifactHash = "",
  deployedAt = new Date().toISOString(),
  deploymentId = "",
  runtimeId = "",
  configFingerprint = "",
  healthCheck = "",
  migrationState = "",
  rollbackPointer = "",
  rollbackLimitations = "",
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  const channelConfig = config.channels?.[channel];
  if (!channelConfig) {
    throw new Error(`unknown web-surface channel: ${channel}`);
  }
  const deployConfig = config.deploy?.[channel];
  if (!deployConfig) {
    throw new Error(`missing deploy.${channel}`);
  }
  const retention = retentionFor({ config, channelName: channel, alias, deployedAt });
  const surfaceBindings = resolveSurfaceBindings({
    config,
    channelName: channel,
    alias,
    deployConfig,
  });
  const primaryBinding = surfaceBindings[0];
  const timestampPolicy = createSurfaceTimestampPolicy({
    generatedAt: deployedAt,
    publishedAt: deployedAt,
    sourceRevision: sourceSha,
    timestampPolicy: "ci-injected",
    deterministicInputs: [
      "web-surface artifact content",
      "buildchain.toml web-surface channels/deploy/surfaces",
      "sourceSha",
      "artifactHash",
      "deployment channel",
      "deployment alias",
    ],
    timestampFields: ["generatedAt", "publishedAt", "deployedAt"],
    timestampFieldsParticipateInArtifactDigest: false,
    artifactDigestScope: "web-surface artifactHash excludes deployment manifest timestamps",
  });
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deployment",
    ...timestampPolicy,
    site: config.project.site || config.project.name || "",
    channel,
    alias,
    url: primaryBinding.url,
    sourceSha: assertSha(sourceSha, "sourceSha"),
    artifactHash: assertHash(artifactHash, "artifactHash"),
    deployTarget: deployConfig.target || deployConfig.bucket || deployConfig.environment || deployConfig.service || "",
    adapter: deployConfig.adapter,
    deploymentId,
    deployedAt,
    retentionClass: retention.retentionClass,
    expiresAt: retention.expiresAt,
    mutableAlias: retention.mutableAlias,
    accessControl: channelConfig.accessControl,
    edgeAuth: channelConfig.edgeAuth,
    noindex: channelConfig.noindex,
    promotable: channelConfig.promotable,
    canonical: channelConfig.canonical,
    runtimeId,
    configFingerprint,
    secretRefs: [
      ...new Set([
        ...(deployConfig.secretRefs || []),
        ...(config.security?.[channel]?.secretRefs || []),
      ]),
    ],
    healthCheck,
    migrationState,
    rollbackPointer,
    rollbackLimitations,
    surfaceBindings,
  };
}

export function planWebSurfaceDeploy({
  cwd = process.cwd(),
  channel = "preview",
  alias = "",
  sourceSha = "",
  artifactHash = "",
  artifactPath = "",
  runtimeId = "",
  configFingerprint = "",
  rollbackPointer = "",
  rollbackLimitations = "",
  dryRun = true,
  deployedAt = new Date().toISOString(),
} = {}) {
  if (!dryRun) {
    throw new Error("web-surface deploy currently supports dry-run planning only");
  }
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  const deployConfig = config.deploy?.[channel];
  if (!deployConfig) {
    throw new Error(`missing deploy.${channel}`);
  }
  const resolvedArtifact = artifactHash
    ? { artifactHash: assertHash(artifactHash, "artifactHash"), files: [] }
    : createWebSurfaceArtifactHash({
        cwd,
        artifactPath: artifactPath || deployConfig.artifactPath || ".",
      });
  const manifest = createWebSurfaceDeploymentManifest({
    cwd,
    channel,
    alias,
    sourceSha,
    artifactHash: resolvedArtifact.artifactHash,
    runtimeId,
    configFingerprint,
    rollbackPointer,
    rollbackLimitations,
    deployedAt,
  });
  const surfaceBindings = withSurfaceRoutingEvidence(manifest.surfaceBindings, {
    artifactPath: artifactPath || deployConfig.artifactPath || ".",
    files: resolvedArtifact.files,
  });
  manifest.surfaceBindings = surfaceBindings;
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deploy-plan",
    dryRun: true,
    adapter: deployConfig.adapter,
    channel,
    alias,
    url: manifest.url,
    urls: Object.fromEntries(surfaceBindings.map((binding) => [binding.surface, binding.url])),
    artifact: {
      path: artifactPath || deployConfig.artifactPath || ".",
      hash: resolvedArtifact.artifactHash,
      files: resolvedArtifact.files,
    },
    manifest,
    surfaceBindings,
    steps: planAdapterSteps(deployConfig.adapter, deployConfig, manifest),
  };
}

export function applyWebSurfaceDeploy({
  cwd = process.cwd(),
  channel = "preview",
  alias = "",
  sourceSha = "",
  artifactHash = "",
  artifactPath = "",
  plan = null,
  dryRun = true,
  actor = "",
  runId = "",
  appliedAt = new Date().toISOString(),
  commandRunner = defaultCommandRunner,
} = {}) {
  const resolvedPlan = plan
    ? verifyDeployPlanArtifact({ cwd, plan: assertDeployPlan(plan) })
    : planWebSurfaceDeploy({
        cwd,
        channel,
        alias,
        sourceSha,
        artifactHash,
        artifactPath,
        dryRun: true,
        deployedAt: appliedAt,
      });
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  const deployConfig = config.deploy?.[resolvedPlan.channel];
  if (!deployConfig) {
    throw new Error(`missing deploy.${resolvedPlan.channel}`);
  }
  if (resolvedPlan.adapter !== "aws-s3-cloudfront") {
    throw new Error(`web-surface deploy apply does not support adapter: ${resolvedPlan.adapter}`);
  }
  const bucket = deployConfig.bucket || deployConfig.target || "";
  const artifactRoot = path.resolve(cwd, resolvedPlan.artifact.path);
  const bindings = withSurfaceRoutingEvidence(resolvedPlan.manifest.surfaceBindings || [], {
    artifactPath: resolvedPlan.artifact.path,
    files: resolvedPlan.artifact.files || [],
  });
  resolvedPlan.manifest.surfaceBindings = bindings;
  if (!dryRun) {
    for (const binding of bindings) {
      assertConcreteAwsDeployConfig({
        deployConfig: surfaceDeployConfig(deployConfig, binding.surface),
        channel: `${resolvedPlan.channel}.surfaces.${binding.surface}`,
        operation: "deploy",
      });
    }
  }
  const operations = bindings.flatMap((binding) => deployBindingOperations({
    artifactRoot,
    deployConfig,
    manifest: resolvedPlan.manifest,
    binding,
  }));
  const primaryBinding = bindings[0] || {};
  const objectPrefix = primaryBinding.objectPrefix || objectPrefixFor(deployConfig, resolvedPlan.manifest.alias || resolvedPlan.manifest.channel);
  const manifestKey = primaryBinding.manifestKey || deployManifestKey(deployConfig, resolvedPlan.manifest);
  const invalidationPaths = bindings.flatMap((binding) => [viewerWildcardPath(binding), cdnPath(binding.manifestKey)]);
  const operationResults = runAdapterOperations({ operations, dryRun, commandRunner });
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deploy-apply",
    dryRun,
    applyMode: dryRun ? "dry-run" : "apply",
    status: appliedStatus({ dryRun, operations: operationResults }),
    actor,
    runId,
    appliedAt,
    channel: resolvedPlan.channel,
    alias: resolvedPlan.alias,
    url: resolvedPlan.url,
    urls: resolvedPlan.urls || Object.fromEntries(bindings.map((binding) => [binding.surface, binding.url])),
    sourceSha: resolvedPlan.manifest.sourceSha,
    artifactHash: resolvedPlan.artifact.hash,
    adapter: resolvedPlan.adapter,
    target: bucket,
    objectPrefix,
    manifestKey,
    invalidationPaths,
    manifest: resolvedPlan.manifest,
    surfaceBindings: bindings,
    operations: operationResults,
  };
}

export async function preflightWebSurfaceProduction({
  cwd = process.cwd(),
  plan = null,
  execute = false,
  commandRunner = defaultCommandRunner,
  dnsResolver = defaultDnsResolver,
  checkedAt = new Date().toISOString(),
} = {}) {
  const resolvedPlan = plan ? assertDeployPlan(plan) : planWebSurfaceDeploy({
    cwd,
    channel: "production",
    sourceSha: "0".repeat(40),
    artifactHash: "0".repeat(64),
    dryRun: true,
    deployedAt: checkedAt,
  });
  if (resolvedPlan.channel !== "production") {
    throw new Error("web-surface production preflight requires a production deploy plan");
  }
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  const channel = config.channels?.production || {};
  const deployConfig = config.deploy?.production;
  if (!deployConfig) {
    throw new Error("missing deploy.production");
  }
  const checks = [];
  const configuredProductionBindings = resolveSurfaceBindings({
    config,
    channelName: "production",
    alias: "",
    deployConfig,
  });
  const bindings = resolvedPlan.manifest?.surfaceBindings || resolveSurfaceBindings({
    config,
    channelName: "production",
    alias: "",
    deployConfig,
  });

  checks.push(preflightCheck({
    name: "production-channel",
    status: channel.canonical === true && channel.noindex === false ? "pass" : "fail",
    details: {
      canonical: channel.canonical,
      noindex: channel.noindex,
    },
    message: channel.canonical === true && channel.noindex === false
      ? "production channel is canonical and indexable"
      : "channels.production must be canonical=true and noindex=false",
  }));

  const configuredSurfaceNames = configuredProductionBindings.map((binding) => binding.surface).sort();
  const plannedSurfaceNames = bindings.map((binding) => binding.surface).sort();
  const missingSurfaces = configuredSurfaceNames.filter((surface) => !plannedSurfaceNames.includes(surface));
  const extraSurfaces = plannedSurfaceNames.filter((surface) => !configuredSurfaceNames.includes(surface));
  checks.push(preflightCheck({
    name: "production-surface-set",
    status: missingSurfaces.length === 0 && extraSurfaces.length === 0 ? "pass" : "fail",
    details: {
      configured: configuredSurfaceNames,
      planned: plannedSurfaceNames,
      missing: missingSurfaces,
      extra: extraSurfaces,
    },
    message: missingSurfaces.length === 0 && extraSurfaces.length === 0
      ? "production plan covers every configured surface"
      : `production plan surface mismatch: missing=${missingSurfaces.join(",") || "-"} extra=${extraSurfaces.join(",") || "-"}`,
  }));

  const concreteFailures = [];
  for (const binding of bindings) {
    const effectiveDeploy = surfaceDeployConfig(deployConfig, binding.surface);
    try {
      assertConcreteAwsDeployConfig({
        deployConfig: effectiveDeploy,
        channel: `production.surfaces.${binding.surface}`,
        operation: "deploy",
      });
    } catch (error) {
      concreteFailures.push(String(error.message || error));
    }
  }
  checks.push(preflightCheck({
    name: "production-targets",
    status: concreteFailures.length === 0 ? "pass" : "fail",
    details: {
      bindings: bindings.map((binding) => ({
        surface: binding.surface,
        bucket: binding.bucket,
        distributionId: binding.distributionId,
        objectPrefix: binding.objectPrefix,
        manifestKey: binding.manifestKey,
      })),
      failures: concreteFailures,
    },
    message: concreteFailures.length === 0
      ? "production bucket and CloudFront distribution values are concrete"
      : concreteFailures.join("; "),
  }));

  const hosts = bindings.map((binding) => ({
    surface: binding.surface,
    url: binding.url,
    host: urlHost(binding.url),
    distributionId: binding.distributionId,
  }));
  const invalidHosts = hosts.filter((entry) => !entry.host || !entry.url.startsWith("https://"));
  checks.push(preflightCheck({
    name: "production-surface-hosts",
    status: invalidHosts.length === 0 ? "pass" : "fail",
    details: { hosts, invalidHosts },
    message: invalidHosts.length === 0
      ? "all production surfaces declare HTTPS hosts"
      : `invalid production surface hosts: ${invalidHosts.map((entry) => entry.surface).join(", ")}`,
  }));

  const awsResults = [];
  if (execute) {
    const checkedBuckets = new Set();
    for (const binding of bindings) {
      const effectiveDeploy = surfaceDeployConfig(deployConfig, binding.surface);
      const bucket = binding.bucket || effectiveDeploy.bucket || effectiveDeploy.target || "";
      if (bucket && !checkedBuckets.has(bucket)) {
        checkedBuckets.add(bucket);
        const operation = {
          action: "preflight-head-bucket",
          surface: binding.surface,
          command: "aws",
          args: ["s3api", "head-bucket", "--bucket", bucket],
        };
        awsResults.push(runAdapterOperation({ operation, dryRun: false, commandRunner }));
      }
    }

    const checkedDistributions = new Set();
    for (const binding of bindings) {
      const distributionId = binding.distributionId || "";
      if (distributionId && !checkedDistributions.has(distributionId)) {
        checkedDistributions.add(distributionId);
        const operation = {
          action: "preflight-get-distribution",
          surface: binding.surface,
          command: "aws",
          args: ["cloudfront", "get-distribution", "--id", distributionId, "--output", "json"],
        };
        awsResults.push(runAdapterOperation({ operation, dryRun: false, commandRunner }));
      }
    }
  }

  const failedAws = awsResults.filter((result) => result.status === "failed");
  checks.push(preflightCheck({
    name: "production-aws-access",
    status: !execute || failedAws.length === 0 ? "pass" : "fail",
    details: {
      execute,
      operations: awsResults.map((result) => ({
        action: result.action,
        surface: result.surface,
        status: result.status,
        stderr: result.stderr,
      })),
    },
    message: !execute
      ? "AWS access check planned but not executed"
      : failedAws.length === 0
        ? "production role can inspect buckets and CloudFront distributions"
        : `production AWS access failed: ${failedAws.map((result) => `${result.action}:${result.surface}`).join(", ")}`,
  }));

  const aliasChecks = [];
  if (execute) {
    const aliasesByDistribution = new Map();
    for (const result of awsResults.filter((entry) => entry.action === "preflight-get-distribution" && entry.status !== "failed")) {
      const aliases = parseCloudFrontAliases(result.stdout);
      aliasesByDistribution.set(result.args[result.args.indexOf("--id") + 1], aliases);
    }
    for (const host of hosts) {
      const aliases = aliasesByDistribution.get(host.distributionId) || [];
      aliasChecks.push({
        ...host,
        aliases,
        matched: aliasMatchesHost(aliases, host.host),
      });
    }
  }
  const missingAliases = aliasChecks.filter((entry) => !entry.matched);
  checks.push(preflightCheck({
    name: "production-cloudfront-aliases",
    status: !execute || missingAliases.length === 0 ? "pass" : "fail",
    details: {
      execute,
      aliases: aliasChecks,
    },
    message: !execute
      ? "CloudFront alias check planned but not executed"
      : missingAliases.length === 0
        ? "production CloudFront aliases cover every surface host"
        : `missing CloudFront aliases: ${missingAliases.map((entry) => entry.host).join(", ")}`,
  }));

  const dnsChecks = [];
  if (execute) {
    for (const host of hosts) {
      try {
        const answers = await dnsResolver(host.host);
        dnsChecks.push({ ...host, status: "pass", answers });
      } catch (error) {
        dnsChecks.push({ ...host, status: "fail", error: String(error.message || error) });
      }
    }
  }
  const failedDns = dnsChecks.filter((entry) => entry.status === "fail");
  checks.push(preflightCheck({
    name: "production-dns",
    status: !execute || failedDns.length === 0 ? "pass" : "fail",
    details: {
      execute,
      hosts: dnsChecks,
    },
    message: !execute
      ? "DNS check planned but not executed"
      : failedDns.length === 0
        ? "production DNS resolves for every surface host"
        : `production DNS failed: ${failedDns.map((entry) => entry.host).join(", ")}`,
  }));

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-production-preflight",
    checkedAt,
    execute,
    channel: "production",
    status: preflightStatus(checks),
    url: resolvedPlan.url,
    urls: resolvedPlan.urls,
    sourceSha: resolvedPlan.manifest.sourceSha,
    artifactHash: resolvedPlan.artifact.hash,
    surfaceBindings: bindings,
    checks,
  };
}

function healthStatus(checks) {
  return checks.some((check) => check.status === "fail") ? "failed" : "passed";
}

function noindexHeader(headers) {
  const value = headers?.get?.("x-robots-tag") || "";
  return String(value).toLowerCase().includes("noindex");
}

function noindexMeta(html = "") {
  const source = String(html || "").toLowerCase();
  return /<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/.test(source) ||
    /<meta\s+[^>]*content=["'][^"']*noindex[^"']*["'][^>]*name=["']robots["']/.test(source);
}

function htmlLikeResponse(response, url = "") {
  const contentType = response.headers?.get?.("content-type") || "";
  return String(contentType).toLowerCase().includes("text/html") || /\/$|\.html(?:$|[?#])/.test(String(url || ""));
}

export async function checkWebSurfaceHealth({
  result = null,
  plan = null,
  cwd = process.cwd(),
  fetchImpl = fetch,
  checkedAt = new Date().toISOString(),
  allowedStatuses = [200],
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  const manifest = result?.manifest || plan?.manifest;
  const channel = result?.channel || plan?.channel || manifest?.channel || "production";
  const urls = result?.urls || plan?.urls || (manifest?.surfaceBindings
    ? Object.fromEntries(manifest.surfaceBindings.map((binding) => [binding.surface, binding.url]))
    : {});
  const bindings = manifest?.surfaceBindings || [];
  const checks = [];
  if (Object.keys(urls).length === 0) {
    checks.push({
      surface: "__urls__",
      url: "",
      status: "fail",
      httpStatus: 0,
      finalUrl: "",
      noindexHeader: false,
      message: "web-surface health check requires at least one surface URL from an apply result or deploy plan",
    });
  }

  const smokeTargets = bindings.length > 0
    ? bindings.flatMap((binding) => {
        const smokeUrls = Array.isArray(binding.smokeUrls) && binding.smokeUrls.length > 0
          ? binding.smokeUrls
          : [{ kind: "root", requestPath: "/", url: binding.url || urls[binding.surface] || "", required: true }];
        return smokeUrls.map((smoke) => ({
          surface: binding.surface,
          kind: smoke.kind || "root",
          requestPath: smoke.requestPath || "",
          url: smoke.url || "",
          required: smoke.required !== false,
          missing: Boolean(smoke.missing),
          message: smoke.message || "",
        }));
      })
    : Object.entries(urls).map(([surface, url]) => ({
        surface,
        kind: "root",
        requestPath: "/",
        url,
        required: true,
      }));

  for (const target of smokeTargets) {
    const { surface, url } = target;
    if (!url || target.missing) {
      checks.push({
        surface,
        kind: target.kind,
        requestPath: target.requestPath,
        url: url || "",
        status: "fail",
        httpStatus: 0,
        finalUrl: "",
        noindexHeader: false,
        message: target.message || "web-surface smoke URL is missing",
      });
      continue;
    }
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      const expectedNoindex = Boolean(config.channels?.[channel]?.noindex);
      const headerNoindex = noindexHeader(response.headers);
      const body = htmlLikeResponse(response, url) && typeof response.text === "function"
        ? await response.text()
        : "";
      const metaNoindex = noindexMeta(body);
      const noindex = headerNoindex || metaNoindex;
      const statusOk = allowedStatuses.includes(response.status);
      const noindexOk = channel !== "production" || expectedNoindex || !noindex;
      checks.push({
        surface,
        kind: target.kind,
        requestPath: target.requestPath,
        url,
        status: statusOk && noindexOk ? "pass" : "fail",
        httpStatus: response.status,
        finalUrl: response.url || url,
        noindexHeader: noindex,
        noindexHeaderValue: headerNoindex,
        noindexMeta: metaNoindex,
        message: statusOk && noindexOk
          ? "surface is reachable"
          : `surface health failed: http=${response.status}, noindex=${noindex}`,
      });
    } catch (error) {
      checks.push({
        surface,
        kind: target.kind,
        requestPath: target.requestPath,
        url,
        status: "fail",
        httpStatus: 0,
        finalUrl: "",
        noindexHeader: false,
        message: String(error.message || error),
      });
    }
  }

  const manifestChecks = bindings.map((binding) => ({
    surface: binding.surface,
    manifestKey: binding.manifestKey,
    bucket: binding.bucket,
    distributionId: binding.distributionId,
    status: binding.manifestKey ? "pass" : "fail",
  }));
  checks.push({
    surface: "__manifest__",
    url: "",
    status: manifestChecks.length > 0 && manifestChecks.every((entry) => entry.status === "pass") ? "pass" : "fail",
    manifests: manifestChecks,
    message: "deployment manifest pointers are recorded for every surface",
  });

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-health-check",
    checkedAt,
    channel,
    status: healthStatus(checks),
    sourceSha: manifest?.sourceSha || result?.sourceSha || "",
    artifactHash: manifest?.artifactHash || result?.artifactHash || "",
    urls,
    checks,
  };
}

function deployBindingOperations({ artifactRoot, deployConfig, manifest, binding }) {
  const effectiveDeploy = surfaceDeployConfig(deployConfig, binding.surface);
  const bucket = binding.bucket || effectiveDeploy.bucket || effectiveDeploy.target || "";
  const distribution = binding.distributionId || effectiveDeploy.cloudfront_distribution || effectiveDeploy.distribution || "";
  const surfaceArtifactRoot = surfaceArtifactRootFor({ artifactRoot, binding });
  const operations = [
    {
      action: "sync-static-artifact",
      surface: binding.surface,
      command: "aws",
      args: syncStaticArtifactArgs({ artifactRoot: surfaceArtifactRoot, bucket, objectPrefix: binding.objectPrefix }),
      routing: binding.routing,
    },
    ...directoryIndexAliasOperations({ surfaceArtifactRoot, bucket, binding }),
    {
      action: "write-deployment-manifest",
      surface: binding.surface,
      command: "aws",
      args: ["s3", "cp", "-", s3Uri(bucket, binding.manifestKey), "--content-type", "application/json"],
      stdin: `${JSON.stringify({
        ...manifest,
        surface: binding.surface,
        url: binding.url,
        surfaceBinding: binding,
      }, null, 2)}\n`,
    },
  ];
  if (distribution) {
    operations.push({
      action: "invalidate-cdn",
      surface: binding.surface,
      command: "aws",
      args: [
        "cloudfront",
        "create-invalidation",
        "--distribution-id",
        distribution,
        "--paths",
        viewerWildcardPath(binding),
        cdnPath(binding.manifestKey),
      ],
    });
  }
  return operations;
}

function planAdapterSteps(adapter, deployConfig, manifest) {
  if (adapter === "aws-s3-cloudfront") {
    return [
      ...manifest.surfaceBindings.flatMap((binding) => [
        {
          action: "sync-static-artifact",
          surface: binding.surface,
          target: binding.bucket,
          prefix: binding.objectPrefix,
        },
        {
          action: "write-deployment-manifest",
          surface: binding.surface,
          target: manifestPrefixFor(deployConfig),
          key: binding.manifestKey,
        },
        {
          action: "invalidate-cdn",
          surface: binding.surface,
          distribution: binding.distributionId,
        },
      ]),
    ];
  }
  return [
    {
      action: "prepare-dynamic-environment",
      target: manifest.deployTarget,
    },
    {
      action: "write-deployment-manifest",
      target: manifestPrefixFor(deployConfig),
    },
  ];
}

export function planWebSurfaceCleanup({
  cwd = process.cwd(),
  aliases = [],
  channel = "preview",
  now = new Date().toISOString(),
  event = "manual",
  sourceSha = "",
  pullNumber = "",
  actor = "",
  runId = "",
  dryRun = true,
} = {}) {
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  if (channel !== "preview") {
    throw new Error("web-surface cleanup currently supports preview aliases only");
  }
  const deployConfig = config.deploy?.[channel];
  if (!deployConfig) {
    throw new Error(`missing deploy.${channel}`);
  }
  const requestedAliases = [...aliases];
  if (requestedAliases.length === 0 && pullNumber) {
    requestedAliases.push(`pr-${pullNumber}`);
  }
  const manifestPrefix = manifestPrefixFor(deployConfig);
  const bindingsByAlias = new Map(requestedAliases.map((alias) => [
    alias,
    resolveSurfaceBindings({ config, channelName: channel, alias, deployConfig }),
  ]));
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-cleanup-plan",
    dryRun,
    applyMode: dryRun ? "dry-run" : "apply",
    event,
    channel,
    now,
    sourceSha: sourceSha ? assertSha(sourceSha, "sourceSha") : "",
    pullNumber: pullNumber ? String(pullNumber) : "",
    actor,
    runId,
    status: requestedAliases.length === 0 ? "no-op" : "planned",
    adapter: deployConfig.adapter,
    target: deployConfig.bucket || deployConfig.target || "",
    manifestPrefix,
    secretRefs: [...new Set([...(deployConfig.secretRefs || [])])],
    entries: requestedAliases.map((alias) => {
      const classified = classifyPreviewAlias(alias);
      const retention = retentionConfig(config, "preview");
      const surfaceBindings = bindingsByAlias.get(alias) || [];
      const primaryBinding = surfaceBindings[0] || {};
      const objectPrefix = primaryBinding.objectPrefix || objectPrefixFor(deployConfig, alias);
      return {
        alias,
        aliasKind: classified.kind,
        mutableAlias: classified.mutable,
        retentionClass: classified.retentionClass,
        retentionDays: retention[classified.retentionKey],
        action: "delete-preview-alias",
        objectPrefix,
        manifestKey: primaryBinding.manifestKey || `${manifestPrefix.replace(/\/$/, "")}/${alias}.json`,
        surfaceBindings,
        steps: cleanupAdapterSteps(deployConfig.adapter, deployConfig, {
          alias,
          objectPrefix,
          manifestPrefix,
          surfaceBindings,
        }),
      };
    }),
  };
}

export function applyWebSurfaceCleanup({
  cwd = process.cwd(),
  aliases = [],
  channel = "preview",
  now = new Date().toISOString(),
  event = "manual",
  sourceSha = "",
  pullNumber = "",
  actor = "",
  runId = "",
  plan = null,
  dryRun = true,
  commandRunner = defaultCommandRunner,
} = {}) {
  const cleanup = plan
    ? assertCleanupPlan(plan)
    : planWebSurfaceCleanup({
        cwd,
        aliases,
        channel,
        now,
        event,
        sourceSha,
        pullNumber,
        actor,
        runId,
        dryRun,
      });
  const loadedConfig = loadBuildchainConfig(cwd);
  const config = assertWebSurfaceConfig(loadedConfig);
  const deployConfig = config.deploy?.[cleanup.channel];
  if (!deployConfig) {
    throw new Error(`missing deploy.${cleanup.channel}`);
  }
  if (cleanup.adapter !== "aws-s3-cloudfront") {
    throw new Error(`web-surface cleanup apply does not support adapter: ${cleanup.adapter}`);
  }
  if (!dryRun) {
    for (const entry of cleanup.entries) {
      const bindings = entry.surfaceBindings?.length
        ? entry.surfaceBindings
        : [{
            surface: "default",
          }];
      for (const binding of bindings) {
        assertConcreteAwsDeployConfig({
          deployConfig: surfaceDeployConfig(deployConfig, binding.surface),
          channel: `${cleanup.channel}.surfaces.${binding.surface}`,
          operation: "cleanup",
        });
      }
    }
  }
  const bucket = deployConfig.bucket || deployConfig.target || "";
  const operations = cleanup.entries.flatMap((entry) => cleanupEntryOperations({ deployConfig, entry, bucket }));
  const operationResults = runAdapterOperations({ operations, dryRun, commandRunner });
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-cleanup-apply",
    dryRun,
    applyMode: dryRun ? "dry-run" : "apply",
    status: appliedStatus({ dryRun, operations: operationResults, noOp: cleanup.status === "no-op" }),
    event,
    channel,
    now,
    sourceSha: cleanup.sourceSha,
    pullNumber: cleanup.pullNumber,
    actor,
    runId,
    adapter: cleanup.adapter,
    target: bucket,
    manifestPrefix: cleanup.manifestPrefix,
    entries: cleanup.entries,
    operations: operationResults,
  };
}

function cleanupEntryOperations({ deployConfig, entry, bucket }) {
  const bindings = entry.surfaceBindings?.length
    ? entry.surfaceBindings
    : [{
        surface: "default",
        objectPrefix: entry.objectPrefix,
        manifestKey: entry.manifestKey,
        bucket,
        distributionId: deployConfig.cloudfront_distribution || deployConfig.distribution || "",
      }];
  return bindings.flatMap((binding) => {
    const effectiveDeploy = surfaceDeployConfig(deployConfig, binding.surface);
    const bindingBucket = binding.bucket || effectiveDeploy.bucket || effectiveDeploy.target || bucket;
    const distribution = binding.distributionId || effectiveDeploy.cloudfront_distribution || effectiveDeploy.distribution || "";
    const entryOperations = [
      {
        action: "delete-static-prefix",
        alias: entry.alias,
        surface: binding.surface,
        command: "aws",
        args: ["s3", "rm", s3Uri(bindingBucket, binding.objectPrefix), "--recursive"],
      },
      {
        action: "delete-deployment-manifest",
        alias: entry.alias,
        surface: binding.surface,
        command: "aws",
        args: ["s3", "rm", s3Uri(bindingBucket, binding.manifestKey)],
      },
    ];
    if (distribution) {
      entryOperations.push({
        action: "invalidate-cdn",
        alias: entry.alias,
        surface: binding.surface,
        command: "aws",
        args: [
          "cloudfront",
          "create-invalidation",
          "--distribution-id",
          distribution,
          "--paths",
          viewerWildcardPath(binding),
          cdnPath(binding.manifestKey),
        ],
      });
    }
    return entryOperations;
  });
}

function cleanupAdapterSteps(adapter, deployConfig, entry) {
  if (adapter === "aws-s3-cloudfront") {
    const bindings = entry.surfaceBindings?.length
      ? entry.surfaceBindings
      : [{
          surface: "default",
          objectPrefix: entry.objectPrefix,
          manifestKey: `${entry.manifestPrefix.replace(/\/$/, "")}/${entry.alias}.json`,
          bucket: deployConfig.bucket || deployConfig.target || "",
          distributionId: deployConfig.cloudfront_distribution || deployConfig.distribution || "",
        }];
    return bindings.flatMap((binding) => [
        {
          action: "delete-static-prefix",
          surface: binding.surface,
          target: binding.bucket,
          prefix: binding.objectPrefix,
        },
        {
          action: "delete-deployment-manifest",
          surface: binding.surface,
          target: entry.manifestPrefix,
          key: binding.manifestKey,
        },
        {
          action: "invalidate-cdn",
          surface: binding.surface,
          distribution: binding.distributionId,
        },
      ]);
  }
  return [
    {
      action: "delete-preview-environment",
      target: deployConfig.environment || deployConfig.service || deployConfig.target || "",
      alias: entry.alias,
    },
    {
      action: "delete-deployment-manifest",
      target: entry.manifestPrefix,
      key: `${entry.manifestPrefix.replace(/\/$/, "")}/${entry.alias}.json`,
    },
  ];
}

export function defaultWebSurfaceAlias({ channel = "preview", sourceSha = "", pullNumber = "" } = {}) {
  if (channel !== "preview") {
    return "";
  }
  if (pullNumber) {
    return `pr-${pullNumber}`;
  }
  const sha = assertSha(sourceSha, "sourceSha");
  return `sha-${sha.slice(0, 12)}`;
}

export function localWebSurfaceContext() {
  return {
    sourceSha: process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "",
    sourceRef: process.env.BUILDCHAIN_SOURCE_REF || process.env.GITHUB_REF || "",
    repository: process.env.GITHUB_REPOSITORY || "",
    runId: process.env.GITHUB_RUN_ID || "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    runner: {
      os: process.env.RUNNER_OS || os.platform(),
      arch: process.env.RUNNER_ARCH || os.arch(),
    },
  };
}

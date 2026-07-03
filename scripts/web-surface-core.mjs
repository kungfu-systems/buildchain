import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBuildchainConfig, validateBuildchainConfig } from "../packages/core/buildchain-config.js";

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

function syncStaticArtifactArgs({ artifactRoot, bucket, objectPrefix }) {
  const args = ["s3", "sync", artifactRoot, s3Uri(bucket, objectPrefix), "--delete"];
  if (!objectPrefix) {
    args.push("--exclude", ".buildchain/*");
  }
  return args;
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
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deployment",
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
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deploy-plan",
    dryRun: true,
    adapter: deployConfig.adapter,
    channel,
    alias,
    url: manifest.url,
    urls: Object.fromEntries(manifest.surfaceBindings.map((binding) => [binding.surface, binding.url])),
    artifact: {
      path: artifactPath || deployConfig.artifactPath || ".",
      hash: resolvedArtifact.artifactHash,
      files: resolvedArtifact.files,
    },
    manifest,
    surfaceBindings: manifest.surfaceBindings,
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
  const bindings = resolvedPlan.manifest.surfaceBindings || [];
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
  const invalidationPaths = bindings.flatMap((binding) => [cdnWildcardPath(binding.objectPrefix), cdnPath(binding.manifestKey)]);
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

function deployBindingOperations({ artifactRoot, deployConfig, manifest, binding }) {
  const effectiveDeploy = surfaceDeployConfig(deployConfig, binding.surface);
  const bucket = binding.bucket || effectiveDeploy.bucket || effectiveDeploy.target || "";
  const distribution = binding.distributionId || effectiveDeploy.cloudfront_distribution || effectiveDeploy.distribution || "";
  const operations = [
    {
      action: "sync-static-artifact",
      surface: binding.surface,
      command: "aws",
      args: syncStaticArtifactArgs({ artifactRoot, bucket, objectPrefix: binding.objectPrefix }),
    },
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
        cdnWildcardPath(binding.objectPrefix),
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
          `${cdnPath(binding.objectPrefix)}/*`,
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

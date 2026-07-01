import crypto from "node:crypto";
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

function manifestPrefixFor(deployConfig) {
  return deployConfig.manifest_prefix || ".buildchain/deployments";
}

function objectPrefixFor(deployConfig, alias) {
  return deployConfig.prefix || alias || "preview";
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
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-deployment",
    site: config.project.site || config.project.name || "",
    channel,
    alias,
    url: resolveChannelUrl(channelConfig, alias),
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
  };
}

export function planWebSurfaceDeploy({
  cwd = process.cwd(),
  channel = "preview",
  alias = "",
  sourceSha = "",
  artifactHash = "",
  artifactPath = "",
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
    artifact: {
      path: artifactPath || deployConfig.artifactPath || ".",
      hash: resolvedArtifact.artifactHash,
      files: resolvedArtifact.files,
    },
    manifest,
    steps: planAdapterSteps(deployConfig.adapter, deployConfig, manifest),
  };
}

function planAdapterSteps(adapter, deployConfig, manifest) {
  if (adapter === "aws-s3-cloudfront") {
    return [
      {
        action: "sync-static-artifact",
        target: deployConfig.bucket || deployConfig.target || "",
        prefix: objectPrefixFor(deployConfig, manifest.alias || manifest.channel),
      },
      {
        action: "write-deployment-manifest",
        target: manifestPrefixFor(deployConfig),
      },
      {
        action: "invalidate-cdn",
        distribution: deployConfig.cloudfront_distribution || deployConfig.distribution || "",
      },
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
      const objectPrefix = objectPrefixFor(deployConfig, alias);
      return {
        alias,
        aliasKind: classified.kind,
        mutableAlias: classified.mutable,
        retentionClass: classified.retentionClass,
        retentionDays: retention[classified.retentionKey],
        action: "delete-preview-alias",
        objectPrefix,
        manifestKey: `${manifestPrefix.replace(/\/$/, "")}/${alias}.json`,
        steps: cleanupAdapterSteps(deployConfig.adapter, deployConfig, {
          alias,
          objectPrefix,
          manifestPrefix,
        }),
      };
    }),
  };
}

function cleanupAdapterSteps(adapter, deployConfig, entry) {
  if (adapter === "aws-s3-cloudfront") {
    return [
      {
        action: "delete-static-prefix",
        target: deployConfig.bucket || deployConfig.target || "",
        prefix: entry.objectPrefix,
      },
      {
        action: "delete-deployment-manifest",
        target: entry.manifestPrefix,
        key: `${entry.manifestPrefix.replace(/\/$/, "")}/${entry.alias}.json`,
      },
      {
        action: "invalidate-cdn",
        distribution: deployConfig.cloudfront_distribution || deployConfig.distribution || "",
      },
    ];
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

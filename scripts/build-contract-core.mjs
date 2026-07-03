import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNNER_PRESETS = Object.freeze({
  "github-hosted": [
    { id: "linux-x64", name: "Linux x64", runner: '["ubuntu-24.04"]' },
    { id: "macos", name: "macOS", runner: '["macos-latest"]' },
    { id: "windows-x64", name: "Windows x64", runner: '["windows-2022"]' },
  ],
  "kungfu-v4-self-hosted": [
    {
      id: "linux-x64",
      name: "Linux x64",
      runner: '["self-hosted","Linux","X64","kungfu-build-v4-linux-x64"]',
    },
    {
      id: "macos-arm64",
      name: "macOS ARM64",
      runner: '["self-hosted","macOS","ARM64","kungfu-build-v4-macos-arm64"]',
    },
    {
      id: "windows-x64",
      name: "Windows x64",
      runner: '["self-hosted","Windows","X64","kungfu-build-v4-windows-x64"]',
    },
  ],
});

export const LINUX_CONTAINER_PRESETS = Object.freeze({
  "kungfu-verify": {
    image:
      "ghcr.io/kungfu-systems/build-images/kungfu-verify@sha256:11f0ba64267ce88174a4f73a9bf833ff4e9c59cd16ec3d08a6432a06c2be6fb1",
  },
});

const RUNNER_PRESET_ALIASES = Object.freeze({
  github: "github-hosted",
  "github-hosted-default": "github-hosted",
  kungfu: "kungfu-v4-self-hosted",
  "kungfu-self-hosted": "kungfu-v4-self-hosted",
  "kungfu-v4": "kungfu-v4-self-hosted",
});

const LINUX_CONTAINER_PRESET_ALIASES = Object.freeze({
  "": "",
  none: "",
  off: "",
  false: "",
  verify: "kungfu-verify",
});

export const DEFAULT_ARTIFACT_NAME_TEMPLATE = "{artifact}-{platform}-{sha}";
export const DEFAULT_PUBLISH_REFS = Object.freeze({
  alpha: [
    "^refs/heads/alpha/v\\d+/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+\\.\\d+-alpha\\.\\d+$",
    "^refs/heads/publish-gate/alpha/.+/.+$",
  ],
  release: [
    "^refs/heads/release/v\\d+/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+\\.\\d+$",
    "^refs/tags/v\\d+\\.\\d+$",
    "^refs/tags/v\\d+$",
    "^refs/heads/publish-gate/release/.+/.+$",
  ],
  anchor: ["^refs/heads/publish-gate/anchor$"],
  major: [
    "^refs/heads/publish-gate/major$",
    "^refs/heads/major-gate$",
    "^refs/tags/v\\d+\\.0\\.0$",
    "^refs/tags/v\\d+\\.0$",
    "^refs/tags/v\\d+$",
  ],
});

function parseJsonObject(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function getByDottedKey(target, key) {
  return String(key)
    .split(".")
    .reduce((current, segment) => current?.[segment], target);
}

function assertSha(sha, label = "sourceSha") {
  const value = String(sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return value;
}

function normalizeGitRefName(value = "") {
  return String(value || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function normalizeGitFullRef(value = "") {
  const ref = String(value || "").trim();
  if (!ref) {
    return "";
  }
  if (ref.startsWith("refs/")) {
    return ref;
  }
  if (/^v\d/.test(ref)) {
    return `refs/tags/${ref}`;
  }
  return `refs/heads/${ref}`;
}

export function parsePublishSourceRef(value = "") {
  const sourceRef = normalizeGitRefName(value);
  if (!sourceRef) {
    return {
      sourceRef: "",
      fullRef: "",
      enabled: false,
      channel: "none",
      line: "",
      consumerVersion: "",
      anchor: false,
      legacyAlias: false,
    };
  }
  if (sourceRef === "publish-gate/anchor") {
    return {
      sourceRef,
      fullRef: "refs/heads/publish-gate/anchor",
      enabled: true,
      channel: "anchor",
      line: "",
      consumerVersion: "",
      anchor: true,
      legacyAlias: false,
    };
  }
  if (sourceRef === "publish-gate/major" || sourceRef === "major-gate") {
    return {
      sourceRef,
      fullRef:
        sourceRef === "major-gate"
          ? "refs/heads/major-gate"
          : "refs/heads/publish-gate/major",
      enabled: true,
      channel: "major",
      line: "",
      consumerVersion: "",
      anchor: false,
      legacyAlias: sourceRef === "major-gate",
    };
  }
  const match = sourceRef.match(
    /^publish-gate\/(alpha|release)\/(.+)\/([^/]+)$/,
  );
  if (!match) {
    throw new Error(
      `unsupported publish source ref: ${sourceRef}; expected publish-gate/alpha/<line>/<version>, publish-gate/release/<line>/<version>, publish-gate/anchor, publish-gate/major, or major-gate`,
    );
  }
  const [, channel, line, consumerVersion] = match;
  if (!line.includes("/")) {
    throw new Error(
      `publish source line must include a major/minor path: ${sourceRef}`,
    );
  }
  if (!/^[A-Za-z0-9._+~-]+$/.test(consumerVersion)) {
    throw new Error(
      `publish source consumer version contains unsupported characters: ${consumerVersion}`,
    );
  }
  return {
    sourceRef,
    fullRef: `refs/heads/${sourceRef}`,
    enabled: true,
    channel,
    line,
    consumerVersion,
    anchor: false,
    legacyAlias: false,
  };
}

export function resolvePublishSourceLock({
  publishSourceRef = "",
  publishSourceSha = "",
  fallbackRef = "",
  fallbackSha = "",
} = {}) {
  const parsed = parsePublishSourceRef(publishSourceRef);
  if (!parsed.enabled) {
    return {
      ...parsed,
      sourceRef: "",
      fullRef: "",
      fallbackRef: normalizeGitRefName(fallbackRef),
      fallbackFullRef: normalizeGitFullRef(fallbackRef),
      sourceSha: fallbackSha ? assertSha(fallbackSha, "fallbackSha") : "",
      sourceLocked: false,
      sourceReason: "publish source ref is not configured",
    };
  }
  return {
    ...parsed,
    sourceSha: assertSha(publishSourceSha),
    sourceLocked: true,
    sourceReason: `locked ${parsed.sourceRef} at ${publishSourceSha}`,
  };
}

function versionValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return getByDottedKey(file.content, file.key);
  }
  const match = file.source.match(file.pattern);
  return match?.groups?.version;
}

export async function createResolvedReleaseManifest({
  cwd = process.cwd(),
  repository = "",
  sourceRef = "",
  sourceSha = "",
  anchorRequestJson = "",
  publishRegistry = "https://registry.npmjs.org/",
  distTag = "",
  visibilityGate = "main-package-last",
} = {}) {
  const lock = resolvePublishSourceLock({
    publishSourceRef: sourceRef,
    publishSourceSha: sourceSha,
    fallbackRef: sourceRef,
    fallbackSha: sourceSha,
  });
  const {
    discoverConfiguredVersionStateFiles,
    getVersionStrategy,
    loadBuildchainConfig,
    loadConfiguredAnchorManifest,
  } = await import("../packages/core/buildchain-config.js");
  const loadedConfig = loadBuildchainConfig(cwd);
  const versionStrategy = getVersionStrategy(loadedConfig);
  const versionFiles = loadedConfig?.config?.version
    ? discoverConfiguredVersionStateFiles(cwd, loadedConfig)
    : [];
  const resolvedVersionFiles = versionFiles.map((file) => ({
    path: file.path,
    type: file.type,
    key: file.key,
    version: versionValue(file),
  }));
  if (lock.consumerVersion) {
    if (resolvedVersionFiles.length === 0) {
      throw new Error(
        "publish source consumer version requires configured version.files",
      );
    }
    for (const file of resolvedVersionFiles) {
      if (file.version !== lock.consumerVersion) {
        throw new Error(
          `publish source version mismatch: ${file.path} has ${file.version}, expected ${lock.consumerVersion}`,
        );
      }
    }
  }

  const anchorManifest = loadConfiguredAnchorManifest(cwd, loadedConfig);
  if (
    lock.consumerVersion &&
    anchorManifest?.fields?.npmVersion &&
    anchorManifest.fields.npmVersion !== lock.consumerVersion
  ) {
    throw new Error(
      `anchor manifest npmVersion ${anchorManifest.fields.npmVersion} does not match ${lock.consumerVersion}`,
    );
  }
  const anchorRequest = anchorRequestJson.trim()
    ? parseJsonObject(anchorRequestJson, "publish-anchor-request-json")
    : undefined;
  if (lock.channel === "anchor" && !anchorRequest) {
    throw new Error("publish-gate/anchor requires publish-anchor-request-json");
  }

  return {
    schema: 1,
    sourceRef: lock.sourceRef,
    sourceSha: lock.sourceSha,
    sourceLocked: lock.sourceLocked,
    channel: lock.channel,
    line: lock.line,
    consumerVersion: lock.consumerVersion,
    repository,
    versionStrategy: versionStrategy.strategy,
    versionNext: versionStrategy.next,
    versionFiles: resolvedVersionFiles,
    anchorManifest: anchorManifest
      ? {
          path: anchorManifest.path,
          summary: anchorManifest.fields,
        }
      : undefined,
    anchorRequest,
    publish: {
      registry: publishRegistry,
      distTag:
        distTag ||
        (lock.channel === "release"
          ? "latest"
          : lock.channel === "alpha"
            ? "alpha"
            : ""),
      visibilityGate,
    },
  };
}

export function verifyPublishSourceLock({
  sourceRef = "",
  expectedSha = "",
  currentSha = "",
} = {}) {
  const expected = assertSha(expectedSha, "expectedSha");
  const current = assertSha(currentSha, "currentSha");
  if (expected !== current) {
    throw new Error(
      `publish source ref moved: ${sourceRef || "<unknown>"} expected ${expected}, got ${current}`,
    );
  }
  return {
    ok: true,
    sourceRef,
    sourceSha: expected,
  };
}

export function resolvePublishChannelTargetRef({
  sourceRef = "",
  targetRef = "",
} = {}) {
  const requestedTarget = normalizeGitRefName(targetRef);
  if (requestedTarget) {
    return requestedTarget;
  }
  const parsed = parsePublishSourceRef(sourceRef);
  if (!parsed.enabled || parsed.anchor) {
    return "";
  }
  if (parsed.channel === "alpha" || parsed.channel === "release") {
    return `${parsed.channel}/${parsed.line}`;
  }
  if (parsed.channel === "major") {
    return parsed.legacyAlias ? "major-gate" : "publish-gate/major";
  }
  return "";
}

function expectedPublishChannelHeadRef(targetRef) {
  const ref = normalizeGitRefName(targetRef);
  if (ref === "publish-gate/major" || ref === "major-gate") {
    return "release/vN/vN.M";
  }
  const match = ref.match(/^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(
      `publish target channel ref must be alpha/vN/vN.M, release/vN/vN.M, publish-gate/major, or major-gate; got ${ref || "<empty>"}`,
    );
  }
  const [, channel, major, lineMajor, minor] = match;
  if (major !== lineMajor) {
    throw new Error(`publish target channel ref major mismatch: ${ref}`);
  }
  return channel === "alpha"
    ? `dev/v${major}/v${major}.${minor}`
    : `alpha/v${major}/v${major}.${minor}`;
}

function isReleaseLineRef(ref = "") {
  const match = String(ref || "").match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
  return !!match && match[1] === match[2];
}

export function verifyPublishChannelPrLineage({
  sourceRef = "",
  sourceSha = "",
  targetRef = "",
  repository = "",
  pullRequests = [],
} = {}) {
  const parsed = parsePublishSourceRef(sourceRef);
  const resolvedTargetRef = resolvePublishChannelTargetRef({
    sourceRef,
    targetRef,
  });
  if (!parsed.enabled || parsed.anchor || !resolvedTargetRef) {
    return {
      ok: true,
      skipped: true,
      sourceRef: parsed.sourceRef || normalizeGitRefName(sourceRef),
      targetRef: resolvedTargetRef,
      reason: !parsed.enabled
        ? "publish source ref is not configured"
        : parsed.anchor
          ? "publish-gate/anchor has no channel target ref"
          : "publish target channel ref is not configured",
    };
  }
  const sha = assertSha(sourceSha, "sourceSha");
  const expectedHeadRef = expectedPublishChannelHeadRef(resolvedTargetRef);
  const expectedRepository = String(repository || "").trim();
  if (!expectedRepository) {
    throw new Error("repository is required to verify publish channel PR lineage");
  }
  const matchingPullRequest = (pullRequests || []).find((pullRequest) => {
    const baseRef = pullRequest?.base?.ref || "";
    const headRef = pullRequest?.head?.ref || "";
    const headRepo = pullRequest?.head?.repo?.full_name || "";
    if (!pullRequest?.merged_at || baseRef !== resolvedTargetRef || headRepo !== expectedRepository) {
      return false;
    }
    if (resolvedTargetRef === "publish-gate/major" || resolvedTargetRef === "major-gate") {
      return isReleaseLineRef(headRef);
    }
    return headRef === expectedHeadRef;
  });
  if (!matchingPullRequest) {
    throw new Error(
      `publish source-lock PR lineage mismatch: ${parsed.sourceRef} is locked at ${sha}, but target channel ref ${resolvedTargetRef} must come from a merged same-repository PR ${expectedHeadRef} -> ${resolvedTargetRef}. Merge the source commit through that channel PR before running publish verification.`,
    );
  }
  return {
    ok: true,
    skipped: false,
    sourceRef: parsed.sourceRef,
    sourceSha: sha,
    targetRef: resolvedTargetRef,
    expectedHeadRef,
    pullRequest: {
      number: matchingPullRequest.number,
      url: matchingPullRequest.html_url || matchingPullRequest.url || "",
      headRef: matchingPullRequest.head?.ref || "",
      baseRef: matchingPullRequest.base?.ref || "",
      mergedAt: matchingPullRequest.merged_at || "",
    },
  };
}

export function verifyPublishChannelRef({
  sourceRef = "",
  sourceSha = "",
  targetRef = "",
  targetSha = "",
} = {}) {
  const parsed = parsePublishSourceRef(sourceRef);
  const resolvedTargetRef = resolvePublishChannelTargetRef({
    sourceRef,
    targetRef,
  });
  if (!parsed.enabled || parsed.anchor || !resolvedTargetRef) {
    return {
      ok: true,
      skipped: true,
      sourceRef: parsed.sourceRef || normalizeGitRefName(sourceRef),
      targetRef: resolvedTargetRef,
      reason: !parsed.enabled
        ? "publish source ref is not configured"
        : parsed.anchor
          ? "publish-gate/anchor has no channel target ref"
          : "publish target channel ref is not configured",
    };
  }
  const expected = assertSha(sourceSha, "sourceSha");
  const current = assertSha(targetSha, "targetSha");
  if (expected !== current) {
    const channelHint =
      parsed.channel === "alpha" || parsed.channel === "release"
        ? `Merge the source commit through the channel PR into ${resolvedTargetRef} before running publish verification.`
        : `Move ${resolvedTargetRef} to the reviewed source commit before running publish verification.`;
    throw new Error(
      `publish source-lock target mismatch: ${parsed.sourceRef} is locked at ${expected}, but target channel ref ${resolvedTargetRef} points at ${current}. ${channelHint}`,
    );
  }
  return {
    ok: true,
    skipped: false,
    sourceRef: parsed.sourceRef,
    sourceSha: expected,
    targetRef: resolvedTargetRef,
    targetSha: current,
  };
}

function normalizePackageSet(packages) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("package set must include at least one package");
  }
  return packages.map((pkg, index) => {
    const name = String(pkg?.name || "").trim();
    const version = String(pkg?.version || "").trim();
    if (!name) {
      throw new Error(`packages[${index}].name is required`);
    }
    if (!version) {
      throw new Error(`packages[${index}].version is required`);
    }
    return {
      name,
      version,
      role: pkg.role === "main" ? "main" : "platform",
      integrity: pkg.integrity ? String(pkg.integrity) : "",
    };
  });
}

function existingPackageKey(entry) {
  return `${entry.name}@${entry.version}`;
}

export function planPackageSetPublish({
  packages = [],
  existingPackages = [],
  mainPackage = "",
  distTag = "alpha",
} = {}) {
  const normalized = normalizePackageSet(packages).map((pkg) => ({
    ...pkg,
    role: pkg.name === mainPackage ? "main" : pkg.role,
  }));
  const mainPackages = normalized.filter((pkg) => pkg.role === "main");
  if (mainPackages.length !== 1) {
    throw new Error("package set must contain exactly one main package");
  }
  const existing = new Map(
    existingPackages.map((pkg) => {
      const normalizedExisting = normalizePackageSet([pkg])[0];
      return [existingPackageKey(normalizedExisting), normalizedExisting];
    }),
  );
  const steps = [];
  for (const pkg of normalized) {
    const already = existing.get(existingPackageKey(pkg));
    if (already) {
      if (
        pkg.integrity &&
        already.integrity &&
        pkg.integrity !== already.integrity
      ) {
        throw new Error(
          `existing package integrity mismatch: ${pkg.name}@${pkg.version}`,
        );
      }
      steps.push({ action: "accept-existing", package: pkg });
    } else {
      steps.push({ action: "publish", package: pkg });
    }
  }
  const orderedSteps = [
    ...steps.filter((step) => step.package.role !== "main"),
    ...steps.filter((step) => step.package.role === "main"),
  ];
  const main = mainPackages[0];
  return {
    completeAfterPlan: true,
    visibilityGate: "main-package-last",
    distTag,
    steps: orderedSteps,
    distTagMove: {
      action: "move-dist-tag",
      package: main,
      distTag,
      after: "package-set-complete",
    },
  };
}

function normalizePublishRefs(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return DEFAULT_PUBLISH_REFS;
  }
  const parsed = parseJsonObject(raw, "publish-refs-json");
  const normalized = {};
  for (const [channel, patterns] of Object.entries(parsed)) {
    const key = String(channel || "").trim();
    if (!key) {
      throw new Error("publish-refs-json channel names must be non-empty");
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(`publish-refs-json.${key} must be a non-empty array`);
    }
    normalized[key] = patterns.map((pattern, index) => {
      const value = String(pattern || "").trim();
      if (!value) {
        throw new Error(`publish-refs-json.${key}[${index}] must be non-empty`);
      }
      try {
        new RegExp(value);
      } catch (error) {
        throw new Error(
          `publish-refs-json.${key}[${index}] is invalid: ${error.message}`,
        );
      }
      return value;
    });
  }
  return normalized;
}

function parseJsonArray(value, label) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON array`);
    }
    return parsed;
  } catch (error) {
    if (error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

function normalizeRunnerPreset(value) {
  const preset = String(value || "github-hosted").trim() || "github-hosted";
  return RUNNER_PRESET_ALIASES[preset] || preset;
}

function normalizeLinuxContainerPreset(value) {
  const preset = String(value || "").trim();
  return LINUX_CONTAINER_PRESET_ALIASES[preset] ?? preset;
}

function resolveLinuxContainer({
  linuxContainerPreset = "",
  linuxContainerImage = "",
} = {}) {
  const explicitImage = String(linuxContainerImage || "").trim();
  const preset = normalizeLinuxContainerPreset(linuxContainerPreset);
  if (explicitImage) {
    if (preset && preset !== "custom") {
      throw new Error(
        "linux-container-image cannot be combined with a named linux-container-preset",
      );
    }
    return {
      enabled: true,
      preset: preset || "custom",
      image: explicitImage,
      source: "linux-container-image",
    };
  }
  if (!preset) {
    return {
      enabled: false,
      preset: "",
      image: "",
      source: "none",
    };
  }
  const resolved = LINUX_CONTAINER_PRESETS[preset];
  if (!resolved) {
    throw new Error(`unsupported linux-container-preset: ${preset}`);
  }
  return {
    enabled: true,
    preset,
    image: resolved.image,
    source: "linux-container-preset",
  };
}

function platformIsLinux(platform) {
  const id = String(platform?.id || "").toLowerCase();
  const name = String(platform?.name || "").toLowerCase();
  if (id.includes("linux") || name.includes("linux")) {
    return true;
  }
  const runnerLabels = parseJsonArray(
    String(platform?.runner || "[]"),
    "platform.runner",
  ).map((label) => String(label || "").toLowerCase());
  return runnerLabels.some(
    (label) => label.includes("linux") || label.includes("ubuntu"),
  );
}

function normalizePlatform(platform, index) {
  const id = String(platform?.id || "").trim();
  const name = String(platform?.name || id).trim();
  const runner = String(platform?.runner || "").trim();
  if (!id) {
    throw new Error(`platforms-json[${index}].id is required`);
  }
  if (!name) {
    throw new Error(`platforms-json[${index}].name is required`);
  }
  if (!runner) {
    throw new Error(`platforms-json[${index}].runner is required`);
  }
  parseJsonArray(runner, `platforms-json[${index}].runner`);
  return { id, name, runner };
}

export function resolveRunnerMatrix({
  runnerPreset = "github-hosted",
  platformsJson = "",
  linuxContainerPreset = "",
  linuxContainerImage = "",
} = {}) {
  const customPlatformsJson = String(platformsJson || "").trim();
  const linuxContainer = resolveLinuxContainer({
    linuxContainerPreset,
    linuxContainerImage,
  });
  if (customPlatformsJson) {
    const platforms = parseJsonArray(customPlatformsJson, "platforms-json").map(
      normalizePlatform,
    );
    if (platforms.length === 0) {
      throw new Error("platforms-json must include at least one platform");
    }
    const containerPlatforms = linuxContainer.enabled
      ? platforms.filter(platformIsLinux)
      : [];
    const nativePlatforms = linuxContainer.enabled
      ? platforms.filter((platform) => !platformIsLinux(platform))
      : platforms;
    return {
      source: "platforms-json",
      runnerPreset: "custom",
      platforms,
      platformsJson: JSON.stringify(platforms),
      platformCount: platforms.length,
      nativePlatforms,
      nativePlatformsJson: JSON.stringify(nativePlatforms),
      nativePlatformCount: nativePlatforms.length,
      containerPlatforms,
      containerPlatformsJson: JSON.stringify(containerPlatforms),
      containerPlatformCount: containerPlatforms.length,
      linuxContainer,
    };
  }

  const preset = normalizeRunnerPreset(runnerPreset);
  if (preset === "custom") {
    throw new Error("runner-preset=custom requires platforms-json");
  }
  const platforms = RUNNER_PRESETS[preset];
  if (!platforms) {
    throw new Error(`unsupported runner-preset: ${preset}`);
  }
  const containerPlatforms = linuxContainer.enabled
    ? platforms.filter(platformIsLinux)
    : [];
  const nativePlatforms = linuxContainer.enabled
    ? platforms.filter((platform) => !platformIsLinux(platform))
    : platforms;
  return {
    source: "runner-preset",
    runnerPreset: preset,
    platforms,
    platformsJson: JSON.stringify(platforms),
    platformCount: platforms.length,
    nativePlatforms,
    nativePlatformsJson: JSON.stringify(nativePlatforms),
    nativePlatformCount: nativePlatforms.length,
    containerPlatforms,
    containerPlatformsJson: JSON.stringify(containerPlatforms),
    containerPlatformCount: containerPlatforms.length,
    linuxContainer,
  };
}

export function resolvePublishGate({
  trusted = true,
  publishChannel = "none",
  eventName = "",
  ref = "",
  publishRefsJson = "",
} = {}) {
  const channel = String(publishChannel || "none").trim() || "none";
  const isTrusted = trusted === true || String(trusted) === "true";
  if (channel === "none") {
    return {
      trusted: isTrusted,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "publish channel is none",
    };
  }
  if (channel === "anchor") {
    return {
      trusted: isTrusted,
      publishChannel: channel,
      publishAllowed: false,
      publishReason:
        "anchor gates resolve source state but do not publish artifacts",
    };
  }
  if (!isTrusted) {
    return {
      trusted: false,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "event is not trusted",
    };
  }
  if (String(eventName || "") === "pull_request") {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: "pull_request events may verify but may not publish",
    };
  }

  const publishRefs = normalizePublishRefs(publishRefsJson);
  const patterns = publishRefs[channel];
  if (!patterns) {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: `unknown publish channel: ${channel}`,
    };
  }
  const refValue = String(ref || "");
  const matchedPattern = patterns.find((pattern) =>
    new RegExp(pattern).test(refValue),
  );
  if (!matchedPattern) {
    return {
      trusted: true,
      publishChannel: channel,
      publishAllowed: false,
      publishReason: `ref ${refValue || "<empty>"} is not allowed for publish channel ${channel}`,
    };
  }
  return {
    trusted: true,
    publishChannel: channel,
    publishAllowed: true,
    publishReason: `ref matched ${matchedPattern}`,
  };
}

function sanitizeArtifactName(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\r\n]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveArtifactContract({
  artifactName = "buildchain-artifact",
  artifactNameTemplate = DEFAULT_ARTIFACT_NAME_TEMPLATE,
  platformId = "",
  platformName = "",
  sha = "",
  ref = "",
  runId = "",
  runAttempt = "",
} = {}) {
  const baseName =
    String(artifactName || "buildchain-artifact").trim() ||
    "buildchain-artifact";
  const template =
    String(artifactNameTemplate || "").trim() || DEFAULT_ARTIFACT_NAME_TEMPLATE;
  const replacements = {
    artifact: baseName,
    artifactName: baseName,
    platform: platformId,
    platformId,
    platformName,
    sha,
    shortSha: sha ? sha.slice(0, 12) : "",
    ref,
    runId,
    runAttempt,
  };
  const resolved = template.replace(
    /\{([A-Za-z][A-Za-z0-9]*)\}/g,
    (match, key) => {
      if (!Object.hasOwn(replacements, key)) {
        throw new Error(
          `unsupported artifact-name-template placeholder: ${match}`,
        );
      }
      return replacements[key] || "";
    },
  );
  const safeName = sanitizeArtifactName(resolved);
  if (!safeName) {
    throw new Error(
      "artifact-name-template resolved to an empty artifact name",
    );
  }
  return {
    artifactName: safeName,
    artifactBaseName: baseName,
    artifactNameTemplate: template,
    platform: {
      id: platformId,
      name: platformName || platformId,
    },
  };
}

export function parseExpectedArtifactsJson(value = "") {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const expected = parseJsonObject(raw, "expected-artifacts-json");
  const normalized = {};
  if (expected.minFiles !== undefined) {
    normalized.minFiles = Number(expected.minFiles);
    if (!Number.isInteger(normalized.minFiles) || normalized.minFiles < 0) {
      throw new Error(
        "expected-artifacts-json.minFiles must be a non-negative integer",
      );
    }
  }
  if (expected.maxFiles !== undefined) {
    normalized.maxFiles = Number(expected.maxFiles);
    if (!Number.isInteger(normalized.maxFiles) || normalized.maxFiles < 0) {
      throw new Error(
        "expected-artifacts-json.maxFiles must be a non-negative integer",
      );
    }
  }
  if (expected.minTotalBytes !== undefined) {
    normalized.minTotalBytes = Number(expected.minTotalBytes);
    if (
      !Number.isInteger(normalized.minTotalBytes) ||
      normalized.minTotalBytes < 0
    ) {
      throw new Error(
        "expected-artifacts-json.minTotalBytes must be a non-negative integer",
      );
    }
  }
  if (expected.requiredPaths !== undefined) {
    if (!Array.isArray(expected.requiredPaths)) {
      throw new Error("expected-artifacts-json.requiredPaths must be an array");
    }
    normalized.requiredPaths = expected.requiredPaths.map((entry, index) => {
      const pathValue = String(entry || "")
        .replace(/\\/g, "/")
        .trim();
      if (!pathValue) {
        throw new Error(
          `expected-artifacts-json.requiredPaths[${index}] must be non-empty`,
        );
      }
      return pathValue;
    });
  }
  return normalized;
}

export function createArtifactSummary({ artifactName, platform, files }) {
  const totalBytes = files.reduce(
    (sum, file) => sum + Number(file.size || 0),
    0,
  );
  const digest = crypto.createHash("sha256");
  for (const file of files) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return {
    contract: "kungfu-buildchain-artifact-summary",
    artifactName,
    platform,
    fileCount: files.length,
    totalBytes,
    digest: digest.digest("hex"),
  };
}

export function validateExpectedArtifacts({ expected, files, summary }) {
  if (!expected) {
    return { ok: true, source: "none", checks: [] };
  }
  const checks = [];
  const paths = new Set(files.map((file) => file.path));
  function addCheck(name, ok, detail) {
    checks.push({ name, ok, detail });
    if (!ok) {
      throw new Error(`expected artifact check failed: ${name}: ${detail}`);
    }
  }

  if (expected.minFiles !== undefined) {
    addCheck(
      "minFiles",
      summary.fileCount >= expected.minFiles,
      `${summary.fileCount} >= ${expected.minFiles}`,
    );
  }
  if (expected.maxFiles !== undefined) {
    addCheck(
      "maxFiles",
      summary.fileCount <= expected.maxFiles,
      `${summary.fileCount} <= ${expected.maxFiles}`,
    );
  }
  if (expected.minTotalBytes !== undefined) {
    addCheck(
      "minTotalBytes",
      summary.totalBytes >= expected.minTotalBytes,
      `${summary.totalBytes} >= ${expected.minTotalBytes}`,
    );
  }
  for (const requiredPath of expected.requiredPaths || []) {
    addCheck("requiredPath", paths.has(requiredPath), requiredPath);
  }
  return { ok: true, source: "expected-artifacts-json", checks };
}

export function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    for (const [key, value] of Object.entries(outputs)) {
      console.log(`${key}=${value}`);
    }
    return;
  }
  const lines = Object.entries(outputs).map(
    ([key, value]) => `${key}=${value}`,
  );
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

export function findJsonFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return root.endsWith(".json") ? [root] : [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => findJsonFiles(path.join(root, entry.name)));
}

import { parseJsonObject } from "../../contracts/structured-values.js";
import { resolvePublishSourceLock } from "./coordinates.js";
import path from "node:path";
export function getByDottedKey(target, key) {
  return String(key)
    .split(".")
    .reduce((current, segment) => current?.[segment], target);
}

export function versionValue(file) {
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
  } = await import("../../consumer/buildchain-config.js");
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

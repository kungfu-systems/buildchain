import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  discoverConfiguredDerivedVersionMaterial,
  discoverConfiguredVersionStateFiles,
  getLifecycleStage,
  getVersionStrategy,
  loadBuildchainConfig,
  loadConfiguredAnchorManifest,
  runLifecycleStage,
} from "./buildchain-config.js";

export const ANCHORED_VERSION_MATERIAL_CONTRACT =
  "kungfu-buildchain-anchored-version-material/v1";

function git(cwd, args, { buffer = false } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: buffer ? undefined : "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function sha256(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeTargetChannel(targetChannel, targetRef) {
  if (targetChannel) {
    return targetChannel;
  }
  if (String(targetRef || "").startsWith("release/")) {
    return "release";
  }
  if (String(targetRef || "").startsWith("alpha/")) {
    return "alpha";
  }
  return "";
}

function resolveLatestAlphaRef(cwd, targetRef) {
  const match = String(targetRef || "").match(/^release\/v(\d+)\/v\1\.(\d+)$/);
  if (!match) {
    throw new Error(
      `anchored derived material preflight requires release/vN/vN.M target ref, got ${targetRef || "<empty>"}`,
    );
  }
  const prefix = `v${match[1]}.${match[2]}.`;
  const tags = git(cwd, [
    "tag",
    "--list",
    `${prefix}*-alpha.*`,
    "--sort=-version:refname",
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (tags.length === 0) {
    throw new Error(
      `anchored derived material preflight found no exact alpha tag matching ${prefix}*-alpha.*`,
    );
  }
  return tags[0];
}

function gitStatus(cwd) {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"]).trim();
}

function fileAtRef(cwd, ref, filePath) {
  try {
    const content = git(cwd, ["show", `${ref}:${filePath}`], { buffer: true });
    return {
      present: true,
      sha256: sha256(content),
      bytes: content.length,
    };
  } catch {
    return {
      present: false,
      sha256: "",
      bytes: 0,
    };
  }
}

function pathEvidence(cwd, ref, paths) {
  return paths.map((filePath) => ({
    path: filePath,
    ...fileAtRef(cwd, ref, filePath),
  }));
}

function readPackageVersion(cwd) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) {
    return "";
  }
  const value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return typeof value.version === "string" ? value.version : "";
}

export function createAnchoredVersionMaterialEvidence({
  cwd = process.cwd(),
  targetChannel = "",
  targetRef = "",
  alphaRef = "",
  releaseRef = "HEAD",
  runLifecycle = true,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  const versionStrategy = getVersionStrategy(loadedConfig);
  const derivedFiles = loadedConfig
    ? discoverConfiguredDerivedVersionMaterial(resolvedCwd, loadedConfig)
    : [];
  const channel = normalizeTargetChannel(targetChannel, targetRef);
  const base = {
    schemaVersion: 1,
    contract: ANCHORED_VERSION_MATERIAL_CONTRACT,
    applicable: false,
    targetChannel: channel,
    targetRef,
    versionStrategy,
  };
  if (
    !loadedConfig ||
    versionStrategy.strategy !== "anchored" ||
    versionStrategy.next !== "manual" ||
    derivedFiles.length === 0
  ) {
    return {
      ...base,
      reason: "anchored-derived-version-material-not-configured",
    };
  }
  if (channel !== "release") {
    return {
      ...base,
      reason: "target-channel-is-not-release",
    };
  }

  const initialStatus = gitStatus(resolvedCwd);
  if (initialStatus) {
    throw new Error(
      `anchored derived material preflight requires a clean checkout: ${initialStatus}`,
    );
  }

  const anchorManifest = loadConfiguredAnchorManifest(resolvedCwd, loadedConfig);
  const version = anchorManifest?.fields?.npmVersion || readPackageVersion(resolvedCwd);
  const lifecycleEnv = {
    BUILDCHAIN_VERSION: version,
    BUILDCHAIN_VERSION_STRATEGY: versionStrategy.strategy,
    BUILDCHAIN_VERSION_NEXT: versionStrategy.next,
    ...(anchorManifest
      ? {
          BUILDCHAIN_ANCHOR_MANIFEST: anchorManifest.path,
          BUILDCHAIN_ANCHOR_MANIFEST_JSON: JSON.stringify(anchorManifest.fields),
        }
      : {}),
  };
  if (runLifecycle) {
    const installStage = getLifecycleStage(loadedConfig, "install");
    if (installStage) {
      runLifecycleStage({
        cwd: resolvedCwd,
        loadedConfig,
        name: "install",
        stage: installStage,
        env: lifecycleEnv,
      });
    }
    const versionStateStage =
      getLifecycleStage(loadedConfig, "version-state") ||
      getLifecycleStage(loadedConfig, "version_state");
    runLifecycleStage({
      cwd: resolvedCwd,
      loadedConfig,
      name: "version-state",
      stage: versionStateStage,
      env: lifecycleEnv,
    });
    runLifecycleStage({
      cwd: resolvedCwd,
      loadedConfig,
      name: "verify",
      stage: getLifecycleStage(loadedConfig, "verify"),
      env: lifecycleEnv,
    });
  }
  const derivedStatus = gitStatus(resolvedCwd);
  if (derivedStatus) {
    throw new Error(
      `anchored derived version material is stale or hand-edited; derivation changed the committed tree: ${derivedStatus}`,
    );
  }

  const resolvedAlphaRef = alphaRef || resolveLatestAlphaRef(resolvedCwd, targetRef);
  const versionFiles = discoverConfiguredVersionStateFiles(resolvedCwd, loadedConfig)
    .map((file) => file.path);
  const derivedPaths = derivedFiles.map((file) => file.path);
  const allowedPaths = [
    ...new Set([
      ...versionFiles,
      ...(anchorManifest?.path ? [anchorManifest.path] : []),
      ...derivedPaths,
    ]),
  ].sort();
  const changedPaths = git(resolvedCwd, [
    "diff",
    "--name-only",
    resolvedAlphaRef,
    releaseRef,
    "--",
  ])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  const allowed = new Set(allowedPaths);
  const unexpectedPaths = changedPaths.filter((filePath) => !allowed.has(filePath));
  if (unexpectedPaths.length > 0) {
    throw new Error(
      `anchored release tree changed undeclared paths: ${unexpectedPaths.join(", ")}`,
    );
  }

  const alphaCommit = git(resolvedCwd, ["rev-parse", resolvedAlphaRef]).trim();
  const alphaTree = git(resolvedCwd, ["rev-parse", `${resolvedAlphaRef}^{tree}`]).trim();
  const releaseCommit = git(resolvedCwd, ["rev-parse", releaseRef]).trim();
  const releaseTree = git(resolvedCwd, ["rev-parse", `${releaseRef}^{tree}`]).trim();
  const evidence = {
    ...base,
    applicable: true,
    reason: "verified",
    version,
    alpha: {
      ref: resolvedAlphaRef,
      commit: alphaCommit,
      tree: alphaTree,
      material: pathEvidence(resolvedCwd, resolvedAlphaRef, allowedPaths),
    },
    release: {
      ref: releaseRef,
      commit: releaseCommit,
      tree: releaseTree,
      material: pathEvidence(resolvedCwd, releaseRef, allowedPaths),
    },
    allowedPaths,
    versionFiles,
    manifest: anchorManifest?.path || "",
    derivedPaths,
    changedPaths,
    lifecycle: {
      install: Boolean(getLifecycleStage(loadedConfig, "install")),
      derivation: "version-state",
      verification: "verify",
    },
  };
  return {
    ...evidence,
    digest: sha256(stableJson(evidence)),
  };
}

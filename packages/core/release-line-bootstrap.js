import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  discoverConfiguredVersionStateFiles,
  getLifecycleStage,
  loadBuildchainConfig,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
} from "./buildchain-config.js";

function asPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function assertSemver(value, name) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(value || ""))) {
    throw new Error(`${name} must be a semver version without a leading v`);
  }
}

function normalizeRef(ref) {
  return String(ref || "").trim().replace(/^refs\/heads\//, "");
}

function defaultSourceRef({ major, minor }) {
  if (minor > 0) {
    return `release/v${major}/v${major}.${minor - 1}`;
  }
  return `v${major}`;
}

function defaultInitialVersion({ major, minor }) {
  return `${major}.${minor}.0-alpha.0`;
}

function defaultBootstrapBranch({ major, minor }) {
  return `buildchain/release-line/v${major}.${minor}`;
}

function currentGitHead(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function discoverVersionStateFiles(cwd, loadedConfig) {
  if (loadedConfig?.config?.version?.files?.length) {
    return discoverConfiguredVersionStateFiles(cwd, loadedConfig);
  }
  const files = [];
  for (const relativePath of ["lerna.json", "package.json"]) {
    const filePath = path.join(cwd, relativePath);
    const content = readJsonIfExists(filePath);
    if (content && typeof content.version === "string") {
      files.push({
        path: relativePath,
        kind: relativePath === "lerna.json" ? "lerna" : "package",
        content,
      });
    }
  }
  return files;
}

function updateDiscoveredVersionStateContents(files, version) {
  if (files.some((file) => file.type)) {
    return updateConfiguredVersionStateContents(files, version);
  }
  return files
    .map((file) => {
      const next = { ...file.content, version };
      const content = writeJson(next);
      return {
        path: file.path,
        kind: file.kind,
        changed: content !== writeJson(file.content),
        content,
      };
    })
    .filter((file) => file.changed);
}

function changedPaths(cwd) {
  const output = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  }).trimEnd();
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .sort();
}

export function planReleaseLineBootstrap({
  cwd = process.cwd(),
  major,
  minor,
  sourceRef = "",
  initialVersion = "",
  requiredStatusCheck = "check / check",
  setDefault = true,
  createAlphaPr = true,
  approvalCount = 1,
  bootstrapBranch = "",
} = {}) {
  const parsedMajor = asPositiveInteger(major, "major");
  const parsedMinor = asPositiveInteger(minor, "minor");
  const resolvedInitialVersion = initialVersion || defaultInitialVersion({ major: parsedMajor, minor: parsedMinor });
  assertSemver(resolvedInitialVersion, "initialVersion");
  const line = `v${parsedMajor}.${parsedMinor}`;
  const devRef = `dev/v${parsedMajor}/${line}`;
  const alphaRef = `alpha/v${parsedMajor}/${line}`;
  const releaseRef = `release/v${parsedMajor}/${line}`;
  const loadedConfig = loadBuildchainConfig(cwd);
  const versionFiles = discoverVersionStateFiles(cwd, loadedConfig);
  const lifecycleVersionState =
    getLifecycleStage(loadedConfig, "version-state") ||
    getLifecycleStage(loadedConfig, "version_state");
  const source = normalizeRef(sourceRef) || defaultSourceRef({ major: parsedMajor, minor: parsedMinor });
  const branch = normalizeRef(bootstrapBranch) || defaultBootstrapBranch({ major: parsedMajor, minor: parsedMinor });

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-line-bootstrap",
    dryRun: true,
    cwd,
    line,
    major: parsedMajor,
    minor: parsedMinor,
    initialVersion: resolvedInitialVersion,
    source: {
      ref: source,
      sha: currentGitHead(cwd) || "",
    },
    refs: {
      dev: devRef,
      alpha: alphaRef,
      release: releaseRef,
      bootstrap: branch,
    },
    versionState: {
      files: versionFiles.map((file) => file.path),
      lifecycle: lifecycleVersionState ? "version-state" : "none",
    },
    protection: {
      requiredStatusCheck,
      strictStatusChecks: true,
      requiredApprovingReviewCount: approvalCount,
      requiredConversationResolution: true,
      enforceAdmins: true,
      protectedRefs: [devRef, alphaRef, releaseRef],
    },
    repositoryActions: [
      { action: "create-or-verify-source-ref", ref: source },
      { action: "commit-initial-version-state", ref: branch, version: resolvedInitialVersion },
      { action: "create-dev-branch", ref: devRef, from: branch },
      { action: "create-alpha-branch", ref: alphaRef, from: source },
      { action: "create-release-branch", ref: releaseRef, from: source },
      ...(setDefault ? [{ action: "set-default-branch", ref: devRef }] : []),
      { action: "protect-branch", ref: devRef },
      { action: "protect-branch", ref: alphaRef },
      { action: "protect-branch", ref: releaseRef },
      ...(createAlphaPr ? [{ action: "open-alpha-pr", head: devRef, base: alphaRef }] : []),
    ],
    notes: [
      "This bootstrap creates the new minor line before the first alpha promotion.",
      "The source ref stays as the baseline for alpha/release until reviewed channel PRs move them.",
      "The dev branch receives only the initial version-state commit and becomes the active line when setDefault is true.",
    ],
  };
}

export function writeReleaseLineBootstrapVersionState({
  cwd = process.cwd(),
  major,
  minor,
  sourceRef = "",
  initialVersion = "",
  runVersionStateLifecycle = true,
  generatedAt = "",
} = {}) {
  const plan = planReleaseLineBootstrap({ cwd, major, minor, sourceRef, initialVersion });
  const loadedConfig = loadBuildchainConfig(cwd);
  const files = discoverVersionStateFiles(cwd, loadedConfig);
  if (files.length === 0) {
    throw new Error("release line bootstrap requires at least one version-state file");
  }
  const changed = updateDiscoveredVersionStateContents(files, plan.initialVersion);
  for (const file of changed) {
    fs.writeFileSync(path.join(cwd, file.path), file.content);
  }
  const lifecycleVersionState =
    getLifecycleStage(loadedConfig, "version-state") ||
    getLifecycleStage(loadedConfig, "version_state");
  if (runVersionStateLifecycle && lifecycleVersionState) {
    const timestamp = generatedAt || new Date().toISOString();
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "version-state",
      stage: lifecycleVersionState,
      env: {
        BUILDCHAIN_VERSION: plan.initialVersion,
        BUILDCHAIN_SITE_GENERATED_AT: timestamp,
        BUILDCHAIN_SITE_PUBLISHED_AT: timestamp,
        BUILDCHAIN_SITE_TIMESTAMP_POLICY: "ci-injected",
        BUILDCHAIN_SURFACE_GENERATED_AT: timestamp,
        BUILDCHAIN_SURFACE_PUBLISHED_AT: timestamp,
        BUILDCHAIN_SURFACE_TIMESTAMP_POLICY: "ci-injected",
        BUILDCHAIN_SOURCE_SHA: plan.source.sha,
      },
    });
  }
  return {
    ...plan,
    dryRun: false,
    changedFiles: changedPaths(cwd),
  };
}

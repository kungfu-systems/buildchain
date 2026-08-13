import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  detectPackageManager,
  getWorkspaceInfo,
} from "../../../packages/core/package-manager.js";
import {
  discoverConfiguredVersionStateFiles,
  getLifecycleStage,
  loadBuildchainConfig,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
} from "../../../packages/core/buildchain-config.js";

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Content(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function detectVersionPackageManager(cwd) {
  try {
    return detectPackageManager(cwd);
  } catch (error) {
    return {
      name: "unknown",
      reason: "not-detected",
      message: error.message,
    };
  }
}

function discoverVersionStateFiles(cwd = process.cwd()) {
  const loadedConfig = loadBuildchainConfig(cwd);
  if (loadedConfig?.config?.version) {
    const files = discoverConfiguredVersionStateFiles(cwd, loadedConfig);
    return {
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      packageManager: {
        name: "buildchain.toml",
        reason: "buildchain.toml",
        config: loadedConfig.path,
      },
      config: loadedConfig,
    };
  }

  const files = new Map();
  const addJsonVersionFile = (relativePath, kind) => {
    const filePath = path.join(cwd, relativePath);
    const content = readJsonIfExists(filePath);
    if (content && typeof content.version === "string") {
      files.set(relativePath.split(path.sep).join("/"), {
        kind,
        path: relativePath.split(path.sep).join("/"),
        content,
      });
    }
  };

  addJsonVersionFile("lerna.json", "lerna");
  addJsonVersionFile("package.json", "package");

  let workspaceInfo = {};
  try {
    workspaceInfo = getWorkspaceInfo(cwd);
  } catch {
    workspaceInfo = {};
  }
  for (const info of Object.values(workspaceInfo)) {
    if (info?.location) {
      addJsonVersionFile(path.join(info.location, "package.json"), "package");
    }
  }

  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    packageManager: detectVersionPackageManager(cwd),
    config: loadedConfig,
  };
}

function updateVersionStateContents(files, version) {
  if (files.some((file) => file.type)) {
    return updateConfiguredVersionStateContents(files, version);
  }
  return files
    .map((file) => {
      const nextContent = { ...file.content, version };
      const before = writeJsonContent(file.content);
      const after = writeJsonContent(nextContent);
      return {
        path: file.path,
        kind: file.kind,
        changed: before !== after,
        content: after,
      };
    })
    .filter((file) => file.changed);
}

function alignMajorBootstrapReleaseImpact(changedFiles, { version } = {}) {
  if (!changedFiles.some((file) => file.path === ".buildchain/release-impact.json")) {
    return changedFiles;
  }
  const versionMatch = String(version || "").match(/^(\d+)\.(\d+)\./);
  const expectedLine = versionMatch ? `v${versionMatch[1]}.${versionMatch[2]}` : "";
  if (!expectedLine) {
    throw new Error(
      `Major bootstrap release impact line requires an exact semantic version; got ${version || "<empty>"}`,
    );
  }

  return changedFiles.map((file) => {
    if (file.path !== ".buildchain/release-impact.json") {
      return file;
    }
    const impact = JSON.parse(file.content);
    if (impact.release?.version !== version) {
      throw new Error(
        `Major bootstrap release impact version mismatch: expected ${version}, got ${impact.release?.version || "<empty>"}`,
      );
    }
    return {
      ...file,
      content: writeJsonContent({
        ...impact,
        release: {
          ...impact.release,
          line: expectedLine,
        },
      }),
    };
  });
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}
function versionVerificationAllowedPathsForPromotion(channel, discoveredPaths = []) {
  return uniquePaths([
    ...discoveredPaths,
    ...(channel === "release" ? ["dist/site/kfd-claims.json", "dist/site/public-surface-audit.json", "dist/site/workflow-registry.json"] : []),
    ...(channel === "major" ? ["dist/site/kfd-claims.json"] : []),
  ]);
}

function resolveReleaseImpactInput({
  cwd = process.cwd(),
  impactJson = "",
  version = "",
  line = "",
} = {}) {
  const input = String(impactJson || "").trim();
  if (!input) {
    return "";
  }
  const inputPath = path.isAbsolute(input) ? input : path.resolve(cwd, input);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    return input;
  }

  const relativePath = path.relative(cwd, inputPath).split(path.sep).join("/");
  const discovered = discoverVersionStateFiles(cwd);
  const configuredFile = discovered.files.find((file) => file.path === relativePath);
  if (configuredFile && version) {
    const updated = updateVersionStateContents([configuredFile], version).find(
      (file) => file.path === relativePath,
    );
    if (updated) {
      if (!line) {
        return updated.content;
      }
      const impact = JSON.parse(updated.content);
      return writeJsonContent({
        ...impact,
        release: {
          ...impact.release,
          line,
        },
      });
    }
  }
  return fs.readFileSync(inputPath, "utf8");
}

function createTreeEquivalentReleaseImpact({
  channel = "",
  version = "",
  tag = "",
  line = "",
  releaseCandidateValidation = undefined,
} = {}) {
  if (channel !== "release" || releaseCandidateValidation?.treeEquivalent !== true) {
    return "";
  }
  const candidateHash = String(releaseCandidateValidation.candidateHash || "").trim();
  return JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-impact",
    release: { tag, line, version },
    versionImpact: {
      final: "patch",
      source: "release-candidate-tree-equivalence",
      rationale:
        "Buildchain verified that stable publication uses the exact tree already qualified as the release candidate.",
    },
    surfaceImpacts: [
      {
        id: "release-candidate-stable-finalization",
        impact: "patch",
        class: "release-governance",
        rationale:
          "Stable finalization changes release authority and evidence only; the qualified release-candidate tree is unchanged.",
        source: candidateHash
          ? `release-candidate-passport:${candidateHash}`
          : "release-candidate-passport",
      },
    ],
    classification: "patch",
    breaking: false,
    migrationRequired: false,
    summary: "Tree-equivalent release-candidate promotion to the stable publication channel.",
  });
}

function assertAllowedLocalChanges(cwd, allowedPaths) {
  const allowed = new Set(allowedPaths);
  const output = execSync("git status --porcelain --untracked-files=all", {
    cwd,
    encoding: "utf8",
  }).trimEnd();
  const ephemeralBuildchainEvidencePaths = [
    ".buildchain/admitted/",
    ".buildchain/controller/",
    ".buildchain/contract-drift/",
    ".buildchain/kfd/",
    ".buildchain/publication-result.json",
    ".buildchain/reconciliation/",
    ".buildchain/release-candidate/",
    ".buildchain/release-evidence/",
    ".buildchain/release-passport/",
    ".buildchain/release-state/",
    ".buildchain/runtime/",
  ];
  const isEphemeralBuildchainEvidence = (status, filePath) =>
    status === "??" &&
    ephemeralBuildchainEvidencePaths.some((allowedPath) =>
      allowedPath.endsWith("/")
        ? filePath.startsWith(allowedPath)
        : filePath === allowedPath,
    );
  const unexpected = output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const status = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (isEphemeralBuildchainEvidence(status, filePath)) return false;
      return !(allowed.has(filePath) && status !== "??" && !status.includes("D"));
    });
  if (unexpected.length > 0) {
    throw new Error(
      `Version verification changed files outside version state: ${unexpected.join(", ")}`,
    );
  }
}

function applyLocalVersionState(cwd, changedFiles) {
  for (const file of changedFiles) {
    fs.writeFileSync(path.join(cwd, file.path), file.content);
  }
}

function collectAllowedLocalChanges(cwd, allowedPaths) {
  const allowed = new Set(allowedPaths);
  const output = execSync("git status --porcelain --untracked-files=all", {
    cwd,
    encoding: "utf8",
  }).trimEnd();
  const changedPaths = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).trim(),
    }))
    .filter(
      (entry) =>
        allowed.has(entry.path) &&
        entry.status !== "??" &&
        !entry.status.includes("D"),
    )
    .map((entry) => entry.path);
  return [...new Set(changedPaths)].sort().map((filePath) => ({
    path: filePath,
    content: fs.readFileSync(path.join(cwd, filePath), "utf8"),
  }));
}

function runVersionVerification({
  cwd,
  command,
  loadedConfig,
  version,
  changedFiles,
  allowedPaths,
  env: extraEnv, runLifecycleVerify = true,
}) {
  const lifecycleVerify = getLifecycleStage(loadedConfig, "verify");
  const lifecycleVersionState =
    getLifecycleStage(loadedConfig, "version-state") ||
    getLifecycleStage(loadedConfig, "version_state");
  if (!command && (!runLifecycleVerify || !lifecycleVerify) && !lifecycleVersionState) {
    return changedFiles;
  }
  applyLocalVersionState(cwd, changedFiles);
  const lifecycleEnv = { BUILDCHAIN_VERSION: version, ...(extraEnv || {}) };
  if (lifecycleVersionState) {
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "version-state",
      stage: lifecycleVersionState,
      env: lifecycleEnv,
    });
  }
  const env = { ...process.env, ...lifecycleEnv };
  if (command) {
    execSync(command, { cwd, env, stdio: "inherit", shell: true });
  } else if (runLifecycleVerify && lifecycleVerify) {
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "verify",
      stage: lifecycleVerify,
      env: lifecycleEnv,
    });
  }
  assertAllowedLocalChanges(cwd, allowedPaths);
  return collectAllowedLocalChanges(cwd, allowedPaths);
}

function versionVerificationEnv(
  versionStrategy,
  anchorManifest,
  {
    generatedAt = "",
    sourceSha = "",
    preserveExistingLifecycleIdentity = false,
  } = {},
) {
  return {
    BUILDCHAIN_VERSION_STRATEGY: versionStrategy.strategy,
    BUILDCHAIN_VERSION_NEXT: versionStrategy.next,
    ...(preserveExistingLifecycleIdentity
      ? {
          BUILDCHAIN_SITE_GENERATED_AT: "",
          BUILDCHAIN_SITE_PUBLISHED_AT: "",
          BUILDCHAIN_SITE_TIMESTAMP_POLICY: "",
          BUILDCHAIN_SURFACE_GENERATED_AT: "",
          BUILDCHAIN_SURFACE_PUBLISHED_AT: "",
          BUILDCHAIN_SURFACE_TIMESTAMP_POLICY: "",
        }
      : generatedAt
        ? {
            BUILDCHAIN_SITE_GENERATED_AT: generatedAt,
            BUILDCHAIN_SITE_PUBLISHED_AT: generatedAt,
            BUILDCHAIN_SITE_TIMESTAMP_POLICY: "ci-injected",
            BUILDCHAIN_SURFACE_GENERATED_AT: generatedAt,
            BUILDCHAIN_SURFACE_PUBLISHED_AT: generatedAt,
            BUILDCHAIN_SURFACE_TIMESTAMP_POLICY: "ci-injected",
          }
        : {}),
    ...(preserveExistingLifecycleIdentity
      ? { BUILDCHAIN_SOURCE_SHA: "" }
      : sourceSha
        ? { BUILDCHAIN_SOURCE_SHA: sourceSha }
        : {}),
    ...(anchorManifest
      ? {
          BUILDCHAIN_ANCHOR_MANIFEST: anchorManifest.path,
          BUILDCHAIN_ANCHOR_MANIFEST_JSON: JSON.stringify(anchorManifest.fields),
        }
      : {}),
  };
}

function readConfiguredVersionValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return String(file.key)
      .split(".")
      .reduce((current, segment) => current?.[segment], file.content);
  }
  if (file.type === "regex") {
    return file.source.match(file.pattern)?.groups?.version;
  }
  return undefined;
}

function currentConfiguredVersion(files) {
  const versions = [
    ...new Set(
      files
        .map((file) => readConfiguredVersionValue(file))
        .filter(
          (version) => typeof version === "string" && version.trim() !== "",
        ),
    ),
  ];
  if (versions.length === 0) {
    return undefined;
  }
  if (versions.length > 1) {
    throw new Error(`Configured version files disagree: ${versions.join(", ")}`);
  }
  return versions[0];
}

export {
  alignMajorBootstrapReleaseImpact,
  assertAllowedLocalChanges,
  createTreeEquivalentReleaseImpact,
  currentConfiguredVersion,
  discoverVersionStateFiles,
  resolveReleaseImpactInput,
  runVersionVerification,
  sha256Content,
  uniquePaths,
  updateVersionStateContents,
  versionVerificationAllowedPathsForPromotion,
  versionVerificationEnv,
  writeJsonContent,
};

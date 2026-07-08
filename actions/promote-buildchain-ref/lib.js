const DEFAULT_REPOSITORY = "kungfu-systems/buildchain";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import {
  detectPackageManager,
  getWorkspaceInfo,
} from "../../packages/core/package-manager.js";
import {
  discoverConfiguredVersionStateFiles,
  getPublishContract,
  getVersionStrategy,
  getLifecycleStage,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
} from "../../packages/core/buildchain-config.js";
import {
  assertTransactionIdentity,
  createReleaseTransaction,
  defaultPublishEvidencePath,
  defaultReleaseStatePath,
  releaseTransactionStateRef,
  parsePublishArtifactsJson,
  planTransactionRecovery,
  readPublishEvidence,
  readReleaseTransaction,
  transitionReleaseTransaction,
  validatePublishEvidence,
  writeReleaseTransaction,
} from "../../packages/core/publish-transaction.js";
import {
  collectGitHubReleasePassport,
  verifyReleasePassport,
} from "../../packages/core/release-passport.js";
import { validateReleaseCandidatePassport } from "../../packages/core/release-candidate.js";
import {
  createBuildchainKfd1Witness,
  createBuildchainKfd2Claims,
  createBuildchainKfd3ArtifactWitness,
  createBuildchainKfd3PrebuildWitness,
} from "../../packages/core/buildchain-kfd-claims.js";

const COMMIT_IDENTITY = {
  name: "Keren Dong",
  email: "keren.dong@kungfu.link",
};
const MAJOR_GATE_REF = "publish-gate/major";
const LEGACY_MAJOR_GATE_REF = "major-gate";
const GITHUB_ACTIONS_APP_ID = 15368;
const RELEASE_LINE_RECOVERY_PATHS = [
  "actions/promote-buildchain-ref/",
  "scripts/release-line-policy.mjs",
  "tests/promote-buildchain-ref.test.mjs",
  "tests/release-line-policy.test.mjs",
];

function parseTags(input) {
  const tags = String(input || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    throw new Error("At least one tag must be provided");
  }
  for (const tag of tags) {
    if (
      !/^v\d+$|^v\d+\.\d+$|^v\d+\.\d+-alpha$|^v\d+\.\d+\.\d+$|^v\d+\.\d+\.\d+-alpha\.\d+$/.test(
        tag,
      )
    ) {
      throw new Error(`Unsupported buildchain promotion tag: ${tag}`);
    }
  }
  return [...new Set(tags)];
}

function parseRepository(value) {
  const match = String(value || "").match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`Invalid repository: ${value}`);
  }
  return { owner: match[1], repo: match[2] };
}

function assertPromotableRepository(
  owner,
  repo,
  allowRepository = DEFAULT_REPOSITORY,
) {
  const allowed = parseRepository(allowRepository);
  if (owner !== allowed.owner || repo !== allowed.repo) {
    throw new Error(
      `Ref promotion is limited to ${allowRepository}; got ${owner}/${repo}`,
    );
  }
}

function getPromotionRule(targetRef) {
  if (targetRef === MAJOR_GATE_REF || targetRef === LEGACY_MAJOR_GATE_REF) {
    return {
      channel: "major",
      targetRef,
      legacyAlias: targetRef === LEGACY_MAJOR_GATE_REF,
      tags: [],
    };
  }
  const match = String(targetRef || "").match(
    /^(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)$/,
  );
  if (!match) {
    throw new Error(
      `Ref promotion target must be alpha/vN/vN.M, release/vN/vN.M, publish-gate/major, or major-gate; got ${targetRef}`,
    );
  }
  const channel = match[1];
  const major = Number(match[2]);
  const minorMajor = Number(match[3]);
  const minor = Number(match[4]);
  if (major !== minorMajor) {
    throw new Error(`Ref promotion target major mismatch: ${targetRef}`);
  }
  const releasePrefix = `v${major}.${minor}`;
  const majorTag = `v${major}`;
  const minorTag = releasePrefix;
  const alphaTag = `${releasePrefix}-alpha`;
  if (channel === "alpha") {
    return {
      channel,
      major,
      minor,
      releasePrefix,
      majorTag,
      minorTag,
      alphaTag,
      tags: [alphaTag],
    };
  }
  return {
    channel,
    major,
    minor,
    releasePrefix,
    majorTag,
    minorTag,
    alphaTag,
    tags: [majorTag, minorTag],
  };
}

function assertPromotableTargetRef(targetRef) {
  getPromotionRule(targetRef);
}

function assertSha(sha) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || ""))) {
    throw new Error(`Invalid commit SHA: ${sha}`);
  }
}

function stripTagPrefix(tag) {
  return String(tag || "").replace(/^v/, "");
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function detectVersionPackageManager(cwd) {
  try {
    const detected = detectPackageManager(cwd);
    return detected;
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

function expectedHeadRefForTarget(targetRef) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major") {
    return "release/vN/vN.M";
  }
  return rule.channel === "alpha"
    ? `dev/v${rule.major}/v${rule.major}.${rule.minor}`
    : `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
}

function parsePublishGateChannelRef(ref) {
  const match = String(ref || "").match(/^publish-gate\/(alpha|release)\/v(\d+)\/v(\d+)\.(\d+)\/([^/]+)$/);
  if (!match) {
    return undefined;
  }
  const channel = match[1];
  const major = Number(match[2]);
  const minorMajor = Number(match[3]);
  const minor = Number(match[4]);
  if (major !== minorMajor) {
    throw new Error(`Publish-gate ref major mismatch: ${ref}`);
  }
  return {
    ref,
    channel,
    major,
    minor,
    targetRef: `${channel}/v${major}/v${major}.${minor}`,
    consumerVersion: match[5],
  };
}

function parseReleaseLineRef(ref) {
  const match = String(ref || "").match(/^release\/v(\d+)\/v(\d+)\.(\d+)$/);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minorMajor = Number(match[2]);
  const minor = Number(match[3]);
  if (major !== minorMajor) {
    throw new Error(`Release ref major mismatch: ${ref}`);
  }
  return { ref, major, minor };
}

function parseReleaseLineRecoveryRef(ref) {
  const match = String(ref || "").match(/^fix\/release-line-v(\d+)-v(\d+)\.(\d+)-[0-9A-Za-z._-]+$/);
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minorMajor = Number(match[2]);
  const minor = Number(match[3]);
  if (major !== minorMajor) {
    throw new Error(`Release recovery ref major mismatch: ${ref}`);
  }
  return {
    ref,
    major,
    minor,
    targetRef: `release/v${major}/v${major}.${minor}`,
  };
}

function assertAllowedLocalChanges(cwd, allowedPaths) {
  const allowed = new Set(allowedPaths);
  const output = execSync("git status --porcelain --untracked-files=all", {
    cwd,
    encoding: "utf8",
  }).trimEnd();
  const isEphemeralBuildchainEvidence = (status, filePath) =>
    status === "??" &&
    [
      ".buildchain/kfd/",
      ".buildchain/release-candidate/",
      ".buildchain/release-passport/",
    ].some((prefix) => filePath.startsWith(prefix));
  const unexpected = output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const status = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (isEphemeralBuildchainEvidence(status, filePath)) return false;
      return !(
        allowed.has(filePath) &&
        status !== "??" &&
        !status.includes("D")
      );
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
    .filter((entry) =>
      allowed.has(entry.path) &&
      entry.status !== "??" &&
      !entry.status.includes("D")
    )
    .map((entry) => entry.path);
  return [...new Set(changedPaths)].sort().map((filePath) => ({
    path: filePath,
    content: fs.readFileSync(path.join(cwd, filePath), "utf8"),
  }));
}

function runVersionVerification({ cwd, command, loadedConfig, version, changedFiles, allowedPaths, env: extraEnv }) {
  const lifecycleVerify = getLifecycleStage(loadedConfig, "verify");
  const lifecycleVersionState =
    getLifecycleStage(loadedConfig, "version-state") ||
    getLifecycleStage(loadedConfig, "version_state");
  if (!command && !lifecycleVerify && !lifecycleVersionState) {
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
  } else {
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

function versionVerificationEnv(versionStrategy, anchorManifest, { generatedAt = "", sourceSha = "" } = {}) {
  return {
    BUILDCHAIN_VERSION_STRATEGY: versionStrategy.strategy,
    BUILDCHAIN_VERSION_NEXT: versionStrategy.next,
    ...(generatedAt
      ? {
          BUILDCHAIN_SITE_GENERATED_AT: generatedAt,
          BUILDCHAIN_SITE_PUBLISHED_AT: generatedAt,
          BUILDCHAIN_SITE_TIMESTAMP_POLICY: "ci-injected",
          BUILDCHAIN_SURFACE_GENERATED_AT: generatedAt,
          BUILDCHAIN_SURFACE_PUBLISHED_AT: generatedAt,
          BUILDCHAIN_SURFACE_TIMESTAMP_POLICY: "ci-injected",
        }
      : {}),
    ...(sourceSha ? { BUILDCHAIN_SOURCE_SHA: sourceSha } : {}),
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
        .filter((version) => typeof version === "string" && version.trim() !== ""),
    ),
  ];
  if (versions.length === 0) {
    return undefined;
  }
  if (versions.length > 1) {
    throw new Error(
      `Configured version files disagree: ${versions.join(", ")}`,
    );
  }
  return versions[0];
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function runPublishCommand({ cwd, command, loadedConfig, env }) {
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  if (command) {
    execSync(command, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: true,
    });
    return "workflow-input";
  }
  if (lifecyclePublish) {
    runLifecycleStage({
      cwd,
      loadedConfig,
      name: "publish",
      stage: lifecyclePublish,
      env,
    });
    return "buildchain.toml";
  }
  return "none";
}

function npmPackageSpec(artifact) {
  return `${artifact.name}@${artifact.ref}`;
}

function isAlphaLikeVersion(version) {
  return /(?:^|[-.])alpha(?:[-.]|$)/i.test(String(version || ""));
}

function defaultDistTagForChannel(channel) {
  return channel === "alpha" ? "alpha" : "latest";
}

function resolvePublishContract({
  loadedConfig,
  channel,
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
} = {}) {
  const configured = getPublishContract(loadedConfig) || {};
  const mode = publishMode || configured.mode || "publish-final-version";
  const auth = publishAuth || configured.auth || "trusted-publishing";
  const packageSetOrder = publishPackageSetOrder || configured.packageSetOrder || "as-provided";
  const mainPackage = publishPackageMain || configured.mainPackage || "";
  const distTag = publishDistTag || configured.distTag || defaultDistTagForChannel(channel);
  if (!["publish-final-version", "promote-existing-version"].includes(mode)) {
    throw new Error("publish mode must be one of publish-final-version or promote-existing-version");
  }
  if (!["trusted-publishing", "npm-token"].includes(auth)) {
    throw new Error("publish auth must be one of trusted-publishing or npm-token");
  }
  if (!["as-provided", "platforms-first-main-last"].includes(packageSetOrder)) {
    throw new Error("publish package set order must be one of as-provided or platforms-first-main-last");
  }
  if (mode === "promote-existing-version" && auth !== "npm-token") {
    throw new Error("promote-existing-version requires npm-token auth; Trusted Publishing cannot authorize npm dist-tag add");
  }
  if (channel === "release" && mode === "publish-final-version" && distTag !== "latest") {
    throw new Error("release publish-final-version must use dist-tag latest");
  }
  if (channel === "alpha" && mode === "publish-final-version" && distTag !== "alpha") {
    throw new Error("alpha publish-final-version must use dist-tag alpha");
  }
  return {
    mode,
    auth,
    distTag,
    packageSetOrder,
    mainPackage,
  };
}

function allRequiredArtifactsAreNpm(requiredArtifacts) {
  return (
    requiredArtifacts.length > 0 &&
    requiredArtifacts.every(
      (artifact) => artifact.kind === "npm" && artifact.name && artifact.ref,
    )
  );
}

function orderNpmArtifactsForPackageSet({ artifacts, contract }) {
  if (contract.packageSetOrder !== "platforms-first-main-last") {
    return artifacts;
  }
  const mainPackage = contract.mainPackage;
  return [
    ...artifacts.filter((artifact) => artifact.role !== "main" && artifact.name !== mainPackage),
    ...artifacts.filter((artifact) => artifact.role === "main" || artifact.name === mainPackage),
  ];
}

function validatePublishContractForArtifacts({ channel, contract, requiredArtifacts }) {
  if (contract.mode === "promote-existing-version" && !allRequiredArtifactsAreNpm(requiredArtifacts)) {
    throw new Error("promote-existing-version requires npm publish-required-artifacts-json entries");
  }
  if (contract.packageSetOrder === "platforms-first-main-last") {
    const mainArtifacts = requiredArtifacts.filter(
      (artifact) => artifact.role === "main" || artifact.name === contract.mainPackage,
    );
    if (mainArtifacts.length !== 1) {
      throw new Error("platforms-first-main-last package set requires exactly one main npm artifact");
    }
  }
  if (channel === "release" && contract.mode === "publish-final-version") {
    const alphaArtifacts = requiredArtifacts.filter((artifact) => isAlphaLikeVersion(artifact.ref));
    if (alphaArtifacts.length > 0) {
      throw new Error("release publish-final-version must publish final package refs, not alpha refs");
    }
  }
}

function readExistingNpmIntegrity({ cwd, artifact }) {
  const spec = npmPackageSpec(artifact);
  try {
    const output = execFileSync(
      "npm",
      ["view", spec, "dist.integrity", "--json"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!output) {
      throw new Error("empty dist.integrity");
    }
    return JSON.parse(output);
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`existing npm artifact is required for release promotion: ${spec}: ${message}`);
  }
}

function resolveExistingNpmArtifacts({ cwd, requiredArtifacts }) {
  return requiredArtifacts.map((artifact) => ({
    ...artifact,
    digest: readExistingNpmIntegrity({ cwd, artifact }),
  }));
}

function writeExistingNpmEvidence({
  evidencePath,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef,
  releaseMaterialSha,
  publishToolingSha,
  artifacts,
}) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(
      {
        schema: 1,
        version,
        channel,
        source_sha: sourceSha,
        release_sha: releaseSha,
        target_ref: targetRef,
        release_material_sha: releaseMaterialSha,
        publish_tooling_sha: publishToolingSha,
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function toRepoRelative(cwd, filePath) {
  return path.relative(cwd, filePath).split(path.sep).join("/");
}

function readJsonFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function existingJsonObjectFile(filePath) {
  const content = readJsonFileIfExists(filePath);
  return content && typeof content === "object" && !Array.isArray(content) ? filePath : "";
}

function releasePassportArtifactFiles(outputDir) {
  if (!outputDir || !fs.existsSync(outputDir)) {
    return [];
  }
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(outputDir, entry.name);
      return {
        path: `release-passport/${entry.name}`,
        content: fs.readFileSync(filePath, "utf8"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function backfillReleasePassportStateSha(outputDir, releaseStateSha) {
  if (!outputDir || !releaseStateSha) {
    return undefined;
  }
  const passportPath = path.join(outputDir, "buildchain.release.json");
  const passport = readJsonFileIfExists(passportPath);
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    return undefined;
  }
  passport.release = passport.release && typeof passport.release === "object" && !Array.isArray(passport.release)
    ? passport.release
    : {};
  passport.release.releaseStateSha = releaseStateSha;
  writeJsonFile(passportPath, passport);
  return passportPath;
}

function summarizeReleasePassportIssues(report) {
  return (Array.isArray(report?.issues) ? report.issues : [])
    .filter((entry) => entry?.level === "error")
    .map((entry) => {
      const code = entry?.code || "unknown";
      const message = entry?.message || "release passport verification error";
      return `${code}: ${message}`;
    })
    .join("; ");
}

async function verifyCollectedReleasePassport({ collected, cwd, phase = "generated" }) {
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const relativePassportPath = path.relative(cwd, passportPath).split(path.sep).join("/");
  if (collected.checkReport?.ok !== true) {
    const issues = summarizeReleasePassportIssues(collected.checkReport);
    throw new Error(
      `Release passport ${phase} check failed for ${relativePassportPath}${issues ? `: ${issues}` : ""}`,
    );
  }
  const report = await verifyReleasePassport({ passportLocation: passportPath });
  if (report.ok !== true) {
    const issues = summarizeReleasePassportIssues(report);
    throw new Error(
      `Release passport ${phase} verification failed for ${relativePassportPath}${issues ? `: ${issues}` : ""}`,
    );
  }
  return report;
}

function splitPathList(value = "") {
  return String(value || "")
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validatePromotionReleaseCandidate({
  cwd,
  passportPath = ".buildchain/artifacts/release-candidate-passport.json",
  buildSummaryPath = ".buildchain/artifacts/build-summary.json",
  repository,
  targetChannel,
  version = "",
  sourceHeadSha,
  sourceTreeSha = "",
  requirePlatforms = true,
}) {
  const resolvedPassportPath = resolveMaybeRelative(cwd, passportPath);
  if (!fs.existsSync(resolvedPassportPath)) {
    throw new Error(
      `promote-only release candidate requires a verified RC passport at ${passportPath}; run the channel PR reusable build first and pass its release-candidate-passport artifact`,
    );
  }
  const passport = JSON.parse(fs.readFileSync(resolvedPassportPath, "utf8"));
  const resolvedSummaryPath = resolveMaybeRelative(cwd, buildSummaryPath);
  const buildSummary = fs.existsSync(resolvedSummaryPath)
    ? JSON.parse(fs.readFileSync(resolvedSummaryPath, "utf8"))
    : undefined;
  const validation = validateReleaseCandidatePassport({
    passport,
    repository,
    targetChannel,
    version,
    buildSummary,
    requirePlatforms,
  });
  const acceptedSourceShas = [
    passport.source?.headSha,
    passport.source?.mergeRefSha,
  ].filter(Boolean);
  const sourceTreeHash = passport.source?.treeHash || "";
  if (
    sourceHeadSha &&
    !acceptedSourceShas.includes(sourceHeadSha) &&
    (!sourceTreeSha || sourceTreeHash !== sourceTreeSha)
  ) {
    validation.errors.push(
      `source identity mismatch: target SHA ${sourceHeadSha} did not match RC head/merge SHAs (${acceptedSourceShas.join(", ") || "<none>"}) or target tree ${sourceTreeSha || "<empty>"} did not match RC tree ${sourceTreeHash || "<empty>"}`,
    );
  }
  if (validation.errors.length > 0) {
    throw new Error(`release candidate passport validation failed: ${validation.errors.join("; ")}`);
  }
  return {
    passportPath: resolvedPassportPath,
    buildSummaryPath: buildSummary ? resolvedSummaryPath : "",
    candidateHash: passport.candidateHash || "",
    platformCount: Array.isArray(passport.platformMatrix) ? passport.platformMatrix.length : 0,
    builtSourceSha: passport.source?.mergeRefSha || passport.source?.headSha || "",
    builtSourceTreeSha: passport.source?.treeHash || "",
    promotionChannelSha: sourceHeadSha || "",
    promotionChannelTreeSha: sourceTreeSha || "",
    treeEquivalent: Boolean(sourceTreeSha && sourceTreeHash && sourceTreeSha === sourceTreeHash),
  };
}

function resolveMaybeRelative(cwd, filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function existingFiles(paths = [], cwd = process.cwd()) {
  return paths
    .map((filePath) => resolveMaybeRelative(cwd, filePath))
    .filter((filePath) => fs.existsSync(filePath));
}

function platformManifestPathsFromBuildSummary(buildSummaryPath, cwd = process.cwd()) {
  const summary = readJsonFileIfExists(buildSummaryPath);
  if (!summary) {
    return [];
  }
  return (Array.isArray(summary.platforms) ? summary.platforms : [])
    .map((platform) => platform.manifestPath)
    .filter(Boolean)
    .map((manifestPath) => resolveMaybeRelative(cwd, manifestPath))
    .filter((manifestPath) => fs.existsSync(manifestPath));
}

function packageSetFromArtifacts({ artifacts = [], contract = {}, registry = "https://registry.npmjs.org/" } = {}) {
  if (!artifacts.length || contract.packageSetOrder !== "platforms-first-main-last") {
    return undefined;
  }
  const normalized = artifacts.map((artifact) => ({
    name: artifact.name,
    version: artifact.ref || artifact.version || "",
    distTag: contract.distTag || "",
    digest: artifact.digest || "",
    registry,
    platform: artifact.platform || "",
    action: artifact.action || "",
  }));
  const mainPackage = contract.mainPackage || "";
  const mainIndex = normalized.findIndex((artifact) => artifact.name === mainPackage);
  if (mainIndex < 0) {
    return undefined;
  }
  const [main] = normalized.splice(mainIndex, 1);
  return {
    order: contract.packageSetOrder || "",
    registry,
    main,
    platforms: normalized,
  };
}

function writeDistTagPromotionEvidence({
  evidencePath,
  mode,
  auth,
  distTag,
  source,
  artifacts = [],
}) {
  const outputPath = path.join(path.dirname(evidencePath), "dist-tag-evidence.json");
  return writeJsonFile(outputPath, {
    schema: 1,
    contract: "kungfu-buildchain-dist-tag-promotion-evidence",
    mode,
    auth,
    distTag,
    source,
    packages: artifacts.map((artifact) => ({
      name: artifact.name,
      version: artifact.ref || artifact.version || "",
      distTag,
      role: artifact.role || "",
      digest: artifact.digest || "",
    })),
  });
}

function findTransactionEvidencePath({ cwd, transaction, fallbackName }) {
  for (const entry of transaction?.evidence || []) {
    const normalized = String(entry || "");
    if (normalized.endsWith(fallbackName)) {
      return path.resolve(cwd, normalized);
    }
  }
  return "";
}

function npmTokenLooksConfigured() {
  return Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.npm_config__authToken);
}

function preflightNpmTokenAuth({ cwd, registry = "https://registry.npmjs.org/" } = {}) {
  if (!npmTokenLooksConfigured()) {
    throw new Error("promote-existing-version requires npm token auth before dist-tag promotion; set NODE_AUTH_TOKEN or NPM_TOKEN");
  }
  try {
    execFileSync("npm", ["whoami", `--registry=${registry}`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`promote-existing-version npm token preflight failed: npm whoami failed: ${message}`);
  }
}

function npmDistTagAlreadyPoints({ cwd, artifact, distTag }) {
  try {
    const output = execFileSync(
      "npm",
      ["view", artifact.name, `dist-tags.${distTag}`, "--json"],
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!output) {
      return false;
    }
    return JSON.parse(output) === artifact.ref;
  } catch {
    return false;
  }
}

function promoteExistingNpmArtifacts({ cwd, artifacts, distTag }) {
  const promoted = new Set();
  for (const artifact of artifacts) {
    const spec = npmPackageSpec(artifact);
    const key = `${spec}\0${distTag}`;
    if (promoted.has(key)) {
      continue;
    }
    if (npmDistTagAlreadyPoints({ cwd, artifact, distTag })) {
      promoted.add(key);
      continue;
    }
    execFileSync("npm", ["dist-tag", "add", spec, distTag], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    promoted.add(key);
  }
  return "existing-npm-artifacts";
}

function materialErrorRequiresRepair(error) {
  return /release_material_sha mismatch|source_sha mismatch|release_sha mismatch|version mismatch|target_ref mismatch|artifact digest mismatch|required artifact missing/.test(
    error.message || "",
  );
}

function transactionHasPublishedMaterial(transaction) {
  return Boolean(
    (Array.isArray(transaction?.artifacts) && transaction.artifacts.length > 0) ||
    (Array.isArray(transaction?.evidence) && transaction.evidence.length > 0)
  );
}

function publishArtifactKey(artifact) {
  return [
    artifact?.kind || "",
    artifact?.name || "",
    artifact?.ref || "",
    artifact?.digest || "",
  ].join("\0");
}

function transactionCoversRequiredArtifacts(transaction, requiredArtifacts) {
  if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length === 0) {
    return true;
  }
  if (!transactionHasPublishedMaterial(transaction)) {
    return true;
  }
  const existing = new Set(
    (transaction.artifacts || []).map((artifact) => publishArtifactKey(artifact)),
  );
  return requiredArtifacts.every((artifact) => existing.has(publishArtifactKey(artifact)));
}

function ensureTransactionCanResume({
  existing,
  expected,
  explicitOverride,
  evidence,
  validation,
}) {
  if (!existing) {
    return;
  }
  assertTransactionIdentity(existing, expected, { allowToolingDrift: true });
  const recovery = planTransactionRecovery({
    transaction: existing,
    evidence,
    validation,
    explicitOverride,
  });
  if (recovery.blocked) {
    throw new Error(`release transaction cannot resume: ${recovery.reason}`);
  }
}

function canReplaceStaleVersionStateTransaction({
  error,
  existing,
  version,
  exactTag,
  targetRef,
  channel,
  allowVersionStateFinalization,
  localOnly,
}) {
  if (!materialErrorRequiresRepair(error)) {
    return false;
  }
  if (localOnly) {
    return true;
  }
  if (!allowVersionStateFinalization) {
    return false;
  }
  if (transactionHasPublishedMaterial(existing)) {
    return false;
  }
  if (
    existing?.version !== version ||
    existing?.exact_tag !== exactTag ||
    existing?.target_ref !== targetRef ||
    existing?.channel !== channel
  ) {
    return false;
  }
  return !["complete", "abandoned", "failed_permanently"].includes(existing.state || "");
}

function validateTransactionEvidence({
  evidencePath,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef,
  releaseMaterialSha,
  publishToolingSha,
  requiredArtifacts,
}) {
  const evidence = readPublishEvidence(evidencePath);
  if (!evidence) {
    throw new Error(`publish evidence missing: ${evidencePath}`);
  }
  const validation = validatePublishEvidence({
    evidence,
    version,
    channel,
    sourceSha,
    releaseSha,
    targetRef,
    releaseMaterialSha,
    publishToolingSha,
    requiredArtifacts,
  });
  if (!validation.valid) {
    throw new Error(`publish evidence invalid: ${validation.errors.join("; ")}`);
  }
  return validation;
}

function durableTransactionHeadRef(transaction) {
  if (!transaction?.state_ref) {
    throw new Error("release transaction durable state_ref is required");
  }
  return `heads/${transaction.state_ref}`;
}

function decodeGitBlob(blob) {
  const content = blob?.content || "";
  return Buffer.from(
    content.replace(/\n/g, ""),
    blob?.encoding === "base64" ? "base64" : "utf8",
  ).toString("utf8");
}

async function getGitRefOrUndefined({ octokit, owner, repo, ref }) {
  try {
    const { data } = await retryGitHubOperation(
      `git.getRef ${ref}`,
      () => octokit.rest.git.getRef({ owner, repo, ref }),
    );
    return data;
  } catch (error) {
    if (notFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function transientGitHubReadError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || error?.cause?.code || "");
  const message = String(error?.message || "");
  return (
    status >= 500 ||
    ["ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code) ||
    /other side closed|socket|timeout|temporarily unavailable/i.test(message)
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubRetryDelayMs() {
  const raw = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  if (raw === undefined || raw === "") {
    return 1000;
  }
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : 1000;
}

async function retryGitHubOperation(label, operation, { attempts = 4, delayMs = githubRetryDelayMs() } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !transientGitHubReadError(error)) {
        throw error;
      }
      console.warn(`${label} failed with transient GitHub API error (${error.message}); retry ${attempt}/${attempts - 1}`);
      await wait(delayMs * attempt);
    }
  }
  throw lastError;
}

async function getGitCommitWithRetry({ octokit, owner, repo, commitSha }) {
  return retryGitHubOperation(
    `git.getCommit ${commitSha}`,
    () => octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha,
    }),
  );
}

async function listPullRequestsAssociatedWithCommitWithRetry({ octokit, owner, repo, commitSha }) {
  return retryGitHubOperation(
    `repos.listPullRequestsAssociatedWithCommit ${commitSha}`,
    () => octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: commitSha,
    }),
  );
}

async function restoreDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  stateRef,
  statePath,
  evidencePath,
}) {
  if (!octokit || !stateRef) {
    return undefined;
  }
  const record = await readDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef,
  });
  if (!record) {
    return undefined;
  }
  writeReleaseTransaction(statePath, record);

  const ref = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `heads/${stateRef}`,
  });
  const commitSha = ref.object?.sha;
  const { data: commit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha });
  const { data: tree } = await retryGitHubOperation(
    `git.getTree ${stateRef}`,
    () => octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.tree.sha,
      recursive: "1",
    }),
  );
  const entryByPath = new Map((tree.tree || []).map((entry) => [entry.path, entry]));
  const evidenceEntry = entryByPath.get("evidence.json");
  if (evidenceEntry) {
    const { data: evidenceBlob } = await retryGitHubOperation(
      `git.getBlob ${stateRef}/evidence.json`,
      () => octokit.rest.git.getBlob({
        owner,
        repo,
        file_sha: evidenceEntry.sha,
      }),
    );
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, decodeGitBlob(evidenceBlob));
  }

  return record;
}

async function readDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  stateRef,
}) {
  if (!octokit || !stateRef) {
    return undefined;
  }
  const ref = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `heads/${stateRef}`,
  });
  if (!ref) {
    return undefined;
  }
  const commitSha = ref.object?.sha;
  const { data: commit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha });
  const { data: tree } = await retryGitHubOperation(
    `git.getTree ${stateRef}`,
    () => octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: commit.tree.sha,
      recursive: "1",
    }),
  );
  const entryByPath = new Map((tree.tree || []).map((entry) => [entry.path, entry]));
  const stateEntry = entryByPath.get("state.json");
  if (!stateEntry) {
    throw new Error(`durable release transaction ${stateRef} is missing state.json`);
  }
  const { data: stateBlob } = await retryGitHubOperation(
    `git.getBlob ${stateRef}/state.json`,
    () => octokit.rest.git.getBlob({
      owner,
      repo,
      file_sha: stateEntry.sha,
    }),
  );
  return JSON.parse(decodeGitBlob(stateBlob));
}

async function persistDurableReleaseTransaction({
  octokit,
  owner,
  repo,
  cwd,
  transaction,
  evidencePath,
  extraFiles = [],
}) {
  if (!octokit || !transaction) {
    return undefined;
  }
  const refName = durableTransactionHeadRef(transaction);
  const currentRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: refName });

  const stateBlob = await retryGitHubOperation(
    `git.createBlob ${transaction.state_ref}/state.json`,
    () => octokit.rest.git.createBlob({
      owner,
      repo,
      content: JSON.stringify(transaction, null, 2) + "\n",
      encoding: "utf-8",
    }),
  );
  const treeEntries = [
    {
      path: "state.json",
      mode: "100644",
      type: "blob",
      sha: stateBlob.data.sha,
    },
  ];
  if (evidencePath && fs.existsSync(evidencePath)) {
    const evidenceBlob = await retryGitHubOperation(
      `git.createBlob ${transaction.state_ref}/evidence.json`,
      () => octokit.rest.git.createBlob({
        owner,
        repo,
        content: fs.readFileSync(evidencePath, "utf8"),
        encoding: "utf-8",
      }),
    );
    treeEntries.push({
      path: "evidence.json",
      mode: "100644",
      type: "blob",
      sha: evidenceBlob.data.sha,
    });
  }
  for (const file of extraFiles) {
    if (!file?.path) {
      continue;
    }
    const blob = await retryGitHubOperation(
      `git.createBlob ${transaction.state_ref}/${file.path}`,
      () => octokit.rest.git.createBlob({
        owner,
        repo,
        content: String(file.content || ""),
        encoding: "utf-8",
      }),
    );
    treeEntries.push({
      path: file.path,
      mode: "100644",
      type: "blob",
      sha: blob.data.sha,
    });
  }

  const createStateCommit = async (parentSha) => {
    let baseTree;
    const parents = [];
    if (parentSha) {
      const { data: currentCommit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha: parentSha });
      baseTree = currentCommit.tree?.sha;
      parents.push(parentSha);
    }
    const tree = await retryGitHubOperation(
      `git.createTree ${transaction.state_ref}`,
      () => octokit.rest.git.createTree({
        owner,
        repo,
        tree: treeEntries,
        ...(baseTree ? { base_tree: baseTree } : {}),
      }),
    );
    return retryGitHubOperation(
      `git.createCommit ${transaction.state_ref}`,
      () => octokit.rest.git.createCommit({
        owner,
        repo,
        message: `chore(buildchain): persist release transaction ${transaction.exact_tag}`,
        tree: tree.data.sha,
        parents,
      }),
    );
  };
  let commit = await createStateCommit(currentRef?.object?.sha);
  if (currentRef) {
    try {
      await retryGitHubOperation(
        `git.updateRef ${refName}`,
        () => octokit.rest.git.updateRef({
          owner,
          repo,
          ref: refName,
          sha: commit.data.sha,
          force: false,
        }),
      );
    } catch (error) {
      if (!nonFastForwardUpdateRejected(error)) {
        throw error;
      }
      const latestRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: refName });
      commit = await createStateCommit(latestRef?.object?.sha);
      await retryGitHubOperation(
        `git.updateRef ${refName}`,
        () => octokit.rest.git.updateRef({
          owner,
          repo,
          ref: refName,
          sha: commit.data.sha,
          force: false,
        }),
      );
    }
  } else {
    try {
      await retryGitHubOperation(
        `git.createRef ${refName}`,
        () => octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/${refName}`,
          sha: commit.data.sha,
        }),
      );
    } catch (error) {
      if (!referenceAlreadyExists(error)) {
        throw error;
      }
      await retryGitHubOperation(
        `git.updateRef ${refName}`,
        () => octokit.rest.git.updateRef({
          owner,
          repo,
          ref: refName,
          sha: commit.data.sha,
          force: true,
        }),
      );
    }
  }
  return {
    ref: transaction.state_ref,
    sha: commit.data.sha,
    statePath: path.relative(cwd, transaction.state_path || "").split(path.sep).join("/"),
  };
}

async function releaseCommitIncludesTransactionHead({
  octokit,
  owner,
  repo,
  releaseSha,
  transactionReleaseSha,
}) {
  if (!octokit || !releaseSha || !transactionReleaseSha) {
    return false;
  }
  const seen = new Set();
  const queue = [releaseSha];
  while (queue.length > 0 && seen.size < 64) {
    const sha = queue.shift();
    if (!sha || seen.has(sha)) {
      continue;
    }
    if (sha === transactionReleaseSha) {
      return true;
    }
    seen.add(sha);
    const { data: commit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha: sha });
    for (const parent of commit.parents || []) {
      if (!seen.has(parent.sha)) {
        queue.push(parent.sha);
      }
    }
  }
  return false;
}

function uniqueShas(values) {
  return [...new Set(values.filter(Boolean))];
}

function transactionAcceptedExactTagShas(transaction, publicSha) {
  return uniqueShas([
    publicSha,
    transaction?.release_sha,
    transaction?.release_material_sha,
  ]);
}

function releaseTagForPublishedVersion(version = "") {
  const value = String(version || "").trim();
  if (!value) {
    return "";
  }
  return value.startsWith("v") ? value : `v${value}`;
}

function publicReleaseTagForTransaction(transaction = {}) {
  return releaseTagForPublishedVersion(transaction.version) || transaction.exact_tag || "";
}

async function runPublishTransaction({
  octokit,
  owner,
  repo,
  cwd,
  loadedConfig,
  targetRef,
  sourceSha,
  releaseSha,
  version,
  exactTag,
  channel,
  line,
  publishTransaction,
  publishCommand = "",
  publishEvidencePath = "",
  transactionStatePath = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
  actor = "",
  runId = "",
  explicitOverride = false,
  allowVersionStateFinalization = false,
  promotionGeneratedAt = new Date().toISOString(),
}) {
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  const enabled = Boolean(publishTransaction || publishCommand || lifecyclePublish);
  if (!enabled) {
    return undefined;
  }

  const repository = `${owner}/${repo}`;
  const resolvedStatePath = path.resolve(
    cwd,
    transactionStatePath || defaultReleaseStatePath(exactTag, cwd),
  );
  const resolvedEvidencePath = path.resolve(
    cwd,
    publishEvidencePath || defaultPublishEvidencePath(exactTag, cwd),
  );
  let requiredArtifacts = parsePublishArtifactsJson(
    publishRequiredArtifactsJson,
    "publish-required-artifacts-json",
  );
  const publishContract = resolvePublishContract({
    loadedConfig,
    channel,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
  });
  validatePublishContractForArtifacts({
    channel,
    contract: publishContract,
    requiredArtifacts,
  });
  const existingNpmPromotion = publishContract.mode === "promote-existing-version";
  if (existingNpmPromotion) {
    preflightNpmTokenAuth({ cwd });
  }
  requiredArtifacts = orderNpmArtifactsForPackageSet({
    artifacts: requiredArtifacts,
    contract: publishContract,
  });
  if (existingNpmPromotion) {
    requiredArtifacts = resolveExistingNpmArtifacts({ cwd, requiredArtifacts });
    requiredArtifacts = orderNpmArtifactsForPackageSet({
      artifacts: requiredArtifacts,
      contract: publishContract,
    });
  }
  const expected = {
    repository,
    version,
    sourceSha,
    targetRef,
    releaseMaterialSha: releaseMaterialSha || releaseSha,
    publishToolingSha: publishToolingSha || releaseSha,
  };

  const durableStateRef = releaseTransactionStateRef(version);
  const durableExisting = await restoreDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef: durableStateRef,
    statePath: resolvedStatePath,
    evidencePath: resolvedEvidencePath,
  });
  const localExisting = readReleaseTransaction(resolvedStatePath);
  if (durableExisting && localExisting && durableExisting.id !== localExisting.id) {
    throw new Error(
      `release transaction local state ${localExisting.id} conflicts with durable state ${durableExisting.id}`,
    );
  }
  let existing = durableExisting || localExisting;
  let existingEvidence = readPublishEvidence(resolvedEvidencePath);
  let existingValidation;
  if (existingEvidence) {
    existingValidation = validatePublishEvidence({
      evidence: existingEvidence,
      version,
      channel,
      sourceSha,
      releaseSha,
      targetRef,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      requiredArtifacts,
    });
  }
  let versionStateFinalization = false;
  try {
    ensureTransactionCanResume({
      existing,
      expected,
      explicitOverride,
      evidence: existingEvidence,
      validation: existingValidation,
    });
  } catch (error) {
    const canFinalizeVersionState =
      allowVersionStateFinalization &&
      materialErrorRequiresRepair(error) &&
      existing?.version === version &&
      existing?.exact_tag === exactTag &&
      existing?.target_ref === targetRef &&
      ["published", "finalizing", "complete"].includes(existing.state || "") &&
      transactionCoversRequiredArtifacts(existing, requiredArtifacts) &&
      (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha,
          transactionReleaseSha: existing.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha,
          transactionReleaseSha: existing.release_material_sha,
        })
      );
    const canReplaceStaleVersionState =
      canReplaceStaleVersionStateTransaction({
        error,
        existing,
        version,
        exactTag,
        targetRef,
        channel,
        allowVersionStateFinalization,
        localOnly: Boolean(localExisting && !durableExisting),
      });
    if (!canFinalizeVersionState && !canReplaceStaleVersionState) {
      throw error;
    }
    if (canFinalizeVersionState) {
      versionStateFinalization = true;
    } else {
      existing = undefined;
      existingEvidence = undefined;
      existingValidation = undefined;
      fs.rmSync(resolvedStatePath, { force: true });
      fs.rmSync(resolvedEvidencePath, { force: true });
    }
  }
  let transaction =
    existing ||
    createReleaseTransaction({
      repository,
      version,
      exactTag,
      channel,
      line,
      sourceSha,
      targetRef,
      releaseSha,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      actor,
      runId,
    });
  const persistTransaction = async (record) => {
    const persisted = writeReleaseTransaction(resolvedStatePath, record);
    const durable = await persistDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      cwd,
      transaction: persisted,
      evidencePath: resolvedEvidencePath,
    });
    return { transaction: persisted, durable };
  };
  let durable;
  ({ transaction, durable } = await persistTransaction(transaction));
  if (versionStateFinalization) {
    return {
      transaction,
      validation: undefined,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      distTagEvidencePath: findTransactionEvidencePath({
        cwd,
        transaction,
        fallbackName: "dist-tag-evidence.json",
      }),
      packageSet: packageSetFromArtifacts({
        artifacts: requiredArtifacts,
        contract: publishContract,
      }),
      publishContract,
      durable,
      octokit,
      owner,
      repo,
      cwd,
    };
  }

  let validation;
  let publishSource = existingEvidence ? "existing-evidence" : "";
  let distTagEvidencePath = "";
  try {
    const evidence = existingEvidence || readPublishEvidence(resolvedEvidencePath);
    if (evidence) {
      validation = existingValidation;
    }
    if (evidence && !validation) {
      validation = validatePublishEvidence({
        evidence,
        version,
        channel,
        sourceSha,
        releaseSha,
        targetRef,
        releaseMaterialSha: expected.releaseMaterialSha,
        publishToolingSha: expected.publishToolingSha,
        requiredArtifacts,
      });
    }
    const recovery = planTransactionRecovery({
      transaction,
      evidence,
      validation,
      explicitOverride,
    });
    if (recovery.blocked) {
      throw new Error(`release transaction cannot recover: ${recovery.reason}`);
    }
    if (!validation?.valid) {
      if (transaction.state === "repair_required" && explicitOverride) {
        transaction = transitionReleaseTransaction(transaction, "publishing", {
          actor,
          runId,
          failure: "",
        });
      } else if (transaction.state !== "publishing") {
        transaction = transitionReleaseTransaction(transaction, "publishing", {
          actor,
          runId,
        });
      }
      ({ transaction, durable } = await persistTransaction(transaction));
      if (existingNpmPromotion) {
        publishSource = promoteExistingNpmArtifacts({
          cwd,
          artifacts: requiredArtifacts,
          distTag: publishContract.distTag,
        });
        writeExistingNpmEvidence({
          evidencePath: resolvedEvidencePath,
          version,
          channel,
          sourceSha,
          releaseSha,
          targetRef,
          releaseMaterialSha: expected.releaseMaterialSha,
          publishToolingSha: expected.publishToolingSha,
          artifacts: requiredArtifacts,
        });
      } else {
        publishSource = runPublishCommand({
          cwd,
          command: publishCommand,
          loadedConfig,
          env: {
            BUILDCHAIN_VERSION: version,
            BUILDCHAIN_CHANNEL: channel,
            BUILDCHAIN_SOURCE_SHA: sourceSha,
            BUILDCHAIN_TARGET_REF: targetRef,
            BUILDCHAIN_RELEASE_STATE: resolvedStatePath,
            BUILDCHAIN_EVIDENCE_DIR: path.dirname(resolvedEvidencePath),
            BUILDCHAIN_RELEASE_SHA: releaseSha,
            BUILDCHAIN_RELEASE_MATERIAL_SHA: expected.releaseMaterialSha,
            BUILDCHAIN_PUBLISH_TOOLING_SHA: expected.publishToolingSha,
            BUILDCHAIN_SITE_GENERATED_AT: promotionGeneratedAt,
            BUILDCHAIN_SITE_PUBLISHED_AT: promotionGeneratedAt,
            BUILDCHAIN_SITE_TIMESTAMP_POLICY: "ci-injected",
            BUILDCHAIN_SURFACE_GENERATED_AT: promotionGeneratedAt,
            BUILDCHAIN_SURFACE_PUBLISHED_AT: promotionGeneratedAt,
            BUILDCHAIN_SURFACE_TIMESTAMP_POLICY: "ci-injected",
            BUILDCHAIN_PUBLISH_EVIDENCE: resolvedEvidencePath,
            BUILDCHAIN_PUBLISH_MODE: publishContract.mode,
            BUILDCHAIN_PUBLISH_AUTH: publishContract.auth,
            BUILDCHAIN_NPM_DIST_TAG: publishContract.distTag,
            BUILDCHAIN_PACKAGE_SET_ORDER: publishContract.packageSetOrder,
            BUILDCHAIN_PACKAGE_SET_MAIN_PACKAGE: publishContract.mainPackage,
          },
        });
      }
      if (publishSource === "none") {
        throw new Error("publish transaction requires lifecycle.publish, publish-command, or existing evidence");
      }
    }
    validation = validateTransactionEvidence({
      evidencePath: resolvedEvidencePath,
      version,
      channel,
      sourceSha,
      releaseSha,
      targetRef,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      requiredArtifacts,
    });
    distTagEvidencePath = writeDistTagPromotionEvidence({
      evidencePath: resolvedEvidencePath,
      mode: publishContract.mode,
      auth: publishContract.auth,
      distTag: publishContract.distTag,
      source: publishSource || "validated-evidence",
      artifacts: requiredArtifacts,
    });
    if (transaction.state === "publishing" || transaction.state === "publish_failed") {
      transaction = transitionReleaseTransaction(transaction, "published", {
        actor,
        runId,
        failure: "",
      });
    }
    transaction = {
      ...transaction,
      artifacts: validation.evidence.artifacts,
      evidence: [
        path.relative(cwd, resolvedEvidencePath).split(path.sep).join("/"),
        path.relative(cwd, distTagEvidencePath).split(path.sep).join("/"),
      ],
    };
    ({ transaction, durable } = await persistTransaction(transaction));
    return {
      transaction,
      validation,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      distTagEvidencePath,
      packageSet: packageSetFromArtifacts({
        artifacts: requiredArtifacts,
        contract: publishContract,
      }),
      publishContract,
      durable,
      octokit,
      owner,
      repo,
      cwd,
    };
  } catch (error) {
    if (["published", "finalizing", "complete"].includes(transaction.state)) {
      try {
        transaction = transitionReleaseTransaction(transaction, transaction.state, {
          actor,
          runId,
          failure: error.message,
        });
        await persistTransaction(transaction);
      } catch (persistError) {
        error.message = `${error.message}; additionally failed to preserve post-publish transaction state: ${persistError.message}`;
      }
      throw error;
    }
    const nextState = materialErrorRequiresRepair(error)
      ? "repair_required"
      : "publish_failed";
    if (transaction.state !== "repair_required") {
      transaction = transitionReleaseTransaction(transaction, nextState, {
        actor,
        runId,
        failure: error.message,
      });
      await persistTransaction(transaction);
    }
    throw error;
  }
}

async function persistTransactionResult(result, transaction) {
  const persisted = writeReleaseTransaction(result.statePath, transaction);
  const durable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: persisted,
    evidencePath: result.evidencePath,
  });
  return { ...result, transaction: persisted, durable };
}

function generateBuildchainSelfKfdInputs({
  cwd,
  outputDir = ".buildchain/kfd",
  sourceSha = "",
} = {}) {
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const paths = {
    kfd1Witness: path.join(resolvedOutputDir, "buildchain-kfd-1-witness.json"),
    kfd3PrebuildWitness: path.join(resolvedOutputDir, "buildchain-kfd-3-prebuild-witness.json"),
    kfd3ArtifactWitness: path.join(resolvedOutputDir, "buildchain-kfd-3-artifact-witness.json"),
    kfd2ClaimsDir: path.join(resolvedOutputDir, "kfd-2-claims"),
  };
  writeJsonFile(paths.kfd1Witness, createBuildchainKfd1Witness({ root: cwd, sourceSha }));
  writeJsonFile(paths.kfd3PrebuildWitness, createBuildchainKfd3PrebuildWitness({ root: cwd, sourceSha }));
  writeJsonFile(paths.kfd3ArtifactWitness, createBuildchainKfd3ArtifactWitness({ root: cwd, sourceSha }));
  const witnessFiles = {
    "kfd-1-witness": toRepoRelative(cwd, paths.kfd1Witness),
    "kfd-3-prebuild-witness": toRepoRelative(cwd, paths.kfd3PrebuildWitness),
    "kfd-3-artifact-witness": toRepoRelative(cwd, paths.kfd3ArtifactWitness),
  };
  const kfd2ClaimJsons = createBuildchainKfd2Claims({ root: cwd, witnessFiles }).map((claim) => {
    const slug = String(claim.id || "claim")
      .replace(/^claim:/, "")
      .replace(/[^0-9A-Za-z._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "claim";
    return writeJsonFile(path.join(paths.kfd2ClaimsDir, `${slug}.json`), claim);
  });
  return {
    kfd1WitnessJsons: [paths.kfd1Witness],
    kfd2ClaimJsons,
    kfd3PrebuildWitnessJsons: [paths.kfd3PrebuildWitness],
    kfd3ArtifactWitnessJsons: [paths.kfd3ArtifactWitness],
  };
}

async function collectAndPersistReleasePassport({
  result,
  owner,
  repo,
  cwd,
  sourceSha,
  targetRef,
  channel,
  line,
  packageName,
  outputDir,
  productName,
  buildSummaryPath,
  platformManifestPaths = [],
  impactJson = "",
  kfd1WitnessJsons = [],
  kfd2ClaimJsons = [],
  kfd3PrebuildWitnessJsons = [],
  kfd3ArtifactWitnessJsons = [],
  kfd3ArtifactVerifyCommand = "",
  buildchainSelfKfd = false,
  enabled = true,
  releaseCandidateValidation = undefined,
}) {
  if (!enabled || !result?.transaction || result.transaction.state !== "complete") {
    return result;
  }
  if (!result.evidencePath || !fs.existsSync(result.evidencePath)) {
    return result;
  }
  const resolvedOutputDir = path.resolve(cwd, outputDir || ".buildchain/release-passport");
  const resolvedBuildSummary = buildSummaryPath
    ? resolveMaybeRelative(cwd, buildSummaryPath)
    : path.resolve(cwd, ".buildchain/artifacts/build-summary.json");
  const configuredManifests = existingFiles(platformManifestPaths, cwd);
  const buildSummaryJson = existingJsonObjectFile(resolvedBuildSummary);
  const derivedManifests = buildSummaryJson
    ? platformManifestPathsFromBuildSummary(buildSummaryJson, cwd)
    : [];
  const platformManifests = [...new Set([...configuredManifests, ...derivedManifests])];
  const loadedConfig = loadBuildchainConfig(cwd);
  const anchorManifest = loadConfiguredAnchorManifest(cwd, loadedConfig);
  const anchorManifestPath = anchorManifest?.path ? path.resolve(cwd, anchorManifest.path) : "";
  const transactionJson = {
    command: "finalize",
    transaction: result.transaction,
    validation: result.validation || { valid: true, errors: [] },
  };
  const passportSourceSha = result.transaction.source_sha || sourceSha;
  const internalVersion = stripTagPrefix(result.transaction.exact_tag || "");
  const publishedVersion = result.transaction.version || internalVersion;
  const publicReleaseTag = publicReleaseTagForTransaction(result.transaction);
  const selfKfd = buildchainSelfKfd
    ? generateBuildchainSelfKfdInputs({
        cwd,
        sourceSha: passportSourceSha,
      })
    : undefined;
  const resolvedKfd1WitnessJsons = kfd1WitnessJsons.length > 0
    ? kfd1WitnessJsons
    : selfKfd?.kfd1WitnessJsons || [];
  const resolvedKfd2ClaimJsons = kfd2ClaimJsons.length > 0
    ? kfd2ClaimJsons
    : selfKfd?.kfd2ClaimJsons || [];
  const resolvedKfd3PrebuildWitnessJsons = kfd3PrebuildWitnessJsons.length > 0
    ? kfd3PrebuildWitnessJsons
    : selfKfd?.kfd3PrebuildWitnessJsons || [];
  const resolvedKfd3ArtifactWitnessJsons = kfd3ArtifactWitnessJsons.length > 0
    ? kfd3ArtifactWitnessJsons
    : selfKfd?.kfd3ArtifactWitnessJsons || [];
  const collected = collectGitHubReleasePassport({
    cwd,
    tag: publicReleaseTag,
    repository: `${owner}/${repo}`,
    sourceSha: passportSourceSha,
    line,
    outputDir: resolvedOutputDir,
    productName: productName || "Buildchain",
    packageName: packageName || result.packageSet?.main?.name || "@kungfu-tech/buildchain",
    packageVersion: result.transaction.version,
    packageSetJson: result.packageSet ? JSON.stringify(result.packageSet) : "",
    publishEvidenceJson: result.evidencePath,
    trustedPublishingJson: result.publishContract?.auth === "trusted-publishing"
      ? JSON.stringify({
          provider: "npm",
          enabled: true,
          auth: "trusted-publishing",
          workflowRunId: result.transaction.run_id || "",
        })
      : "",
    transactionJson: JSON.stringify(transactionJson),
    anchorManifestJson: anchorManifestPath && fs.existsSync(anchorManifestPath) ? anchorManifestPath : "",
    impactJson,
    kfd1WitnessJsons: resolvedKfd1WitnessJsons,
    kfd2ClaimJsons: resolvedKfd2ClaimJsons,
    kfd3PrebuildWitnessJsons: resolvedKfd3PrebuildWitnessJsons,
    kfd3ArtifactWitnessJsons: resolvedKfd3ArtifactWitnessJsons,
    kfd3ArtifactVerifyCommand,
    buildSummaryJson,
    platformManifestJsons: platformManifests,
    distTagEvidenceJson: existingJsonObjectFile(result.distTagEvidencePath),
    releaseJsonExtra: JSON.stringify({
      channel,
      targetRef,
      publicTag: publicReleaseTag,
      internalTag: result.transaction.exact_tag,
      internalVersion,
      publishedVersion,
      versionLabel: publishedVersion || result.transaction.exact_tag,
      releaseSha: result.transaction.release_sha,
      releaseMaterialSha: result.transaction.release_material_sha,
      ...(releaseCandidateValidation
        ? {
            builtSourceSha: releaseCandidateValidation.builtSourceSha,
            builtSourceTreeSha: releaseCandidateValidation.builtSourceTreeSha,
            promotionChannelSha: releaseCandidateValidation.promotionChannelSha,
            promotionChannelTreeSha: releaseCandidateValidation.promotionChannelTreeSha,
            treeEquivalent: releaseCandidateValidation.treeEquivalent,
          }
        : {}),
      publishToolingSha: result.transaction.publish_tooling_sha,
      releaseStateRef: `refs/heads/${result.transaction.state_ref}`,
    }),
    publishJson: JSON.stringify({
      auth: result.publishContract?.auth || "",
      distTag: result.publishContract?.distTag || "",
      packageSetOrder: result.publishContract?.packageSetOrder || "",
      registry: "https://registry.npmjs.org/",
    }),
    workflow: {
      name: process.env.GITHUB_WORKFLOW || "",
      runId: result.transaction.run_id || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
      url: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && result.transaction.run_id
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${result.transaction.run_id}`
        : "",
      runnerKind: process.env.BUILDCHAIN_RUNNER_KIND || "github-hosted",
      runnerOs: process.env.RUNNER_OS || process.platform,
      runnerArch: process.env.RUNNER_ARCH || process.arch,
      runnerImage: process.env.ImageOS || "",
    },
  });
  await verifyCollectedReleasePassport({ collected, cwd, phase: "generated" });
  const durable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: result.transaction,
    evidencePath: result.evidencePath,
    extraFiles: releasePassportArtifactFiles(collected.outputDir),
  });
  backfillReleasePassportStateSha(collected.outputDir, durable?.sha || "");
  await verifyCollectedReleasePassport({ collected, cwd, phase: "backfilled" });
  const finalDurable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: result.transaction,
    evidencePath: result.evidencePath,
    extraFiles: releasePassportArtifactFiles(collected.outputDir),
  });
  return {
    ...result,
    publicReleaseTag,
    durable: finalDurable || durable,
    releasePassport: {
      outputDir: collected.outputDir,
      passportPath: path.join(collected.outputDir, "buildchain.release.json"),
      durablePath: "release-passport/buildchain.release.json",
      stateSha: finalDurable?.sha || durable?.sha || "",
      files: collected.files,
    },
  };
}

async function beginTransactionFinalization(result, actor, runId) {
  if (!result?.transaction || result.transaction.state === "finalizing" || result.transaction.state === "complete") {
    return result;
  }
  const transaction = transitionReleaseTransaction(result.transaction, "finalizing", {
    actor,
    runId,
  });
  return persistTransactionResult(result, transaction);
}

async function completeTransactionFinalization(result, actor, runId) {
  if (!result?.transaction) {
    return result;
  }
  if (result.transaction.state === "complete") {
    if (!result.transaction.failure) {
      return result;
    }
    const cleared = transitionReleaseTransaction(result.transaction, "complete", {
      actor,
      runId,
      failure: "",
    });
    return persistTransactionResult(result, cleared);
  }
  const current = result.transaction.state === "published"
    ? transitionReleaseTransaction(result.transaction, "finalizing", { actor, runId })
    : result.transaction;
  const transaction = transitionReleaseTransaction(current, "complete", {
    actor,
    runId,
  });
  return persistTransactionResult(result, transaction);
}

async function getCommitInfo(octokit, owner, repo, sha) {
  const { data } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha: sha });
  return {
    treeSha: data.tree?.sha,
    parents: (data.parents || []).map((parent) => parent.sha),
  };
}

async function assertChannelPromotionPr({
  octokit,
  owner,
  repo,
  sha,
  targetRef,
}) {
  const expectedHeadRef = expectedHeadRefForTarget(targetRef);
  const { data: pullRequests } =
    await listPullRequestsAssociatedWithCommitWithRetry({
      octokit,
      owner,
      repo,
      commitSha: sha,
    });
  const matchingPullRequest = pullRequests.find((pullRequest) => {
    const baseRef = pullRequest.base?.ref;
    const headRef = pullRequest.head?.ref;
    const headRepo = pullRequest.head?.repo?.full_name;
    const matchingVersionStateTarget = parseVersionStateBranchName(headRef);
    const matchingPublishGateTarget = parsePublishGateChannelRef(headRef)?.targetRef;
    if (getPromotionRule(targetRef).channel === "major") {
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        (parseReleaseLineRef(headRef) || matchingVersionStateTarget === targetRef) &&
        headRepo === `${owner}/${repo}`
      );
    }
    return (
      pullRequest.merged_at &&
      baseRef === targetRef &&
      (
        headRef === expectedHeadRef ||
        matchingVersionStateTarget === targetRef ||
        matchingPublishGateTarget === targetRef
      ) &&
      headRepo === `${owner}/${repo}`
    );
  });
  if (!matchingPullRequest) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR ${expectedHeadRef} -> ${targetRef}, publish-gate/${getPromotionRule(targetRef).channel}/... -> ${targetRef}, or buildchain/version-state/* -> ${targetRef}`,
    );
  }
  return matchingPullRequest;
}

async function getMajorGateSource({
  octokit,
  owner,
  repo,
  sha,
  targetRef = MAJOR_GATE_REF,
}) {
  const pullRequest = await assertChannelPromotionPr({
    octokit,
    owner,
    repo,
    sha,
    targetRef,
  });
  const source = parseReleaseLineRef(pullRequest.head?.ref);
  if (!source) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR release/vN/vN.M -> ${targetRef}`,
    );
  }
  return {
    source,
    pullRequest,
    major: source.major + 1,
    minor: 0,
    releasePrefix: `v${source.major + 1}.0`,
    majorTag: `v${source.major + 1}`,
    minorTag: `v${source.major + 1}.0`,
    alphaTag: `v${source.major + 1}.0-alpha`,
  };
}

async function assertProtectedChannel({
  octokit,
  owner,
  repo,
  targetRef,
  requiredStatusCheck = "check",
}) {
  let protection;
  try {
    ({ data: protection } = await octokit.rest.repos.getBranchProtection({
      owner,
      repo,
      branch: targetRef,
    }));
  } catch (error) {
    if (error.status === 403) {
      throw new Error(
        `Protected channel ${targetRef} protection details must be readable to verify admin enforcement`,
      );
    }
    throw error;
  }
  if (protection.enforce_admins?.enabled !== true) {
    throw new Error(
      `Protected channel ${targetRef} must enforce branch protection for administrators`,
    );
  }
  if (protection.allow_force_pushes?.enabled !== false) {
    throw new Error(`Protected channel ${targetRef} must disallow force pushes`);
  }
  if (protection.allow_deletions?.enabled !== false) {
    throw new Error(`Protected channel ${targetRef} must disallow branch deletion`);
  }
  if (protection.required_conversation_resolution?.enabled !== true) {
    throw new Error(
      `Protected channel ${targetRef} must require conversation resolution`,
    );
  }
  const reviews = protection.required_pull_request_reviews;
  if (!reviews || Number(reviews.required_approving_review_count || 0) < 1) {
    throw new Error(
      `Protected channel ${targetRef} must require at least one approving review`,
    );
  }
  const checks = protection.required_status_checks;
  if (!checks?.strict) {
    throw new Error(`Protected channel ${targetRef} must require strict status checks`);
  }
  const checkNames = [
    ...(checks.contexts || []),
    ...((checks.checks || []).map((check) => check.context || check.app_id) || []),
  ].map(String);
  if (!checkNames.some((name) => name.includes(requiredStatusCheck))) {
    throw new Error(
      `Protected channel ${targetRef} must require a ${requiredStatusCheck} status check`,
    );
  }
}

function isManagedChannelBranch(ref) {
  return /^(dev|alpha|release)\/v\d+\/v\d+\.\d+$/.test(String(ref || ""));
}

function parseBranchProtectionBypassList(value = "") {
  return [
    ...new Set(
      String(value || "")
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function branchProtectionBypassAllowances({
  apps = "",
  users = "",
  teams = "",
} = {}) {
  const allowances = {
    apps: parseBranchProtectionBypassList(apps),
    users: parseBranchProtectionBypassList(users),
    teams: parseBranchProtectionBypassList(teams),
  };
  if (
    allowances.apps.length === 0 &&
    allowances.users.length === 0 &&
    allowances.teams.length === 0
  ) {
    return undefined;
  }
  return allowances;
}

async function resolveAuthenticatedBypassAllowances({
  octokit,
  allowances,
} = {}) {
  const resolved = {
    apps: [...(allowances?.apps || [])],
    users: [...(allowances?.users || [])],
    teams: [...(allowances?.teams || [])],
  };
  const addUnique = (key, value) => {
    const normalized = String(value || "").trim();
    if (normalized && !resolved[key].includes(normalized)) {
      resolved[key].push(normalized);
    }
  };

  if (typeof octokit?.rest?.users?.getAuthenticated === "function") {
    try {
      const { data } = await retryGitHubOperation(
        "users.getAuthenticated",
        () => octokit.rest.users.getAuthenticated(),
      );
      addUnique("users", data?.login);
    } catch (error) {
      console.log(
        `buildchain: unable to resolve authenticated promotion user for branch-protection bypass: ${error.message}`,
      );
    }
  }

  if (typeof octokit?.rest?.apps?.getAuthenticated === "function") {
    try {
      const { data } = await retryGitHubOperation(
        "apps.getAuthenticated",
        () => octokit.rest.apps.getAuthenticated(),
      );
      addUnique("apps", data?.slug || data?.name);
    } catch (error) {
      console.log(
        `buildchain: unable to resolve authenticated promotion app for branch-protection bypass: ${error.message}`,
      );
    }
  }

  return (
    resolved.apps.length || resolved.users.length || resolved.teams.length
      ? resolved
      : undefined
  );
}

async function ensureManagedChannelBranchProtection({
  octokit,
  owner,
  repo,
  branch,
  requiredStatusCheck = "check",
  branchProtectionBypassApps = "",
  branchProtectionBypassUsers = "",
  branchProtectionBypassTeams = "",
}) {
  if (!isManagedChannelBranch(branch)) {
    return;
  }
  if (typeof octokit.rest.repos?.updateBranchProtection !== "function") {
    return;
  }
  const configuredBypassAllowances = branchProtectionBypassAllowances({
    apps: branchProtectionBypassApps,
    users: branchProtectionBypassUsers,
    teams: branchProtectionBypassTeams,
  });
  const bypassAllowances = await resolveAuthenticatedBypassAllowances({
    octokit,
    allowances: configuredBypassAllowances,
  });
  await retryGitHubOperation(
    `repos.updateBranchProtection ${branch}`,
    () => octokit.rest.repos.updateBranchProtection({
      owner,
      repo,
      branch,
      required_status_checks: {
        strict: true,
        checks: [{ context: requiredStatusCheck, app_id: GITHUB_ACTIONS_APP_ID }],
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: false,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: false,
        ...(bypassAllowances
          ? { bypass_pull_request_allowances: bypassAllowances }
          : {}),
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false,
    }),
  );
}

function latestAlphaForPatch(refs, releasePrefix, patch) {
  return alphaTagsForPatch(refs, releasePrefix, patch)[0];
}

function alphaTagsForPatch(refs, releasePrefix, patch) {
  return refs
    .map((ref) => {
      const parsed = parseAlphaPrereleaseTag(ref.ref, releasePrefix);
      if (!parsed || parsed.patch !== patch) {
        return undefined;
      }
      return { ...parsed, sha: ref.object?.sha };
    })
    .filter(Boolean)
    .sort((a, b) => b.prerelease - a.prerelease);
}

function resolveTagsForTarget(targetRef, inputTags) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major" && (!inputTags || inputTags.length === 0)) {
    return [];
  }
  if (rule.channel === "major") {
    for (const tag of inputTags) {
      if (!/^v\d+$|^v\d+\.0$|^v\d+\.0-alpha$|^v\d+\.0\.\d+$|^v\d+\.0\.\d+-alpha\.\d+$/.test(tag)) {
        throw new Error(`Tag ${tag} is not allowed for publish-gate/major promotion`);
      }
    }
    return inputTags;
  }
  const tags = inputTags && inputTags.length > 0 ? inputTags : rule.tags;
  for (const tag of tags) {
    const isLineReleaseTag =
      tag.startsWith(`${rule.releasePrefix}.`) && !tag.includes("-alpha.");
    const isLineAlphaTag =
      tag === rule.alphaTag ||
      (tag.startsWith(`${rule.releasePrefix}.`) && tag.includes("-alpha."));
    const allowed =
      rule.channel === "release"
        ? tag === rule.majorTag ||
          tag === rule.minorTag ||
          tag === rule.alphaTag ||
          isLineReleaseTag ||
          isLineAlphaTag
        : tag === rule.alphaTag || isLineAlphaTag;
    if (!allowed) {
      throw new Error(
        `Tag ${tag} is not allowed for ${rule.channel} promotion`,
      );
    }
  }
  return tags;
}

function parseReleasePatchTag(refName, releasePrefix) {
  const match = String(refName || "").match(
    new RegExp(`^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)$`),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
  };
}

function parseReleaseTransactionStateRef(refName, releasePrefix) {
  const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
  const match = String(refName || "").match(
    new RegExp(`^refs/heads/buildchain/release-state/${statePrefix}-(\\d+)$`),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: `${releasePrefix}.${Number(match[1])}`,
    patch: Number(match[1]),
    occupied: true,
  };
}

function parseAlphaPrereleaseTag(refName, releasePrefix) {
  const match = String(refName || "").match(
    new RegExp(
      `^refs/tags/${releasePrefix.replace(".", "\\.")}\\.(\\d+)-alpha\\.(\\d+)$`,
    ),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: refName.replace(/^refs\/tags\//, ""),
    patch: Number(match[1]),
    prerelease: Number(match[2]),
  };
}

function parseAlphaPrereleaseVersion(version, releasePrefix) {
  return parseAlphaPrereleaseTag(`refs/tags/v${version}`, releasePrefix);
}

function parseAlphaTransactionStateRef(refName, releasePrefix) {
  const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
  const match = String(refName || "").match(
    new RegExp(
      `^refs/heads/buildchain/release-state/${statePrefix}-(\\d+)-alpha-(\\d+)$`,
    ),
  );
  if (!match) {
    return undefined;
  }
  return {
    tag: `${releasePrefix}.${Number(match[1])}-alpha.${Number(match[2])}`,
    patch: Number(match[1]),
    prerelease: Number(match[2]),
    occupied: true,
  };
}

function getVersionFileValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return String(file.key || "")
      .split(".")
      .reduce((current, segment) => current?.[segment], file.content);
  }
  if (file.type === "regex") {
    const match = file.source.match(file.pattern);
    return match?.groups?.version;
  }
  return file.content?.version;
}

function currentAlphaVersionState({ cwd, refs, releasePrefix }) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0) {
    return undefined;
  }
  const versions = [
    ...new Set(
      discovered.files
        .map((file) => getVersionFileValue(file))
        .filter((version) => typeof version === "string" && version.trim()),
    ),
  ];
  if (versions.length !== 1) {
    return undefined;
  }
  const parsed = parseAlphaPrereleaseVersion(versions[0], releasePrefix);
  if (!parsed) {
    return undefined;
  }
  return {
    ...parsed,
    tag: `v${versions[0]}`,
    version: versions[0],
  };
}

function currentReleaseVersionState({ cwd, refs, releasePrefix }) {
  const discovered = discoverVersionStateFiles(cwd);
  if (discovered.files.length === 0) {
    return undefined;
  }
  const versions = [
    ...new Set(
      discovered.files
        .map((file) => getVersionFileValue(file))
        .filter((version) => typeof version === "string" && version.trim()),
    ),
  ];
  if (versions.length !== 1) {
    return undefined;
  }
  const parsed = parseReleasePatchTag(`refs/tags/v${versions[0]}`, releasePrefix);
  if (!parsed) {
    return undefined;
  }
  const stateRef = `refs/heads/${releaseTransactionStateRef(versions[0])}`;
  const hasDurableState = refs.some((ref) => ref.ref === stateRef);
  if (!hasDurableState) {
    return undefined;
  }
  return {
    ...parsed,
    tag: `v${versions[0]}`,
    version: versions[0],
  };
}

async function readDurableTransactionForVersion({ octokit, owner, repo, version }) {
  if (!version) {
    return undefined;
  }
  try {
    return await readDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      stateRef: releaseTransactionStateRef(version),
    });
  } catch (error) {
    const message = error?.message || "";
    if (notFound(error) || /missing state\.json|getTree is not a function/i.test(message)) {
      return undefined;
    }
    throw error;
  }
}

async function resumableAlphaTransactionState({
  octokit,
  owner,
  repo,
  cwd,
  refs,
  releasePrefix,
  targetRef,
  sourceSha,
}) {
  const candidates = refs
    .map((ref) => parseAlphaPrereleaseRef(ref.ref, releasePrefix))
    .filter((ref) => ref?.source === "release-state")
    .sort((a, b) => b.patch - a.patch || b.prerelease - a.prerelease);
  for (const candidate of candidates) {
    const version = stripTagPrefix(candidate.tag);
    let transaction;
    try {
      transaction = await readDurableReleaseTransaction({
        octokit,
        owner,
        repo,
        stateRef: releaseTransactionStateRef(version),
      });
    } catch (error) {
      const message = error?.message || "";
      if (notFound(error) || /missing state\.json/i.test(message)) {
        continue;
      }
      throw error;
    }
    const exactTransactionSource =
      transaction?.source_sha === sourceSha ||
      transaction?.release_sha === sourceSha ||
      transaction?.release_material_sha === sourceSha;
    const transactionInSourceHistory =
      !transactionHasPublishedMaterial(transaction) &&
      (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_material_sha,
        })
      );
    if (
      transaction &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["complete", "abandoned", "failed_permanently"].includes(transaction.state) &&
      (exactTransactionSource || transactionInSourceHistory)
    ) {
      return {
        ...candidate,
        version,
        transaction,
      };
    }
  }
  return undefined;
}

async function resumableReleaseTransactionState({
  octokit,
  owner,
  repo,
  refs,
  releasePrefix,
  targetRef,
  sourceSha,
}) {
  const candidates = refs
    .map((ref) => parseReleaseTransactionStateRef(ref.ref, releasePrefix))
    .filter(Boolean)
    .sort((a, b) => b.patch - a.patch);
  for (const candidate of candidates) {
    const version = stripTagPrefix(candidate.tag);
    let transaction;
    try {
      transaction = await readDurableReleaseTransaction({
        octokit,
        owner,
        repo,
        stateRef: releaseTransactionStateRef(version),
      });
    } catch (error) {
      const message = error?.message || "";
      if (notFound(error) || /missing state\.json/i.test(message)) {
        continue;
      }
      throw error;
    }
    const exactTransactionSource =
      transaction?.source_sha === sourceSha ||
      transaction?.release_sha === sourceSha ||
      transaction?.release_material_sha === sourceSha;
    const transactionInSourceHistory =
      !transactionHasPublishedMaterial(transaction) &&
      (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_material_sha,
        })
      );
    if (
      transaction &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["complete", "abandoned", "failed_permanently"].includes(transaction.state) &&
      (exactTransactionSource || transactionInSourceHistory)
    ) {
      return {
        ...candidate,
        version,
        transaction,
      };
    }
  }
  return undefined;
}

function parseAlphaPrereleaseRef(refName, releasePrefix) {
  const tag = parseAlphaPrereleaseTag(refName, releasePrefix);
  if (tag) {
    return { ...tag, source: "tag" };
  }
  const stateRef = parseAlphaTransactionStateRef(refName, releasePrefix);
  if (stateRef) {
    return { ...stateRef, source: "release-state" };
  }
  return undefined;
}

function selectReleaseTag({ refs, releasePrefix, sha }) {
  const releaseTags = refs
    .map((ref) => {
      const parsed = parseReleasePatchTag(ref.ref, releasePrefix);
      if (!parsed) {
        return undefined;
      }
      return { ...parsed, sha: ref.object?.sha };
    })
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch);
  const occupiedReleaseStates = refs
    .map((ref) => parseReleaseTransactionStateRef(ref.ref, releasePrefix))
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch);

  const existingForSha = releaseTags.find((tag) => tag.sha === sha);
  if (existingForSha) {
    return {
      tag: existingForSha.tag,
      patch: existingForSha.patch,
      exists: true,
    };
  }
  const latestPatch = Math.max(
    releaseTags.length > 0 ? releaseTags[releaseTags.length - 1].patch : -1,
    occupiedReleaseStates.length > 0
      ? occupiedReleaseStates[occupiedReleaseStates.length - 1].patch
      : -1,
  );
  return {
    tag: `${releasePrefix}.${latestPatch + 1}`,
    patch: latestPatch + 1,
    exists: false,
  };
}

function selectAlphaTag({ refs, releasePrefix, sha, patchAfterRelease }) {
  const alphaTags = refs
    .map((ref) => {
      const parsed = parseAlphaPrereleaseRef(ref.ref, releasePrefix);
      if (!parsed) {
        return undefined;
      }
      return {
        ...parsed,
        sha: parsed.source === "tag" ? ref.object?.sha : undefined,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch || a.prerelease - b.prerelease);

  if (patchAfterRelease !== undefined) {
    const samePatchTags = alphaTags.filter(
      (tag) => tag.patch === patchAfterRelease,
    );
    const existingForSha = samePatchTags.find(
      (tag) => tag.source === "tag" && tag.sha === sha,
    );
    if (existingForSha) {
      return {
        tag: existingForSha.tag,
        patch: existingForSha.patch,
        prerelease: existingForSha.prerelease,
        sha: existingForSha.sha,
        exists: true,
      };
    }
    const prepared = samePatchTags
      .filter((tag) => tag.source === "tag")
      .at(-1);
    if (prepared) {
      return {
        tag: prepared.tag,
        patch: prepared.patch,
        prerelease: prepared.prerelease,
        sha: prepared.sha,
        exists: true,
      };
    }
    const latestPrerelease =
      samePatchTags.length > 0
        ? samePatchTags[samePatchTags.length - 1].prerelease
        : -1;
    const prerelease = latestPrerelease + 1;
    return {
      tag: `${releasePrefix}.${patchAfterRelease}-alpha.${prerelease}`,
      patch: patchAfterRelease,
      prerelease,
      exists: false,
    };
  }

  const existingForSha = alphaTags.find(
    (tag) => tag.source === "tag" && tag.sha === sha,
  );
  if (existingForSha) {
    return {
      tag: existingForSha.tag,
      patch: existingForSha.patch,
      prerelease: existingForSha.prerelease,
      sha: existingForSha.sha,
      exists: true,
    };
  }

  const releaseTags = refs
    .map((ref) => parseReleasePatchTag(ref.ref, releasePrefix))
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch);
  const occupiedReleaseStates = refs
    .map((ref) => parseReleaseTransactionStateRef(ref.ref, releasePrefix))
    .filter(Boolean)
    .sort((a, b) => a.patch - b.patch);
  const latestReleasePatch = Math.max(
    releaseTags.length > 0 ? releaseTags[releaseTags.length - 1].patch : -1,
    occupiedReleaseStates.length > 0
      ? occupiedReleaseStates[occupiedReleaseStates.length - 1].patch
      : -1,
  );
  const latestAlpha =
    alphaTags.length > 0 ? alphaTags[alphaTags.length - 1] : undefined;
  if (latestAlpha && latestAlpha.patch >= latestReleasePatch + 1) {
    const prerelease = latestAlpha.prerelease + 1;
    return {
      tag: `${releasePrefix}.${latestAlpha.patch}-alpha.${prerelease}`,
      patch: latestAlpha.patch,
      prerelease,
      exists: false,
    };
  }

  const patch = latestReleasePatch + 1;
  return {
    tag: `${releasePrefix}.${patch}-alpha.0`,
    patch,
    prerelease: 0,
    exists: false,
  };
}

function notFound(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 404 ||
    (status === 422 && /Reference does not exist/i.test(message))
  );
}

function referenceAlreadyExists(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 422 && /Reference already exists/i.test(message);
}

function protectedBranchUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return (
    status === 422 &&
    /Changes must be made through a pull request|Required status check|approving review is required/i.test(message)
  );
}

function protectedBranchDirectUpdateError({ branch, branchSha, error }) {
  const message = error?.response?.data?.message || error?.message || String(error || "");
  return new Error(
    `Buildchain generated version-state update for ${branch} -> ${branchSha} was rejected by branch protection: ${message}. ` +
      "Promotion must complete without a post-publish human PR; configure BUILDCHAIN_PROMOTION_TOKEN as a direct-write release authority and allow Buildchain to create the generated version-state required check before updating the protected ref.",
  );
}

async function createGeneratedVersionStateCheck({
  octokit,
  owner,
  repo,
  branch,
  branchSha,
  currentSha,
  requiredStatusCheck,
}) {
  if (!isManagedChannelBranch(branch)) {
    return false;
  }
  if (!requiredStatusCheck) {
    return false;
  }
  if (typeof octokit?.rest?.checks?.create !== "function") {
    console.log(
      `buildchain: unable to create generated version-state check '${requiredStatusCheck}' for ${branchSha}; checks.create is unavailable`,
    );
    return false;
  }
  await retryGitHubOperation(
    `checks.create ${requiredStatusCheck} ${branchSha}`,
    () => octokit.rest.checks.create({
      owner,
      repo,
      name: requiredStatusCheck,
      head_sha: branchSha,
      status: "completed",
      conclusion: "success",
      output: {
        title: "Buildchain generated version-state verification",
        summary:
          `Buildchain verified generated version-state commit ${branchSha} for ${branch} before direct protected ref update.\n\n` +
          `Previous branch head: ${currentSha || "new branch"}\n\n` +
          "This check is emitted only after promote-buildchain-ref has generated the commit through the declared version-state files and verification gate.",
      },
    }),
  );
  return true;
}

function nonFastForwardUpdateRejected(error) {
  const status = error?.status || error?.response?.status;
  const message = error?.response?.data?.message || error?.message || "";
  return status === 422 && /Update is not a fast forward/i.test(message);
}

function versionStateBranchName(branch, sha) {
  return `buildchain/version-state/${branch.replaceAll("/", "-")}/${sha.slice(0, 12)}`;
}

function parseVersionStateBranchName(branch) {
  const publishGateMajorMatch = String(branch || "").match(
    /^buildchain\/version-state\/publish-gate-major\/[0-9a-f]{12,40}$/,
  );
  if (publishGateMajorMatch) {
    return MAJOR_GATE_REF;
  }
  const majorGateMatch = String(branch || "").match(
    /^buildchain\/version-state\/major-gate\/[0-9a-f]{12,40}$/,
  );
  if (majorGateMatch) {
    return LEGACY_MAJOR_GATE_REF;
  }
  const match = String(branch || "").match(
    /^buildchain\/version-state\/(alpha|release)-v(\d+)-v(\d+\.\d+)\/[0-9a-f]{12,40}$/,
  );
  if (!match) {
    return undefined;
  }
  return `${match[1]}/v${match[2]}/v${match[3]}`;
}

async function promoteBuildchainRefs({
  octokit,
  owner,
  repo,
  sha,
  targetRef,
  tags,
  dryRun = false,
  allowRepository = DEFAULT_REPOSITORY,
  cwd = process.cwd(),
  versionState = true,
  requireVersionState = false,
  requireGovernance = false,
  verificationCommand = "",
  requiredStatusCheck = "check",
  statusCheckOctokit = octokit,
  refUpdateOctokit = octokit,
  branchProtectionBypassApps = "",
  branchProtectionBypassUsers = "",
  branchProtectionBypassTeams = "",
  publishTransaction = false,
  publishCommand = "",
  publishEvidencePath = "",
  transactionStatePath = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
  releasePassport = true,
  releasePassportOutputDir = ".buildchain/release-passport",
  releasePassportProductName = "Buildchain",
  releasePassportBuildSummaryPath = ".buildchain/artifacts/build-summary.json",
  releasePassportPlatformManifestPaths = "",
  releasePassportImpactJson = "",
  releasePassportKfd1WitnessJsons = "",
  releasePassportKfd2ClaimJsons = "",
  releasePassportKfd3PrebuildWitnessJsons = "",
  releasePassportKfd3ArtifactWitnessJsons = "",
  releasePassportKfd3ArtifactVerifyCommand = "",
  releasePassportBuildchainSelfKfd = false,
  promoteOnlyReleaseCandidate = false,
  releaseCandidatePassportPath = ".buildchain/artifacts/release-candidate-passport.json",
  releaseCandidateBuildSummaryPath = ".buildchain/artifacts/build-summary.json",
  releaseCandidateVersion = "",
  actor = process.env.GITHUB_ACTOR || process.env.USER || "",
  runId = process.env.GITHUB_RUN_ID || "",
  publishTransactionOverride = false,
}) {
  assertPromotableRepository(owner, repo, allowRepository);
  assertPromotableTargetRef(targetRef);
  assertSha(sha);
  const rule = getPromotionRule(targetRef);
  const requestedTags = tags
    ? resolveTagsForTarget(targetRef, tags)
    : undefined;

  const { data: branchRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${targetRef}`,
  });
  const branchSha = branchRef.object.sha;
  if (branchSha !== sha) {
    throw new Error(
      `Ref ${targetRef} points at ${branchSha}, not requested SHA ${sha}`,
    );
  }

  const updates = [];
  const promotionGeneratedAt = new Date().toISOString();
  let releaseCandidateValidation;
  if (promoteOnlyReleaseCandidate) {
    const targetCommitInfo = await getCommitInfo(octokit, owner, repo, sha);
    releaseCandidateValidation = validatePromotionReleaseCandidate({
      cwd,
      passportPath: releaseCandidatePassportPath,
      buildSummaryPath: releaseCandidateBuildSummaryPath,
      repository: `${owner}/${repo}`,
      targetChannel: rule.channel,
      version: releaseCandidateVersion,
      sourceHeadSha: sha,
      sourceTreeSha: targetCommitInfo.treeSha,
    });
    updates.push({
      action: "verified-release-candidate",
      sha,
      candidateHash: releaseCandidateValidation.candidateHash,
      platformCount: releaseCandidateValidation.platformCount,
      passportPath: path.relative(cwd, releaseCandidateValidation.passportPath).split(path.sep).join("/"),
    });
  }

  const listLineRefs = async (releasePrefix = rule.releasePrefix) => {
    const { data: tagRefs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `tags/${releasePrefix}.`,
    });
    const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
    const { data: stateRefs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `heads/buildchain/release-state/${statePrefix}-`,
    });
    return [...tagRefs, ...stateRefs];
  };

  const ensureTag = async (tag, tagSha = sha, options = {}) => {
    const acceptedExistingShas = uniqueShas([
      tagSha,
      ...(options.acceptedExistingShas || []),
    ]);
    const acceptedExistingMaterialShas = uniqueShas(
      options.acceptedExistingMaterialShas || [],
    );
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha: tagSha });
      return;
    }
    try {
      const { data: tagRef } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${tag}`,
      });
      let acceptedExistingMaterial = false;
      for (const materialSha of acceptedExistingMaterialShas) {
        if (await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: tagRef.object.sha,
          transactionReleaseSha: materialSha,
        })) {
          acceptedExistingMaterial = true;
          break;
        }
      }
      if (!acceptedExistingShas.includes(tagRef.object.sha) && !acceptedExistingMaterial) {
        throw new Error(
          `Tag ${tag} points at ${tagRef.object.sha}, not one of requested SHAs ${acceptedExistingShas.join(", ")}`,
        );
      }
      updates.push({ tag, action: "existing", sha: tagRef.object.sha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: tagSha,
      });
      updates.push({ tag, action: "created", sha: tagSha });
    }
  };

  const updateTag = async (tag, tagSha = sha) => {
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha: tagSha });
      return;
    }
    try {
      await octokit.rest.git.updateRef({
        owner,
        repo,
        ref: `tags/${tag}`,
        sha: tagSha,
        force: true,
      });
      updates.push({ tag, action: "updated", sha: tagSha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: tagSha,
      });
      updates.push({ tag, action: "created", sha: tagSha });
    }
  };

  const readRefSha = async (ref) => {
    try {
      const { data: refData } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref,
      });
      return refData.object.sha;
    } catch (error) {
      if (notFound(error)) {
        return undefined;
      }
      throw error;
    }
  };

  const updateBranch = async (branch, branchSha, action = "updated", protectedUpdate) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run", sha: branchSha });
      return { updated: true };
    }
    const ensureChannelProtection = () => ensureManagedChannelBranchProtection({
      octokit,
      owner,
      repo,
      branch,
      requiredStatusCheck,
      branchProtectionBypassApps,
      branchProtectionBypassUsers,
      branchProtectionBypassTeams,
    });
    const currentSha = await readRefSha(`heads/${branch}`);
    if (currentSha) {
      await ensureChannelProtection();
    }
    if (currentSha === branchSha) {
      updates.push({ ref: branch, action: "existing", sha: branchSha });
      return { updated: true, existing: true };
    }
    const branchWriteOctokit = protectedUpdate ? (refUpdateOctokit || octokit) : octokit;
    const openVersionStatePullRequest = async ({ error }) => {
      const message = error?.response?.data?.message || error?.message || String(error || "");
      if (
        !protectedUpdate?.allowPendingPullRequest ||
        !protectedUpdate?.title ||
        typeof octokit.rest.pulls?.create !== "function"
      ) {
        throw protectedBranchDirectUpdateError({ branch, branchSha, error });
      }
      const versionStateBranch = versionStateBranchName(branch, branchSha);
      const versionStateRef = `heads/${versionStateBranch}`;
      const existingVersionStateSha = await readRefSha(versionStateRef);
      if (existingVersionStateSha && existingVersionStateSha !== branchSha) {
        throw new Error(
          `Buildchain generated version-state branch ${versionStateBranch} points at ${existingVersionStateSha}, not ${branchSha}`,
        );
      }
      if (!existingVersionStateSha) {
        await branchWriteOctokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/${versionStateRef}`,
          sha: branchSha,
        });
        updates.push({
          ref: versionStateBranch,
          action: "created-version-state-pr-head",
          sha: branchSha,
        });
      }
      if (typeof octokit.rest.pulls?.list === "function") {
        const { data: existingPullRequests } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: "open",
          base: branch,
          head: `${owner}:${versionStateBranch}`,
        });
        const existingPullRequest = (existingPullRequests || [])[0];
        if (existingPullRequest) {
          updates.push({
            ref: branch,
            action: "pending-version-state-pr",
            sha: branchSha,
            pullRequest: existingPullRequest.html_url || existingPullRequest.url,
          });
          return {
            updated: false,
            pending: true,
            currentSha,
            pullRequest: existingPullRequest,
          };
        }
      }
      const { data: pullRequest } = await octokit.rest.pulls.create({
        owner,
        repo,
        title: protectedUpdate.title,
        body:
          `${protectedUpdate.body || protectedUpdate.title}\n\n` +
          `Buildchain generated this PR because protected branch ${branch} rejected direct generated bookkeeping.\n\n` +
          `Rejected update: ${currentSha || "new branch"} -> ${branchSha}\n\n` +
          `GitHub response: ${message}`,
        head: versionStateBranch,
        base: branch,
      });
      updates.push({
        ref: branch,
        action: "pending-version-state-pr",
        sha: branchSha,
        pullRequest: pullRequest.html_url || pullRequest.url,
      });
      return { updated: false, pending: true, currentSha, pullRequest };
    };
    const createVersionStateMergeCommit = async () => {
      const allowedPaths = protectedUpdate?.allowMergeCommitOnNonFastForwardPaths || [];
      if (!allowedPaths.length) {
        return undefined;
      }
      await assertOnlyAllowedChangesBetween({
        baseSha: currentSha,
        headSha: branchSha,
        allowedPaths,
      });
      const { data: generatedCommit } = await getGitCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha: branchSha,
      });
      const { data: mergeCommit } = await retryGitHubOperation(
        `git.createCommit ${branch} generated version-state merge`,
        () => octokit.rest.git.createCommit({
          owner,
          repo,
          message:
            protectedUpdate?.mergeMessage ||
            `${protectedUpdate?.title || "Apply generated version-state"}\n\n` +
              `Buildchain generated this merge commit to fast-forward ${branch} after ` +
              "the channel had diverged only by generated version-state files.",
          tree: generatedCommit.tree.sha,
          parents: [currentSha, branchSha],
          author: COMMIT_IDENTITY,
          committer: COMMIT_IDENTITY,
        }),
      );
      updates.push({
        ref: branch,
        action: "created-version-state-merge",
        sha: mergeCommit.sha,
        sourceSha: branchSha,
        currentSha,
        files: allowedPaths,
      });
      return mergeCommit.sha;
    };
    if (protectedUpdate && currentSha) {
      const createdCheck = await createGeneratedVersionStateCheck({
        octokit: statusCheckOctokit,
        owner,
        repo,
        branch,
        branchSha,
        currentSha,
        requiredStatusCheck,
      });
      if (createdCheck) {
        updates.push({
          ref: branch,
          action: "generated-status-check",
          check: requiredStatusCheck,
          sha: branchSha,
        });
      }
    }
    try {
      if (currentSha) {
        await branchWriteOctokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: branchSha,
          force: false,
        });
        updates.push({ ref: branch, action, sha: branchSha });
      } else {
        await branchWriteOctokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: branchSha,
        });
        updates.push({ ref: branch, action: "created", sha: branchSha });
      }
      if (!currentSha) {
        await ensureChannelProtection();
      }
      return { updated: true };
    } catch (error) {
      if (
        protectedUpdate?.allowMergeCommitOnNonFastForward &&
        currentSha &&
        nonFastForwardUpdateRejected(error)
      ) {
        const mergeSha = await createVersionStateMergeCommit();
        if (mergeSha) {
          const createdMergeCheck = await createGeneratedVersionStateCheck({
            octokit: statusCheckOctokit,
            owner,
            repo,
            branch,
            branchSha: mergeSha,
            currentSha,
            requiredStatusCheck,
          });
          if (createdMergeCheck) {
            updates.push({
              ref: branch,
              action: "generated-status-check",
              check: requiredStatusCheck,
              sha: mergeSha,
            });
          }
          await branchWriteOctokit.rest.git.updateRef({
            owner,
            repo,
            ref: `heads/${branch}`,
            sha: mergeSha,
            force: false,
          });
          updates.push({ ref: branch, action, sha: mergeSha });
          return { updated: true, mergeSha };
        }
      }
      if (protectedUpdate?.allowNonFastForwardSkip && nonFastForwardUpdateRejected(error)) {
        updates.push({
          ref: branch,
          action: "skipped-non-fast-forward",
          sha: branchSha,
          currentSha,
        });
        return { updated: false, skipped: true, currentSha };
      }
      if (
        protectedUpdate &&
        (protectedBranchUpdateRejected(error) || nonFastForwardUpdateRejected(error))
      ) {
        return openVersionStatePullRequest({ error });
      }
      if (!notFound(error)) {
        throw error;
      }
      await branchWriteOctokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: branchSha,
      });
      updates.push({ ref: branch, action: "created", sha: branchSha });
      await ensureChannelProtection();
      return { updated: true };
    }
  };

  const updateDefaultBranch = async (branch) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run-default-branch" });
      return;
    }
    if (typeof octokit.rest.repos?.update !== "function") {
      updates.push({ ref: branch, action: "skipped-default-branch-update-unavailable" });
      return;
    }
    await octokit.rest.repos.update({
      owner,
      repo,
      default_branch: branch,
    });
    updates.push({ ref: branch, action: "updated-default-branch" });
  };

  const assertOnlyAllowedChangesBetween = async ({ baseSha, headSha, allowedPaths }) => {
    const changedPaths = await listChangedPathsBetweenTrees({
      baseSha,
      headSha,
    });
    const unexpected = changedPaths.filter((file) => !allowedPaths.includes(file));
    if (unexpected.length > 0) {
      throw new Error(
        `Version-state PR changed files outside declared version state: ${unexpected.join(", ")}`,
      );
    }
  };

  const listChangedPathsBetweenTrees = async ({ baseSha, headSha }) => {
    const [baseCommitResult, headCommitResult] = await Promise.all([
      getGitCommitWithRetry({ octokit, owner, repo, commitSha: baseSha }),
      getGitCommitWithRetry({ octokit, owner, repo, commitSha: headSha }),
    ]);
    const [baseTreeResult, headTreeResult] = await Promise.all([
      retryGitHubOperation(
        `git.getTree ${baseSha} recursive`,
        () => octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: baseCommitResult.data.tree.sha,
          recursive: "1",
        }),
      ),
      retryGitHubOperation(
        `git.getTree ${headSha} recursive`,
        () => octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: headCommitResult.data.tree.sha,
          recursive: "1",
        }),
      ),
    ]);
    const toTreeMap = (tree) => {
      const entries = new Map();
      for (const entry of tree || []) {
        if (!entry?.path || entry.type === "tree") {
          continue;
        }
        entries.set(
          entry.path,
          `${entry.type || ""}:${entry.mode || ""}:${entry.sha || ""}`,
        );
      }
      return entries;
    };
    const baseEntries = toTreeMap(baseTreeResult.data.tree);
    const headEntries = toTreeMap(headTreeResult.data.tree);
    const paths = new Set([...baseEntries.keys(), ...headEntries.keys()]);
    return [...paths]
      .filter((file) => baseEntries.get(file) !== headEntries.get(file))
      .sort();
  };

  const assertOnlyAllowedReleaseRecoveryChangesBetween = async ({
    baseSha,
    headSha,
    allowedPaths = [],
  }) => {
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const changedPaths = (comparison.files || []).map((file) => file.filename);
    const unexpected = changedPaths.filter((file) => {
      if (allowedPaths.includes(file)) {
        return false;
      }
      return !RELEASE_LINE_RECOVERY_PATHS.some((allowedPath) =>
        allowedPath.endsWith("/") ? file.startsWith(allowedPath) : file === allowedPath,
      );
    });
    if (unexpected.length > 0) {
      throw new Error(
        `Release-line recovery PR changed files outside buildchain recovery scope: ${unexpected.join(", ")}`,
      );
    }
  };

  const findMatchingReleaseRecoveryPullRequest = async ({ commitSha, targetRef }) => {
    const { data: pullRequests } =
      await listPullRequestsAssociatedWithCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha,
      });
    return pullRequests.find((pullRequest) => {
      const baseRef = pullRequest.base?.ref;
      const headRef = pullRequest.head?.ref;
      const headRepo = pullRequest.head?.repo?.full_name;
      const recovery = parseReleaseLineRecoveryRef(headRef);
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        recovery?.targetRef === targetRef &&
        headRepo === `${owner}/${repo}`
      );
    });
  };

  const findMatchingTargetPullRequest = async ({ commitSha, targetRef }) => {
    const { data: pullRequests } =
      await listPullRequestsAssociatedWithCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha,
      });
    return pullRequests.find((pullRequest) => {
      const baseRef = pullRequest.base?.ref;
      const headRepo = pullRequest.head?.repo?.full_name;
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        headRepo === `${owner}/${repo}`
      );
    });
  };

  const findAlphaMaterialFromPromotionPullRequest = async ({ commitSha, targetRef, releasePrefix, patch }) => {
    if (typeof octokit.rest.repos?.listPullRequestsAssociatedWithCommit !== "function") {
      return undefined;
    }
    const pullRequest = await findMatchingTargetPullRequest({ commitSha, targetRef });
    const pullRequestHeadSha = pullRequest?.head?.sha;
    if (!pullRequestHeadSha) {
      return undefined;
    }
    for (const candidate of alphaTagsForPatch(lineRefs, releasePrefix, patch)) {
      if (!candidate.sha) {
        continue;
      }
      if (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: pullRequestHeadSha,
          transactionReleaseSha: candidate.sha,
        })
      ) {
        return {
          ...candidate,
          source: "promotion-pr-head",
          promotionPullRequestHeadSha: pullRequestHeadSha,
        };
      }
    }
    return undefined;
  };

  const assertPromotionPrOrVersionStateParent = async ({ commitSha, targetRef, allowedPaths }) => {
    try {
      await assertChannelPromotionPr({
        octokit,
        owner,
        repo,
        sha: commitSha,
        targetRef,
      });
      return;
    } catch (directError) {
      if (!allowedPaths?.length) {
        throw directError;
      }
      const { data: pullRequests } =
        await listPullRequestsAssociatedWithCommitWithRetry({
          octokit,
          owner,
          repo,
          commitSha,
        });
      const matchingVersionStatePullRequest = pullRequests.find((pullRequest) => {
        const baseRef = pullRequest.base?.ref;
        const headRef = pullRequest.head?.ref;
        const headRepo = pullRequest.head?.repo?.full_name;
        return (
          pullRequest.merged_at &&
          baseRef === targetRef &&
          parseVersionStateBranchName(headRef) === targetRef &&
          headRepo === `${owner}/${repo}`
        );
      });
      const commit = await getCommitInfo(octokit, owner, repo, commitSha);
      if (matchingVersionStatePullRequest) {
        for (const parentSha of commit.parents) {
          try {
            await assertOnlyAllowedChangesBetween({
              baseSha: parentSha,
              headSha: commitSha,
              allowedPaths,
            });
            return;
          } catch {
            // Try the next parent before surfacing the original lineage failure.
          }
        }
        throw directError;
      }
      for (const parentSha of commit.parents) {
        try {
          await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
          await assertOnlyAllowedChangesBetween({
            baseSha: parentSha,
            headSha: commitSha,
            allowedPaths,
          });
          return;
        } catch {
          // Try the next parent before surfacing the original lineage failure.
        }
      }
      throw directError;
    }
  };

  const assertReleasePrOrVersionStateParent = async ({
    commitSha,
    targetRef,
    alphaSha,
    alphaTag,
    alphaTreeSha,
    allowedPaths,
    allowDirectAllowedChanges = false,
  }) => {
    const commit = await getCommitInfo(octokit, owner, repo, commitSha);
    if (commit.treeSha === alphaTreeSha) {
      try {
        await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
      } catch (error) {
        const matchingReleaseRecoveryPullRequest =
          await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
        if (!matchingReleaseRecoveryPullRequest) {
          throw error;
        }
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
      }
      return;
    }
    if (allowDirectAllowedChanges && allowedPaths?.length) {
      let validPromotionPr = false;
      try {
        await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
        validPromotionPr = true;
        await assertOnlyAllowedChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      } catch (error) {
        if (validPromotionPr) {
          throw error;
        }
      }
      const matchingTargetPullRequest = await findMatchingTargetPullRequest({
        commitSha,
        targetRef,
      });
      if (matchingTargetPullRequest) {
        await assertOnlyAllowedChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
    }
    for (const parentSha of commit.parents) {
      const parent = await getCommitInfo(octokit, owner, repo, parentSha);
      if (parent.treeSha === alphaTreeSha) {
        try {
          await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
        } catch (error) {
          const matchingReleaseRecoveryPullRequest =
            await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef });
          if (!matchingReleaseRecoveryPullRequest) {
            throw error;
          }
          await assertOnlyAllowedReleaseRecoveryChangesBetween({
            baseSha: alphaSha,
            headSha: parentSha,
            allowedPaths,
          });
        }
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
      const matchingReleaseRecoveryPullRequest =
        await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef });
      if (matchingReleaseRecoveryPullRequest) {
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: parentSha,
          allowedPaths,
        });
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
    }
    const matchingReleaseRecoveryPullRequest =
      await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
    if (matchingReleaseRecoveryPullRequest) {
      await assertOnlyAllowedReleaseRecoveryChangesBetween({
        baseSha: alphaSha,
        headSha: commitSha,
        allowedPaths,
      });
      return;
    }
    throw new Error(
      `Release source ${commitSha} must have the same tree as ${alphaTag}, except declared version-state files`,
    );
  };

  const isSettledAlphaVersionState = async (selectedAlpha) => {
    if (!selectedAlpha?.exists || selectedAlpha.sha !== sha) {
      return false;
    }
    const devRef = `heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`;
    const [devSha, exactAlphaTagSha, floatingAlphaTagSha] = await Promise.all([
      readRefSha(devRef),
      readRefSha(`tags/${selectedAlpha.tag}`),
      readRefSha(`tags/${rule.alphaTag}`),
    ]);
    return (
      devSha === sha &&
      exactAlphaTagSha === sha &&
      floatingAlphaTagSha === sha
    );
  };

  const createVersionStateCommit = async ({ baseSha, version, message }) => {
    if (!versionState) {
      return {
        sha: baseSha,
        version,
        action: "disabled",
        files: [],
      };
    }

    const discovered = discoverVersionStateFiles(cwd);
    if (discovered.files.length === 0) {
      if (requireVersionState) {
        throw new Error("Strict promotion requires package version state");
      }
      updates.push({
        version,
        action: "skipped-no-version-state",
        packageManager: discovered.packageManager.name,
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "skipped-no-version-state",
        files: [],
        packageManager: discovered.packageManager,
      };
    }

    const discoveredPaths = discovered.files.map((file) => file.path);
    const versionStrategy = getVersionStrategy(discovered.config);
    const anchorManifest = loadConfiguredAnchorManifest(cwd, discovered.config);
    const strategyEnv = versionVerificationEnv(versionStrategy, anchorManifest, {
      generatedAt: promotionGeneratedAt,
      sourceSha: sha,
    });
    const manualNext =
      versionStrategy.strategy === "anchored" && versionStrategy.next === "manual";
    const configuredVersion = manualNext
      ? currentConfiguredVersion(discovered.files)
      : undefined;
    const publishVersion = manualNext ? configuredVersion || version : version;
    const hasVersionVerification =
      Boolean(
        verificationCommand ||
        getLifecycleStage(discovered.config, "verify") ||
        getLifecycleStage(discovered.config, "version-state") ||
        getLifecycleStage(discovered.config, "version_state"),
      );
    const anchoredReleaseTreePaths =
      manualNext && anchorManifest && hasVersionVerification
        ? uniquePaths([...discoveredPaths, anchorManifest.path])
        : discoveredPaths;
    const changedFiles = manualNext
      ? []
      : updateVersionStateContents(discovered.files, version);
    const changedPaths = changedFiles.map((file) => file.path);
    console.log(
      `> version state manager: ${discovered.packageManager.name} (${discovered.packageManager.reason})`,
    );
    console.log(
      `> version strategy: ${versionStrategy.strategy}/${versionStrategy.next}`,
    );
    if (anchorManifest) {
      console.log(`> anchor manifest: ${anchorManifest.path}`);
    }
    console.log(`> version state files: ${discoveredPaths.join(", ")}`);
    console.log(
      `> version state changes for ${version}: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
    );
    const createVerifiedVersionStateCommit = async (verifiedChangedFiles) => {
      const { data: baseCommit } = await getGitCommitWithRetry({ octokit, owner, repo, commitSha: baseSha });
      const tree = [];
      for (const file of verifiedChangedFiles) {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: "utf-8",
        });
        tree.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
      const { data: nextTree } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: baseCommit.tree.sha,
        tree,
      });
      const { data: nextCommit } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: nextTree.sha,
        parents: [baseSha],
        author: COMMIT_IDENTITY,
        committer: COMMIT_IDENTITY,
      });
      updates.push({
        version,
        action: "created-version-state",
        packageManager: discovered.packageManager.name,
        files: verifiedChangedFiles.map((file) => file.path),
        sha: nextCommit.sha,
      });
      return {
        sha: nextCommit.sha,
        version,
        action: "created",
        publishVersion,
        files: verifiedChangedFiles.map((file) => file.path),
        releaseTreeAllowedPaths: verifiedChangedFiles.map((file) => file.path),
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    };
    if (manualNext) {
      runVersionVerification({
        cwd,
        command: verificationCommand,
        loadedConfig: discovered.config,
        version,
        changedFiles: [],
        allowedPaths: discoveredPaths,
        env: strategyEnv,
      });
      updates.push({
        version,
        action: "anchored-manual-version-state",
        packageManager: discovered.packageManager.name,
        files: discoveredPaths,
        manifest: anchorManifest?.path,
        sha: baseSha,
        publishVersion,
      });
      return {
        sha: baseSha,
        version,
        action: "anchored-manual",
        publishVersion,
        files: discoveredPaths,
        releaseTreeAllowedPaths: anchoredReleaseTreePaths,
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }
    if (changedFiles.length === 0) {
      const verifiedChangedFiles = runVersionVerification({
        cwd,
        command: verificationCommand,
        loadedConfig: discovered.config,
        version,
        changedFiles: [],
        allowedPaths: discoveredPaths,
        env: strategyEnv,
      });
      if (verifiedChangedFiles.length > 0) {
        console.log(
          `> version state lifecycle changes for ${version}: ${verifiedChangedFiles.map((file) => file.path).join(", ")}`,
        );
        return createVerifiedVersionStateCommit(verifiedChangedFiles);
      }
      updates.push({
        version,
        action: "existing-version-state",
        packageManager: discovered.packageManager.name,
        files: discoveredPaths,
        sha: baseSha,
        publishVersion,
      });
      return {
        sha: baseSha,
        version,
        action: "existing",
        publishVersion,
        files: discoveredPaths,
        releaseTreeAllowedPaths: discoveredPaths,
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }

    if (dryRun) {
      updates.push({
        version,
        action: "dry-run-version-state",
        packageManager: discovered.packageManager.name,
        files: changedFiles.map((file) => file.path),
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "dry-run",
        publishVersion,
        files: changedFiles.map((file) => file.path),
        releaseTreeAllowedPaths: changedFiles.map((file) => file.path),
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }

    const verifiedChangedFiles = runVersionVerification({
      cwd,
      command: verificationCommand,
      loadedConfig: discovered.config,
      version,
      changedFiles,
      allowedPaths: discoveredPaths,
      env: strategyEnv,
    });

    return createVerifiedVersionStateCommit(verifiedChangedFiles);
  };

  const shouldPromoteMajorTag = async () => {
    try {
      await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/v${rule.major}.${rule.minor + 1}`,
      });
      return false;
    } catch (error) {
      if (notFound(error)) {
        return true;
      }
      throw error;
    }
  };

  let latestPublishTransaction;
  const executePublishTransaction = async ({
    version,
    exactTag,
    channel,
    line,
    releaseSha,
    allowVersionStateFinalization = false,
  }) => {
    const transactionVersion = version;
    if (dryRun && (publishTransaction || publishCommand || getLifecycleStage(loadBuildchainConfig(cwd), "publish"))) {
      updates.push({
        action: "dry-run-publish-transaction",
        version: transactionVersion,
        tag: exactTag,
        sha: releaseSha,
      });
      return undefined;
    }
    latestPublishTransaction = await runPublishTransaction({
      octokit,
      owner,
      repo,
      cwd,
      loadedConfig: loadBuildchainConfig(cwd),
      targetRef,
      sourceSha: sha,
      releaseSha,
      version: transactionVersion,
      exactTag,
      channel,
      line,
      publishTransaction,
      publishCommand,
      publishEvidencePath,
      transactionStatePath,
      publishRequiredArtifactsJson,
      releaseMaterialSha,
      publishToolingSha,
      publishMode,
      publishAuth,
      publishDistTag,
      publishPackageSetOrder,
      publishPackageMain,
      actor,
      runId,
      explicitOverride: publishTransactionOverride,
      allowVersionStateFinalization,
      promotionGeneratedAt,
    });
    if (latestPublishTransaction) {
      updates.push({
        action: "publish-transaction",
        version,
        tag: exactTag,
        sha: latestPublishTransaction.transaction.release_sha,
        state: latestPublishTransaction.transaction.state,
        transactionId: latestPublishTransaction.transaction.id,
        statePath: path.relative(cwd, latestPublishTransaction.statePath).split(path.sep).join("/"),
        evidencePath: path.relative(cwd, latestPublishTransaction.evidencePath).split(path.sep).join("/"),
        stateRef: latestPublishTransaction.transaction.state_ref,
        stateSha: latestPublishTransaction.durable?.sha,
      });
    }
    return latestPublishTransaction;
  };

  const markFinalizing = async () => {
    latestPublishTransaction = await beginTransactionFinalization(latestPublishTransaction, actor, runId);
  };

  const markComplete = async ({ channel, line } = {}) => {
    latestPublishTransaction = await completeTransactionFinalization(latestPublishTransaction, actor, runId);
    latestPublishTransaction = await collectAndPersistReleasePassport({
      result: latestPublishTransaction,
      owner,
      repo,
      cwd,
      sourceSha: sha,
      targetRef,
      channel: channel || rule.channel,
      line: line || rule.releasePrefix || "",
      packageName: publishPackageMain,
      outputDir: releasePassportOutputDir,
      productName: releasePassportProductName,
      buildSummaryPath: releasePassportBuildSummaryPath,
      platformManifestPaths: splitPathList(releasePassportPlatformManifestPaths),
      impactJson: releasePassportImpactJson,
      kfd1WitnessJsons: splitPathList(releasePassportKfd1WitnessJsons),
      kfd2ClaimJsons: splitPathList(releasePassportKfd2ClaimJsons),
      kfd3PrebuildWitnessJsons: splitPathList(releasePassportKfd3PrebuildWitnessJsons),
      kfd3ArtifactWitnessJsons: splitPathList(releasePassportKfd3ArtifactWitnessJsons),
      kfd3ArtifactVerifyCommand: releasePassportKfd3ArtifactVerifyCommand,
      buildchainSelfKfd: Boolean(releasePassportBuildchainSelfKfd),
      enabled: Boolean(releasePassport),
      releaseCandidateValidation,
    });
    if (latestPublishTransaction?.transaction) {
      const publicReleaseTag = latestPublishTransaction.publicReleaseTag ||
        publicReleaseTagForTransaction(latestPublishTransaction.transaction);
      if (
        publicReleaseTag &&
        publicReleaseTag !== latestPublishTransaction.transaction.exact_tag
      ) {
        await ensureTag(publicReleaseTag, latestPublishTransaction.transaction.release_sha);
      }
    }
    return latestPublishTransaction;
  };

  const withPublishTransaction = (result, extra = {}) => {
    if (!latestPublishTransaction) {
      return result;
    }
    return {
      ...result,
      publishTransaction: {
        id: latestPublishTransaction.transaction.id,
        state: latestPublishTransaction.transaction.state,
        failure: latestPublishTransaction.transaction.failure || "",
        exactTag: latestPublishTransaction.transaction.exact_tag,
        publicReleaseTag: latestPublishTransaction.publicReleaseTag ||
          publicReleaseTagForTransaction(latestPublishTransaction.transaction),
        releaseSha: latestPublishTransaction.transaction.release_sha,
        stateRef: latestPublishTransaction.transaction.state_ref,
        stateSha: latestPublishTransaction.durable?.sha,
        statePath: path.relative(cwd, latestPublishTransaction.statePath).split(path.sep).join("/"),
        evidencePath: path.relative(cwd, latestPublishTransaction.evidencePath).split(path.sep).join("/"),
        releasePassportPath: latestPublishTransaction.releasePassport?.passportPath
          ? path.relative(cwd, latestPublishTransaction.releasePassport.passportPath).split(path.sep).join("/")
          : "",
        releasePassportOutputDir: latestPublishTransaction.releasePassport?.outputDir
          ? path.relative(cwd, latestPublishTransaction.releasePassport.outputDir).split(path.sep).join("/")
          : "",
        releasePassportStateSha: latestPublishTransaction.releasePassport?.stateSha || "",
        ...extra,
      },
    };
  };

  if (requireGovernance && !dryRun) {
    await assertProtectedChannel({
      octokit,
      owner,
      repo,
      targetRef,
      requiredStatusCheck,
    });
  }

  if (rule.channel === "major") {
    const resolveMajorGateSource = async () => {
      try {
        return await getMajorGateSource({
          octokit,
          owner,
          repo,
          sha,
          targetRef,
        });
      } catch (directError) {
        const commit = await getCommitInfo(octokit, owner, repo, sha);
        for (const parentSha of commit.parents) {
          try {
            return await getMajorGateSource({
              octokit,
              owner,
              repo,
              sha: parentSha,
              targetRef,
            });
          } catch {
            // Try the next parent before surfacing the direct lineage failure.
          }
        }
        throw directError;
      }
    };
    const majorGate = await resolveMajorGateSource();
    const majorRule = {
      ...rule,
      ...majorGate,
      tags: [majorGate.majorTag, majorGate.minorTag],
    };
    const refs = await listLineRefs(majorRule.releasePrefix);
    const explicitReleaseTags = requestedTags
      ? requestedTags.filter(
          (tag) =>
            !tag.includes("-alpha.") &&
            tag.startsWith(`${majorRule.releasePrefix}.`),
        )
      : [];
    if (explicitReleaseTags.length > 1) {
      throw new Error("publish-gate/major promotion accepts at most one explicit release tag");
    }
    const selectedRelease = explicitReleaseTags[0]
      ? {
          tag: explicitReleaseTags[0],
          patch: Number(explicitReleaseTags[0].split(".").pop()),
        }
      : selectReleaseTag({
          refs,
          releasePrefix: majorRule.releasePrefix,
          sha,
        });
    if (selectedRelease.patch !== 0) {
      throw new Error(
        `publish-gate/major promotion must create the first patch of the next major line; got ${selectedRelease.tag}`,
      );
    }
    const releaseVersion = stripTagPrefix(selectedRelease.tag);
    const releaseCommit = await createVersionStateCommit({
      baseSha: sha,
      version: releaseVersion,
      message: `chore(release): release ${selectedRelease.tag}`,
    });
    const releaseSha = releaseCommit.sha;
    if (requireGovernance && !dryRun) {
      if (releaseCommit.action === "existing") {
        await assertPromotionPrOrVersionStateParent({
          commitSha: sha,
          targetRef,
          allowedPaths: releaseCommit.files,
        });
      }
    }
    await executePublishTransaction({
      version: releaseCommit.publishVersion || releaseVersion,
      exactTag: selectedRelease.tag,
      channel: majorRule.channel || "major",
      line: majorRule.releasePrefix,
      releaseSha,
      allowVersionStateFinalization: releaseCommit.action === "existing",
    });
    if (versionState) {
      await markFinalizing();
      const gateUpdate = await updateBranch(targetRef, releaseSha, "updated", {
        title: `Release ${selectedRelease.tag}`,
        body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
        allowPendingPullRequest: true,
      });
      if (gateUpdate.pending) {
        return withPublishTransaction({
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          targetRef,
          pendingPullRequest: gateUpdate.pullRequest.html_url || gateUpdate.pullRequest.url,
          updates,
        }, { finalizationNeeded: true });
      }
      const releaseBranchUpdate = await updateBranch(`release/v${majorRule.major}/v${majorRule.major}.0`, releaseSha, "updated", {
        title: `Release ${selectedRelease.tag}`,
        body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
        allowPendingPullRequest: true,
      });
      if (releaseBranchUpdate.pending) {
        return withPublishTransaction({
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          targetRef,
          pendingPullRequest:
            releaseBranchUpdate.pullRequest.html_url || releaseBranchUpdate.pullRequest.url,
          updates,
        }, { finalizationNeeded: true });
      }
    }
    await markFinalizing();
    await ensureTag(selectedRelease.tag, releaseSha);
    await updateTag(majorRule.minorTag, releaseSha);
    await updateTag(majorRule.majorTag, releaseSha);
    await markComplete({ channel: majorRule.channel || "major", line: majorRule.releasePrefix });

    if (releaseCommit.versionStrategy?.next === "manual") {
      updates.push({
        ref: `dev/v${majorRule.major}/v${majorRule.major}.0`,
        action: "next-anchor-required",
        versionStrategy: releaseCommit.versionStrategy.strategy,
        manifest: releaseCommit.anchorManifest?.path,
        sha: releaseSha,
      });
      return withPublishTransaction({
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        nextAlphaRequired: true,
        targetRef,
        updates,
      });
    }

    const explicitAlphaTags = requestedTags
      ? requestedTags.filter((tag) => tag.includes("-alpha."))
      : [];
    if (explicitAlphaTags.length > 1) {
      throw new Error(
        "publish-gate/major promotion accepts at most one explicit next-alpha tag",
      );
    }
    const selectedNextAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : selectAlphaTag({
          refs,
          releasePrefix: majorRule.releasePrefix,
          sha: releaseSha,
          patchAfterRelease: 1,
        });
    const nextAlphaVersion = stripTagPrefix(selectedNextAlpha.tag);
    let nextAlphaSha = versionState ? selectedNextAlpha.sha : sha;
    if (versionState && selectedNextAlpha.exists && nextAlphaSha) {
      updates.push({
        version: nextAlphaVersion,
        action: "existing-version-state",
        sha: nextAlphaSha,
      });
    } else if (versionState) {
      const nextAlphaRef = `alpha/v${majorRule.major}/v${majorRule.major}.0`;
      const nextAlphaBaseSha = await readRefSha(`heads/${nextAlphaRef}`) || releaseSha;
      const nextAlphaCommit = await createVersionStateCommit({
        baseSha: nextAlphaBaseSha,
        version: nextAlphaVersion,
        message: `chore(release): prepare ${selectedNextAlpha.tag}`,
      });
      nextAlphaSha = nextAlphaCommit.sha;
    }
    if (versionState) {
      const nextAlphaUpdate = await updateBranch(`alpha/v${majorRule.major}/v${majorRule.major}.0`, nextAlphaSha, "updated", {
        title: `Prepare ${selectedNextAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
        allowPendingPullRequest: true,
      });
      if (nextAlphaUpdate.pending) {
        return withPublishTransaction({
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          nextAlphaSha,
          targetRef,
          pendingPullRequest:
            nextAlphaUpdate.pullRequest.html_url || nextAlphaUpdate.pullRequest.url,
          updates,
        }, { finalizationNeeded: true });
      }
      const nextDevRef = `dev/v${majorRule.major}/v${majorRule.major}.0`;
      await updateBranch(nextDevRef, nextAlphaSha, "updated", {
        title: `Prepare ${selectedNextAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
      });
      await updateDefaultBranch(nextDevRef);
    }
    await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
    await updateTag(majorRule.alphaTag, nextAlphaSha);
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaSha,
      targetRef,
      updates,
    });
  }

  const lineRefs = await listLineRefs();

  if (rule.channel === "alpha") {
    const explicitAlphaTags = requestedTags
      ? requestedTags.filter((tag) => tag.includes("-alpha."))
      : [];
    if (explicitAlphaTags.length > 1) {
      throw new Error(
        "Alpha promotion accepts at most one explicit prerelease tag",
      );
    }
    const currentAlpha = explicitAlphaTags[0]
      ? undefined
      : currentAlphaVersionState({
          cwd,
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
        });
    const currentAlphaTransaction = currentAlpha
      ? await readDurableTransactionForVersion({
          octokit,
          owner,
          repo,
          version: currentAlpha.version,
        })
      : undefined;
    const publishTransactionEnabled = Boolean(
      publishTransaction ||
      publishCommand ||
      getLifecycleStage(loadBuildchainConfig(cwd), "publish")
    );
    const resumableAlpha = explicitAlphaTags[0] || !publishTransactionEnabled
      ? undefined
      : await resumableAlphaTransactionState({
          octokit,
          owner,
          repo,
          cwd,
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          targetRef,
          sourceSha: sha,
        });
    const currentAlphaTagSha = currentAlpha
      ? await readRefSha(`tags/${currentAlpha.tag}`)
      : undefined;
    const currentAlphaFloatingSha = currentAlpha
      ? await readRefSha(`tags/${rule.alphaTag}`)
      : undefined;
    const currentAlphaDevSha = currentAlpha
      ? await readRefSha(`heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`)
      : undefined;
    const currentAlphaAcceptedExactShas = transactionAcceptedExactTagShas(
      currentAlphaTransaction,
      sha,
    );
    const currentAlphaSettled =
      currentAlpha &&
      currentAlphaDevSha === sha &&
      currentAlphaFloatingSha === sha &&
      currentAlphaTagSha &&
      currentAlphaAcceptedExactShas.includes(currentAlphaTagSha);
    const currentAlphaHasFinalizationRefs =
      currentAlpha && Boolean(currentAlphaTagSha || currentAlphaFloatingSha || currentAlphaDevSha);
    const currentAlphaTransactionOpen =
      currentAlphaTransaction &&
      !["complete", "abandoned", "failed_permanently"].includes(currentAlphaTransaction.state);
    const currentAlphaContainsTransaction =
      currentAlphaTransactionOpen &&
      (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sha,
          transactionReleaseSha: currentAlphaTransaction.release_sha,
        }) ||
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sha,
          transactionReleaseSha: currentAlphaTransaction.release_material_sha,
        })
      );
    const currentAlphaCanReplaceStaleTransaction =
      currentAlphaTransactionOpen &&
      !currentAlphaContainsTransaction &&
      !transactionHasPublishedMaterial(currentAlphaTransaction);
    const currentAlphaCanFinalize =
      currentAlpha &&
      (
        !currentAlphaTransactionOpen ||
        currentAlphaContainsTransaction ||
        currentAlphaSettled ||
        currentAlphaCanReplaceStaleTransaction
      );
    let selectedAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : currentAlphaTransactionOpen && currentAlphaContainsTransaction && !currentAlphaSettled
        ? currentAlpha
      : currentAlpha && currentAlphaCanFinalize && currentAlphaHasFinalizationRefs && !currentAlphaTagSha
        ? currentAlpha
      : resumableAlpha
        ? resumableAlpha
      : currentAlphaTransactionOpen && currentAlpha && currentAlphaContainsTransaction && !currentAlphaTagSha
        ? currentAlpha
      : selectAlphaTag({
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          sha,
        });
    const settledAlphaVersionState = await isSettledAlphaVersionState(selectedAlpha);
    if (settledAlphaVersionState) {
      updates.push({ ref: targetRef, action: "already-promoted", sha });
      updates.push({
        ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
        action: "already-promoted",
        sha,
      });
      updates.push({ tag: selectedAlpha.tag, action: "existing", sha });
      updates.push({ tag: rule.alphaTag, action: "existing", sha });
      return { owner, repo, sourceSha: sha, sha, targetRef, updates };
    }
    const prepareAlphaCommit = async (candidate) => {
      const version = stripTagPrefix(candidate.tag);
      if (candidate.transaction?.release_sha) {
        return {
          version,
          publishVersion: version,
          commit: { action: "existing-publish-transaction", files: [] },
          sha: candidate.transaction.release_sha,
        };
      }
      const commit = await createVersionStateCommit({
        baseSha: sha,
        version,
        message: `chore(release): prepare ${candidate.tag}`,
      });
      if (requireGovernance && !dryRun) {
        await assertPromotionPrOrVersionStateParent({
          commitSha: sha,
          targetRef,
          allowedPaths: commit.files,
        });
      }
      return { version, publishVersion: commit.publishVersion || version, commit, sha: commit.sha };
    };
    let alpha = await prepareAlphaCommit(selectedAlpha);
    try {
      await executePublishTransaction({
        version: alpha.publishVersion || alpha.version,
        exactTag: selectedAlpha.tag,
        channel: rule.channel,
        line: rule.releasePrefix,
        releaseSha: alpha.sha,
        allowVersionStateFinalization:
          currentAlpha &&
          selectedAlpha.tag === currentAlpha.tag &&
          alpha.commit.action === "existing",
      });
    } catch (error) {
      const staleCurrentAlpha =
          currentAlpha &&
          selectedAlpha.tag === currentAlpha.tag &&
          /release transaction identity mismatch/.test(error.message || "");
      if (!staleCurrentAlpha) {
        throw error;
      }
      updates.push({
        tag: selectedAlpha.tag,
        action: "stale-publish-transaction",
        sha: alpha.sha,
      });
      selectedAlpha = selectAlphaTag({
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        sha,
      });
      alpha = await prepareAlphaCommit(selectedAlpha);
      await executePublishTransaction({
        version: alpha.publishVersion || alpha.version,
        exactTag: selectedAlpha.tag,
        channel: rule.channel,
        line: rule.releasePrefix,
        releaseSha: alpha.sha,
      });
    }
    if (versionState) {
      await markFinalizing();
      const targetUpdate = await updateBranch(targetRef, alpha.sha, "updated", {
        title: `Prepare ${selectedAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
      });
      if (targetUpdate.pending) {
        return withPublishTransaction({
          owner,
          repo,
          sourceSha: sha,
          sha: alpha.sha,
          targetRef,
          pendingPullRequest: targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
          updates,
        }, { finalizationNeeded: true });
      }
      await updateBranch(
        `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
        alpha.sha,
        "updated",
        {
          title: `Prepare ${selectedAlpha.tag}`,
          body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
          allowNonFastForwardSkip: true,
        },
      );
    }
    await markFinalizing();
    await ensureTag(selectedAlpha.tag, alpha.sha, {
      acceptedExistingShas: transactionAcceptedExactTagShas(
        latestPublishTransaction?.transaction || currentAlphaTransaction,
        alpha.sha,
      ),
      acceptedExistingMaterialShas: transactionAcceptedExactTagShas(
        latestPublishTransaction?.transaction || currentAlphaTransaction,
        "",
      ),
    });
    await updateTag(rule.alphaTag, alpha.sha);
    await markComplete();
    return withPublishTransaction({ owner, repo, sourceSha: sha, sha: alpha.sha, targetRef, updates });
  }

  const explicitReleaseTags = requestedTags
    ? requestedTags.filter(
        (tag) =>
          !tag.includes("-alpha.") && tag.startsWith(`${rule.releasePrefix}.`),
      )
    : [];
  if (explicitReleaseTags.length > 1) {
    throw new Error("Release promotion accepts at most one explicit patch tag");
  }
  const selectedRelease = explicitReleaseTags[0]
    ? {
        tag: explicitReleaseTags[0],
        patch: Number(explicitReleaseTags[0].split(".").pop()),
      }
    : undefined;
  const resumableRelease = selectedRelease
    ? undefined
    : await resumableReleaseTransactionState({
        octokit,
        owner,
        repo,
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        targetRef,
        sourceSha: sha,
      });
  const currentRelease = selectedRelease
    ? undefined
    : resumableRelease || currentReleaseVersionState({
        cwd,
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
      });
  const currentReleaseTransaction = currentRelease
    ? currentRelease.transaction ||
      await readDurableTransactionForVersion({
        octokit,
        owner,
        repo,
        version: currentRelease.version,
      })
    : undefined;
  const currentReleaseExactSha = currentRelease
    ? await readRefSha(`tags/${currentRelease.tag}`)
    : undefined;
  const currentReleaseMinorSha = currentRelease
    ? await readRefSha(`tags/${rule.minorTag}`)
    : undefined;
  const currentReleaseMajorSha = currentRelease
    ? await readRefSha(`tags/${rule.majorTag}`)
    : undefined;
  const currentReleaseAcceptedExactShas = transactionAcceptedExactTagShas(
    currentReleaseTransaction,
    sha,
  );
  const currentReleaseSettled =
    currentRelease &&
    currentReleaseMinorSha === sha &&
    currentReleaseMajorSha === sha &&
    currentReleaseExactSha &&
    currentReleaseAcceptedExactShas.includes(currentReleaseExactSha);
  const selectedReleaseCandidate = selectedRelease ||
    (currentRelease && !currentReleaseSettled
      ? currentRelease
      : selectReleaseTag({
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          sha,
        }));
  const sourceAlpha = latestAlphaForPatch(
    lineRefs,
    rule.releasePrefix,
    selectedReleaseCandidate.patch,
  );
  let sourceAlphaMaterial = await findAlphaMaterialFromPromotionPullRequest({
    commitSha: sha,
    targetRef,
    releasePrefix: rule.releasePrefix,
    patch: selectedReleaseCandidate.patch,
  }) || sourceAlpha;
  if (currentReleaseTransaction?.source_sha) {
    for (const candidate of alphaTagsForPatch(lineRefs, rule.releasePrefix, selectedReleaseCandidate.patch)) {
      if (!candidate.sha) {
        continue;
      }
      if (await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha: currentReleaseTransaction.source_sha,
        transactionReleaseSha: candidate.sha,
      })) {
        sourceAlphaMaterial = candidate;
        break;
      }
    }
  }
  const floatingAlphaSha = sourceAlpha?.sha
    ? await readRefSha(`tags/${rule.alphaTag}`)
    : undefined;
  if (sourceAlpha?.sha && floatingAlphaSha && floatingAlphaSha !== sourceAlpha.sha) {
    const floatingContainsExact = await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: floatingAlphaSha,
      transactionReleaseSha: sourceAlpha.sha,
    });
    const targetContainsFloating = await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: sha,
      transactionReleaseSha: floatingAlphaSha,
    });
    if (floatingContainsExact && targetContainsFloating) {
      sourceAlphaMaterial = {
        ...sourceAlpha,
        tag: rule.alphaTag,
        exactTag: sourceAlpha.tag,
        sha: floatingAlphaSha,
      };
    }
  }
  const releaseVersion = stripTagPrefix(selectedReleaseCandidate.tag);
  const releaseCommit = await createVersionStateCommit({
    baseSha: sha,
    version: releaseVersion,
    message: `chore(release): release ${selectedReleaseCandidate.tag}`,
  });
  const releaseSha = releaseCommit.sha;
  if (requireGovernance && !dryRun) {
    if (!sourceAlpha?.sha) {
      throw new Error(
        `Release promotion requires an existing ${rule.releasePrefix}.${selectedReleaseCandidate.patch}-alpha.N tag`,
      );
    }
    const alphaCommit = await getCommitInfo(octokit, owner, repo, sourceAlphaMaterial.sha);
    const releaseTreeAllowedPaths =
      releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
    await assertReleasePrOrVersionStateParent({
      commitSha: releaseSha,
      targetRef,
      alphaSha: sourceAlphaMaterial.sha,
      alphaTag: sourceAlphaMaterial.tag,
      alphaTreeSha: alphaCommit.treeSha,
      allowedPaths: releaseTreeAllowedPaths,
      allowDirectAllowedChanges:
        releaseCommit.action === "anchored-manual" &&
        releaseCommit.versionStrategy?.strategy === "anchored" &&
        releaseCommit.versionStrategy?.next === "manual" &&
        releaseCommit.files.length > 0 &&
        Boolean(releaseCommit.anchorManifest) &&
        releaseCommit.hasVersionVerification,
    });
  }
  await executePublishTransaction({
    version: releaseCommit.publishVersion || releaseVersion,
    exactTag: selectedReleaseCandidate.tag,
    channel: rule.channel,
    line: rule.releasePrefix,
    releaseSha,
    allowVersionStateFinalization: releaseCommit.action === "existing",
  });
  if (versionState) {
    await markFinalizing();
    const targetUpdate = await updateBranch(targetRef, releaseSha, "updated", {
      title: `Release ${selectedReleaseCandidate.tag}`,
      body: `Create the generated version-state commit for ${selectedReleaseCandidate.tag}.`,
      allowPendingPullRequest: true,
    });
    if (targetUpdate.pending) {
      return withPublishTransaction({
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        targetRef,
        pendingPullRequest: targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
        updates,
      }, { finalizationNeeded: true });
    }
  }
  await markFinalizing();
  await ensureTag(selectedReleaseCandidate.tag, releaseSha, {
    acceptedExistingShas: transactionAcceptedExactTagShas(
      latestPublishTransaction?.transaction || currentReleaseTransaction,
      releaseSha,
    ),
    acceptedExistingMaterialShas: transactionAcceptedExactTagShas(
      latestPublishTransaction?.transaction || currentReleaseTransaction,
      "",
    ),
  });
  await updateTag(rule.minorTag, releaseSha);
  const ownsMajorFloatingTag = await shouldPromoteMajorTag();
  if (ownsMajorFloatingTag) {
    await updateTag(rule.majorTag, releaseSha);
  } else {
    updates.push({
      tag: rule.majorTag,
      action: "skipped-next-minor-exists",
      sha: releaseSha,
    });
  }
  await markComplete();

  if (releaseCommit.versionStrategy?.next === "manual") {
    if (ownsMajorFloatingTag) {
      await updateDefaultBranch(`dev/v${rule.major}/v${rule.major}.${rule.minor}`);
    }
    updates.push({
      ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
      action: "next-anchor-required",
      versionStrategy: releaseCommit.versionStrategy.strategy,
      manifest: releaseCommit.anchorManifest?.path,
      sha: releaseSha,
    });
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaRequired: true,
      targetRef,
      updates,
    });
  }

  const explicitAlphaTags = requestedTags
    ? requestedTags.filter((tag) => tag.includes("-alpha."))
    : [];
  if (explicitAlphaTags.length > 1) {
    throw new Error(
      "Release promotion accepts at most one explicit next-alpha tag",
    );
  }
  const selectedNextAlpha = explicitAlphaTags[0]
    ? { tag: explicitAlphaTags[0] }
    : selectAlphaTag({
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        sha: releaseSha,
        patchAfterRelease: selectedReleaseCandidate.patch + 1,
      });
  const nextAlphaVersion = stripTagPrefix(selectedNextAlpha.tag);
  let nextAlphaSha = versionState ? selectedNextAlpha.sha : sha;
  let nextAlphaVersionStateFiles = [];
  if (versionState && selectedNextAlpha.exists && nextAlphaSha) {
    updates.push({
      version: nextAlphaVersion,
      action: "existing-version-state",
      sha: nextAlphaSha,
    });
  } else if (versionState) {
    const nextAlphaCommit = await createVersionStateCommit({
      baseSha: releaseSha,
      version: nextAlphaVersion,
      message: `chore(release): prepare ${selectedNextAlpha.tag}`,
    });
    nextAlphaSha = nextAlphaCommit.sha;
    nextAlphaVersionStateFiles = nextAlphaCommit.files || [];
  }
  if (versionState) {
    const nextDevRef = `dev/v${rule.major}/v${rule.major}.${rule.minor}`;
    if (ownsMajorFloatingTag) {
      await updateDefaultBranch(nextDevRef);
    }
    const nextAlphaRef = `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
    const nextAlphaUpdate = await updateBranch(nextAlphaRef, nextAlphaSha, "updated", {
      title: `Prepare ${selectedNextAlpha.tag}`,
      body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
      allowPendingPullRequest: true,
      allowMergeCommitOnNonFastForward: true,
      allowMergeCommitOnNonFastForwardPaths: nextAlphaVersionStateFiles,
    });
    if (nextAlphaUpdate.pending) {
      return withPublishTransaction({
        owner,
        repo,
        sourceSha: sha,
        sha: releaseSha,
        nextAlphaSha,
        targetRef,
        pendingPullRequest:
          nextAlphaUpdate.pullRequest.html_url || nextAlphaUpdate.pullRequest.url,
        updates,
      });
    }
    if (nextAlphaUpdate.mergeSha) {
      nextAlphaSha = nextAlphaUpdate.mergeSha;
    }
    await updateBranch(nextDevRef, nextAlphaSha, "updated", {
      title: `Prepare ${selectedNextAlpha.tag}`,
      body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
      allowMergeCommitOnNonFastForward: true,
      allowMergeCommitOnNonFastForwardPaths: nextAlphaVersionStateFiles,
    });
  }
  await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
  await updateTag(rule.alphaTag, nextAlphaSha);
  return withPublishTransaction({
    owner,
    repo,
    sourceSha: sha,
    sha: releaseSha,
    nextAlphaSha,
    targetRef,
    updates,
  });
}

export {
  DEFAULT_REPOSITORY,
  assertChannelPromotionPr,
  assertAllowedLocalChanges,
  assertProtectedChannel,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  discoverVersionStateFiles,
  expectedHeadRefForTarget,
  getPromotionRule,
  latestAlphaForPatch,
  parseReleaseLineRef,
  parseAlphaPrereleaseTag,
  parseRepository,
  parseReleasePatchTag,
  parseTags,
  promoteBuildchainRefs,
  persistDurableReleaseTransaction,
  readDurableReleaseTransaction,
  restoreDurableReleaseTransaction,
  resolveTagsForTarget,
  runVersionVerification,
  selectAlphaTag,
  selectReleaseTag,
  stripTagPrefix,
  updateVersionStateContents,
  validatePromotionReleaseCandidate,
};

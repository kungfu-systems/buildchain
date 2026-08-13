import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import {
  discoverConfiguredDerivedVersionMaterial,
  getLifecycleStage,
  getPublishContract,
  getVersionStrategy,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  runLifecycleStage,
} from "../../packages/core/buildchain-config.js";
import { spawnSyncCommand } from "../../packages/core/spawn-command.js";
import {
  DEFAULT_REPOSITORY,
  LEGACY_MAJOR_GATE_REF,
  MAJOR_GATE_REF,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  expectedHeadRefForTarget,
  getPromotionRule,
  isAllowedReleaseLineRecoveryPath,
  parsePublishGateChannelRef,
  parseReleaseLineRecoveryRef,
  parseReleaseLineRef,
  parseRepository,
  parseTags,
  stripTagPrefix,
} from "./internal/promotion-policy.js";
import {
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
} from "./internal/version-state.js";
import {
  collectRemoteVersionMaterial,
  getGitCommitWithRetry,
  getGitRefOrUndefined,
  listPullRequestsAssociatedWithCommitWithRetry,
  nonFastForwardUpdateRejected,
  notFound,
  retryGitHubOperation,
} from "./internal/github-adapter.js";
import {
  persistDurableReleaseTransaction,
  readDurableReleaseTransaction,
  restoreDurableReleaseTransaction,
} from "./internal/durable-transaction-store.js";
import {
  attachReleaseTransactionSealedBundle,
  assertTransactionIdentity,
  createReleaseTransaction,
  defaultPublishEvidencePath,
  defaultReleaseStatePath,
  planArtifactPublish,
  releaseTransactionStateRef,
  parsePublishArtifactsJson,
  planTransactionRecovery,
  readPublishEvidence,
  readReleaseTransaction,
  recordReleaseTransactionMilestone,
  releaseTransactionPublicationState,
  transitionReleaseTransaction,
  validatePublishEvidence,
  resolvePublishArtifactRequirements,
  writeReleaseTransaction,
} from "../../packages/core/publish-transaction.js";
import { verifyPublicationSealedBundle } from "../../packages/core/publication-sealed-bundle.js";
import {
  collectGitHubReleasePassport,
  verifyReleasePassport,
} from "../../packages/core/release-passport.js";
import { validateReleaseCandidatePassport } from "../../packages/core/release-candidate.js";
import { validateReleaseCandidateRecoveryReceipt } from "../../packages/core/release-candidate-recovery.js";
import { verifyPublicationQualificationReceipt } from "../../packages/core/publication-authority.js";
import {
  createBuildchainKfd1Witness,
  createBuildchainKfd2Claims,
  createBuildchainKfd3ArtifactWitness,
  createBuildchainKfd3PrebuildWitness,
} from "../../packages/core/buildchain-kfd-claims.js";
import {
  BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
  BUILDCHAIN_KFD2_CLAIMS_DIR,
  BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH,
  BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH,
} from "../../packages/core/buildchain-layout.js";
import { promoteMajorChannel } from "./internal/promote-major-channel.js";
import { promoteAlphaChannel } from "./internal/promote-alpha-channel.js";
import { promoteReleaseChannel } from "./internal/promote-release-channel.js";
import { createVersionStateOperations as createVersionStateOperationsModule } from "./internal/version-state-operations.js";
import { createDurableTransactionOperations as createDurableTransactionOperationsModule } from "./internal/durable-transaction-operations.js";

const COMMIT_IDENTITY = {
  name: "Keren Dong",
  email: "keren.dong@kungfu.link",
};
const COMMIT_SIGN_OFF = `Signed-off-by: ${COMMIT_IDENTITY.name} <${COMMIT_IDENTITY.email}>`;
const GITHUB_ACTIONS_APP_ID = 15368;

function createVersionStateOperations(context) {
  return createVersionStateOperationsModule({
    ...context,
    COMMIT_IDENTITY,
    alignMajorBootstrapReleaseImpact,
    currentConfiguredVersion,
    discoverConfiguredDerivedVersionMaterial,
    discoverVersionStateFiles,
    getGitCommitWithRetry,
    getGitRefOrUndefined,
    getLifecycleStage,
    getVersionStrategy,
    loadConfiguredAnchorManifest,
    runVersionVerification,
    sha256Content,
    signedGeneratedCommitMessage,
    uniquePaths,
    updateVersionStateContents,
    versionVerificationAllowedPathsForPromotion,
    versionVerificationEnv,
  });
}

function createDurableTransactionOperations(context) {
  return createDurableTransactionOperationsModule({
    ...context,
    assertExpectedPublicationVersion,
    beginTransactionFinalization,
    collectAndPersistReleasePassport,
    completeTransactionFinalization,
    getLifecycleStage,
    loadBuildchainConfig,
    path,
    publicReleaseTagForTransaction,
    releaseTagForPublishedVersion,
    releaseTransactionPublicationState,
    runPublishTransaction,
    splitPathList,
  });
}

function signedGeneratedCommitMessage(message) {
  const normalized = String(message || "").trimEnd();
  if (normalized.split("\n").some((line) => line.trim() === COMMIT_SIGN_OFF)) {
    return normalized;
  }
  return `${normalized}\n\n${COMMIT_SIGN_OFF}`;
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

function rematerializedNpmPackEnvironment({ cwd, env, version }) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) return undefined;
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const required = JSON.parse(env.BUILDCHAIN_REQUIRED_ARTIFACTS || "[]");
  const requiredNpm = required.filter((artifact) => artifact.kind === "npm");
  if (requiredNpm.length === 0) return undefined;
  if (!requiredNpm.some((artifact) => artifact.name === pkg.name)) {
    throw new Error(`rematerialized npm package does not match required artifacts: ${pkg.name}`);
  }
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-rematerialized-npm-"));
  try {
    const packed = JSON.parse(execNpmSync(["pack", "--json", "--pack-destination", temporaryRoot, "--registry=https://registry.npmjs.org/"], {
      cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    }));
    const result = Array.isArray(packed) ? packed[0] : packed;
    if (!result?.filename) throw new Error("rematerialized npm pack did not return a filename");
    if (result.name !== pkg.name || result.version !== version) {
      throw new Error(
        `rematerialized npm pack identity mismatch: expected ${pkg.name}@${version}, got ${result.name || ""}@${result.version || ""}`,
      );
    }
    const tarballPath = path.join(temporaryRoot, result.filename);
    const bytes = fs.readFileSync(tarballPath);
    return { temporaryRoot, env: {
      ...env,
      BUILDCHAIN_SEALED_BUNDLE_ROOT: "",
      BUILDCHAIN_SEALED_NPM_TARBALL: tarballPath,
      BUILDCHAIN_SEALED_NPM_INTEGRITY: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
      BUILDCHAIN_SEALED_NPM_SHA256: crypto.createHash("sha256").update(bytes).digest("hex"),
    } };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function runRematerializedPublishCommand({ cwd, command, loadedConfig, env, version }) {
  const discovered = discoverVersionStateFiles(cwd);
  const changedFiles = updateVersionStateContents(discovered.files, version);
  const originals = changedFiles.map((file) => {
    const resolved = path.resolve(cwd, file.path);
    return {
      resolved,
      content: fs.readFileSync(resolved),
    };
  });
  try {
    for (const [index, file] of changedFiles.entries()) {
      fs.writeFileSync(originals[index].resolved, file.content);
    }
    const npmPack = rematerializedNpmPackEnvironment({ cwd, env, version });
    const sealedEnvironmentNames = [
          "BUILDCHAIN_SEALED_BUNDLE_ROOT",
          "BUILDCHAIN_SEALED_NPM_TARBALL",
          "BUILDCHAIN_SEALED_NPM_INTEGRITY",
          "BUILDCHAIN_SEALED_NPM_SHA256",
        ];
    const previousSealedEnvironment = npmPack
      ? Object.fromEntries(sealedEnvironmentNames.map((name) => [name, process.env[name]]))
      : undefined;
    try {
      if (npmPack) {
        Object.assign(
          process.env,
          Object.fromEntries(sealedEnvironmentNames.map((name) => [name, npmPack.env[name]])),
        );
      }
      return runPublishCommand({ cwd, command, loadedConfig, env: npmPack?.env || env });
    } finally {
      for (const [name, value] of Object.entries(previousSealedEnvironment || {})) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (npmPack?.temporaryRoot) fs.rmSync(npmPack.temporaryRoot, { recursive: true, force: true });
    }
  } finally {
    for (const original of originals) {
      fs.writeFileSync(original.resolved, original.content);
    }
  }
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

function releaseLineMajor(line) {
  const match = String(line || "").match(/^v(\d+)\.\d+$/);
  return match ? Number(match[1]) : undefined;
}

function alphaDistTagForPromotion({
  ownsMajorAlphaTag,
  line,
  publishDistTag = "",
  sharedAlphaAuthorityMajor,
} = {}) {
  const major = releaseLineMajor(line);
  if (major === undefined) {
    throw new Error(
      `alpha publication requires a vN.N release line; got ${line || "<empty>"}`,
    );
  }
  const ownsSharedAlphaAuthority =
    ownsMajorAlphaTag &&
    (!sharedAlphaAuthorityMajor || major === sharedAlphaAuthorityMajor);
  if (ownsSharedAlphaAuthority) {
    return publishDistTag;
  }
  if (publishDistTag === "alpha") {
    throw new Error(
      `shared npm alpha authority belongs to v${sharedAlphaAuthorityMajor}; ${line} must use its line-specific dist-tag`,
    );
  }
  return publishDistTag || `${line}-alpha`;
}

function resolvePublishContract({
  loadedConfig,
  channel,
  line = "",
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
  const sharedAlphaAuthorityMajor = configured.sharedAlphaAuthorityMajor;
  if (!["publish-final-version", "promote-existing-version"].includes(mode)) {
    throw new Error("publish mode must be one of publish-final-version or promote-existing-version",
    );
  }
  if (!["trusted-publishing", "npm-token"].includes(auth)) {
    throw new Error("publish auth must be one of trusted-publishing or npm-token",
    );
  }
  if (!["as-provided", "platforms-first-main-last"].includes(packageSetOrder)) {
    throw new Error("publish package set order must be one of as-provided or platforms-first-main-last",
    );
  }
  if (mode === "promote-existing-version" && auth !== "npm-token") {
    throw new Error("promote-existing-version requires npm-token auth; Trusted Publishing cannot authorize npm dist-tag add",
    );
  }
  if (channel === "release" && mode === "publish-final-version" && distTag !== "latest") {
    throw new Error("release publish-final-version must use dist-tag latest");
  }
  const alphaDistTags = new Set(["alpha", ...(line ? [`${line}-alpha`] : [])]);
  if (
    channel === "alpha" &&
    distTag === "alpha" &&
    sharedAlphaAuthorityMajor &&
    releaseLineMajor(line) !== sharedAlphaAuthorityMajor
  ) {
    throw new Error(
      `shared npm alpha authority belongs to v${sharedAlphaAuthorityMajor}; ${line || "<unknown line>"} must use its line-specific dist-tag`,
    );
  }
  if (channel === "alpha" && mode === "publish-final-version" && !alphaDistTags.has(distTag)) {
    throw new Error(`alpha publish-final-version must use dist-tag alpha or ${line ? `${line}-alpha` : "the line-specific alpha tag"}`,
    );
  }
  return {
    mode,
    auth,
    distTag,
    sharedAlphaAuthorityMajor,
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

function validatePublishContractForArtifacts({ channel, contract, requiredArtifacts,
}) {
  if (contract.mode === "promote-existing-version" && !allRequiredArtifactsAreNpm(requiredArtifacts)) {
    throw new Error("promote-existing-version requires npm publish-required-artifacts-json entries",
    );
  }
  if (contract.packageSetOrder === "platforms-first-main-last") {
    const mainArtifacts = requiredArtifacts.filter(
      (artifact) => artifact.role === "main" || artifact.name === contract.mainPackage,
    );
    if (mainArtifacts.length !== 1) {
      throw new Error("platforms-first-main-last package set requires exactly one main npm artifact",
      );
    }
  }
  if (channel === "release" && contract.mode === "publish-final-version") {
    const alphaArtifacts = requiredArtifacts.filter((artifact) => isAlphaLikeVersion(artifact.ref),
    );
    if (alphaArtifacts.length > 0) {
      throw new Error("release publish-final-version must publish final package refs, not alpha refs",
      );
    }
  }
}

function readExistingNpmIntegrity({ cwd, artifact }) {
  const spec = npmPackageSpec(artifact);
  try {
    const output = execNpmSync(
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
  const durableTextExtensions = new Set([
    ".json",
    ".jsonl",
    ".md",
    ".sha256",
    ".txt",
    ".yaml",
    ".yml",
  ]);
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) =>
        entry.isFile() &&
      (
        entry.name === "SHA256SUMS" ||
        durableTextExtensions.has(path.extname(entry.name).toLowerCase())
      ),
    )
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

async function verifyCollectedReleasePassport({ collected, cwd, phase = "generated",
}) {
  const passportPath = path.join(collected.outputDir, "buildchain.release.json",
  );
  const relativePassportPath = path.relative(cwd, passportPath).split(path.sep).join("/");
  if (collected.checkReport?.ok !== true) {
    const issues = summarizeReleasePassportIssues(collected.checkReport);
    throw new Error(
      `Release passport ${phase} check failed for ${relativePassportPath}${issues ? `: ${issues}` : ""}`,
    );
  }
  const report = await verifyReleasePassport({
    passportLocation: passportPath,
  });
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

function releaseCandidateEvidenceChannel(publicationChannel) {
  return publicationChannel === "major" ? "release" : publicationChannel;
}

function validatePromotionReleaseCandidate({
  cwd,
  passportPath = ".buildchain/artifacts/release-candidate-passport.json",
  buildSummaryPath = ".buildchain/artifacts/build-summary.json",
  repository,
  targetChannel,
  targetRef = "",
  version = "",
  recoveryReceiptPath = "",
  sourceHeadSha,
  sourceTreeSha = "",
  requirePlatforms = true,
  requireFamilyEvidence = false,
  familyEvidenceRoot = "",
  familyInitiativeId = "",
  familyAssignmentId = "",
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
    targetChannel: releaseCandidateEvidenceChannel(targetChannel),
    version: recoveryReceiptPath ? "" : version,
    buildSummary,
    requirePlatforms,
    requireFamilyEvidence,
    familyEvidenceRoot,
    familyInitiativeId,
    familyAssignmentId,
  });
  let recoveryReceiptValidation;
  if (recoveryReceiptPath) {
    const resolvedRecoveryReceiptPath = resolveMaybeRelative(cwd, recoveryReceiptPath);
    if (!fs.existsSync(resolvedRecoveryReceiptPath)) {
      validation.errors.push(`recovery receipt is missing: ${recoveryReceiptPath}`);
    } else {
      const recoveryReceipt = JSON.parse(fs.readFileSync(resolvedRecoveryReceiptPath, "utf8"));
      recoveryReceiptValidation = validateReleaseCandidateRecoveryReceipt({
        receipt: recoveryReceipt,
        passport,
        repository,
        targetChannel: releaseCandidateEvidenceChannel(targetChannel),
        targetRef,
        targetSha: sourceHeadSha,
        targetTree: sourceTreeSha,
        version,
      });
      validation.errors.push(...recoveryReceiptValidation.errors.map((error) => `recovery receipt: ${error}`));
    }
  }
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
    throw new Error(`release candidate passport validation failed: ${validation.errors.join("; ")}`,
    );
  }
  return {
    passportPath: resolvedPassportPath,
    buildSummaryPath: buildSummary ? resolvedSummaryPath : "",
    candidateHash: passport.candidateHash || "",
    platformCount: Array.isArray(passport.platformMatrix) ? passport.platformMatrix.length : 0,
    gateProfileEvidence: passport.gateProfileEvidence,
    familyEvidence: passport.familyEvidence,
    controllerReceipts: passport.controllerReceipts || [],
    builtSourceSha: passport.source?.mergeRefSha || passport.source?.headSha || "",
    builtSourceTreeSha: passport.source?.treeHash || "",
    promotionChannelSha: sourceHeadSha || "",
    promotionChannelTreeSha: sourceTreeSha || "",
    treeEquivalent: Boolean(sourceTreeSha && sourceTreeHash && sourceTreeSha === sourceTreeHash,
    ),
    recoveredCandidate: recoveryReceiptValidation?.ok === true,
    publicationVersionBinding: recoveryReceiptValidation?.ok ? "recovery-receipt" : "candidate-passport",
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

function packageSetFromArtifacts({ artifacts = [], contract = {}, registry = "https://registry.npmjs.org/",
} = {}) {
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
  const mainIndex = normalized.findIndex((artifact) => artifact.name === mainPackage,
  );
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
  return Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.npm_config__authToken,
  );
}

function execNpmSync(args, options) {
  const result = spawnSyncCommand("npm", args, options);
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    const error = new Error(`npm exited with status ${result.status ?? ""}`);
    error.status = result.status ?? 1;
    error.signal = result.signal || "";
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}

function preflightNpmTokenAuth({ cwd, registry = "https://registry.npmjs.org/",
} = {}) {
  if (!npmTokenLooksConfigured()) {
    throw new Error("promote-existing-version requires npm token auth before dist-tag promotion; set NODE_AUTH_TOKEN or NPM_TOKEN",
    );
  }
  try {
    execNpmSync(["whoami", `--registry=${registry}`], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`promote-existing-version npm token preflight failed: npm whoami failed: ${message}`,
    );
  }
}

function npmDistTagAlreadyPoints({ cwd, artifact, distTag }) {
  try {
    const output = execNpmSync(
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
    execNpmSync(["dist-tag", "add", spec, distTag], {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    promoted.add(key);
  }
  return "existing-npm-artifacts";
}

function materialErrorRequiresRepair(error) {
  return /release_material_sha mismatch|source_sha mismatch|release_sha mismatch|version mismatch|target_ref mismatch|artifact digest mismatch|artifact coordinate or provenance mismatch|artifact provenance mismatch|artifact.*verification|verification\.|required artifact missing|duplicate publish artifact/.test(
    error.message || "",
  );
}

function transactionHasPublishedMaterial(transaction) {
  return Boolean(
    (Array.isArray(transaction?.artifacts) && transaction.artifacts.length > 0) ||
    (Array.isArray(transaction?.evidence) && transaction.evidence.length > 0),
  );
}

function transactionCoversRequiredArtifacts(transaction, requiredArtifacts) {
  if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length === 0) {
    return true;
  }
  if (!transactionHasPublishedMaterial(transaction)) {
    return true;
  }
  return planArtifactPublish({
    requiredArtifacts,
    existingArtifacts: transaction.artifacts || [],
  }).complete;
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

async function canRebindPublishedTransactionExactTag({
  octokit,
  owner,
  repo,
  error,
  existing,
  validation,
  version,
  exactTag,
  releaseSha,
  releaseMaterialSha,
  requiredArtifacts,
}) {
  if (!/exact_tag mismatch/.test(error?.message || "")) {
    return false;
  }
  if (
    !existing ||
    existing.version !== version ||
    !existing.exact_tag ||
    existing.exact_tag === exactTag ||
    !["published", "finalizing"].includes(existing.state || "") ||
    !validation?.valid ||
    !transactionCoversRequiredArtifacts(existing, requiredArtifacts)
  ) {
    return false;
  }

  const previousTag = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `tags/${existing.exact_tag}`,
  });
  const transactionShas = new Set([
    existing.release_sha,
    existing.release_material_sha].filter(Boolean),
  );
  if (previousTag?.object?.sha && transactionShas.has(previousTag.object.sha)) {
    return false;
  }

  const requestedTag = await getGitRefOrUndefined({
    octokit,
    owner,
    repo,
    ref: `tags/${exactTag}`,
  });
  const acceptedRequestedTagShas = new Set([
    releaseSha,
    releaseMaterialSha,
    existing.release_sha,
    existing.release_material_sha,
  ].filter(Boolean),
  );
  return (
    !requestedTag?.object?.sha || acceptedRequestedTagShas.has(requestedTag.object.sha)
  );
}

function canReplaceStaleVersionStateTransaction({
  error,
  existing,
  version,
  exactTag,
  targetRef,
  channel,
  allowVersionStateFinalization,
  explicitOverride,
  localOnly,
}) {
  if (!materialErrorRequiresRepair(error)) {
    return false;
  }
  if (localOnly) {
    return true;
  }
  if (!allowVersionStateFinalization && !explicitOverride) {
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
    const { data: commit } = await getGitCommitWithRetry({
      octokit,
      owner,
      repo,
      commitSha: sha,
    });
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
    transaction?.source_sha,
    transaction?.release_sha,
    transaction?.release_material_sha,
  ]);
}

async function materializeTransactionSourceWorkspace({
  octokit,
  owner,
  repo,
  cwd,
  sourceSha,
}) {
  assertSha(sourceSha);
  const root = path.resolve(cwd, ".buildchain/transaction-finalization-source");
  const workspace = path.join(root, sourceSha);
  const archivePath = path.join(root, `${sourceSha}.tar.gz`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/tarball/{ref}",
    {
      owner,
      repo,
      ref: sourceSha,
    },
  );
  const archive = Buffer.isBuffer(response.data)
    ? response.data
    : response.data instanceof ArrayBuffer
      ? Buffer.from(response.data)
      : ArrayBuffer.isView(response.data)
        ? Buffer.from(
            response.data.buffer,
            response.data.byteOffset,
            response.data.byteLength,
          )
        : Buffer.from(response.data || "");
  if (archive.length === 0) {
    throw new Error(
      `Transaction source archive ${sourceSha} is empty; refusing cross-tree finalization`,
    );
  }
  fs.writeFileSync(archivePath, archive);
  execFileSync(
    "tar",
    ["-xzf", archivePath, "-C", workspace, "--strip-components=1"],
    { stdio: "pipe" },
  );
  fs.rmSync(archivePath, { force: true });
  return { root, workspace };
}

function releaseTagForPublishedVersion(version = "") {
  const value = String(version || "").trim();
  if (!value) {
    return "";
  }
  return value.startsWith("v") ? value : `v${value}`;
}

function publicReleaseTagForTransaction(transaction = {}) {
  return (
    releaseTagForPublishedVersion(transaction.version) || transaction.exact_tag || ""
  );
}

function sealedBundleRecoveryRoot(cwd, version, requestedRoot = "") {
  if (requestedRoot) {
    return path.resolve(cwd, requestedRoot);
  }
  return path.join(
    cwd,
    ".buildchain",
    "recovered-publication",
    String(version || "unknown").replace(/[^0-9A-Za-z._-]+/g, "-"),
  );
}

function readAndVerifySealedBundle({ cwd, bundleRoot, manifestPath = "", manifest }) {
  const resolvedRoot = path.resolve(cwd, bundleRoot);
  const resolvedManifest =
    manifest || (manifestPath ? JSON.parse(fs.readFileSync(path.resolve(cwd, manifestPath), "utf8")) : undefined);
  if (!resolvedManifest) {
    return undefined;
  }
  return verifyPublicationSealedBundle({
    bundleRoot: resolvedRoot,
    manifest: resolvedManifest,
  });
}

function sealedBundleDurableFiles(verification) {
  if (!verification) {
    return [];
  }
  const durablePath = String(verification.manifest.durablePath || "").replace(/^\/+|\/+$/g, "");
  if (!durablePath || durablePath.split("/").includes("..")) {
    throw new Error("publication sealed bundle durablePath must be safe");
  }
  return verification.files.map((entry) => ({
    path: `${durablePath}/files/${entry.path}`,
    sourcePath: path.resolve(verification.bundleRoot, entry.path),
  }));
}

function preparePublishTransactionContext({
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
  expectedTransactionId = "",
  publishSealedBundleRoot = "",
  publishSealedBundleManifest = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
  publishRematerializeOnResume = false,
  actor = "",
  runId = "",
  explicitOverride = false,
  allowVersionStateFinalization = false,
  promotionGeneratedAt = new Date().toISOString(),
}) {
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  const enabled = Boolean(publishTransaction || publishCommand || lifecyclePublish,
  );
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
    line,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
  });
  requiredArtifacts = resolvePublishArtifactRequirements(requiredArtifacts, {
    version,
    targetRef,
    sourceSha,
    releaseMaterialSha: releaseMaterialSha || releaseSha,
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
    exactTag,
    sourceSha,
    targetRef,
    releaseMaterialSha: releaseMaterialSha || releaseSha,
    publishToolingSha: publishToolingSha || releaseSha,
  };

  const durableStateRef = releaseTransactionStateRef(version);
  const requestedBundleRoot = sealedBundleRecoveryRoot(cwd, version, publishSealedBundleRoot);
  const requestedBundleManifest = publishSealedBundleManifest
    ? JSON.parse(fs.readFileSync(path.resolve(cwd, publishSealedBundleManifest), "utf8"))
    : undefined;
  return {
    octokit, owner, repo, cwd, loadedConfig, targetRef, sourceSha, releaseSha,
    version, exactTag, channel, line, publishCommand, publishRematerializeOnResume,
    actor, runId, explicitOverride, allowVersionStateFinalization, promotionGeneratedAt,
    repository, resolvedStatePath, resolvedEvidencePath, requiredArtifacts, publishContract,
    existingNpmPromotion, expected, durableStateRef, requestedBundleRoot, requestedBundleManifest,
    expectedTransactionId: String(expectedTransactionId || "").trim(),
  };
}

async function restorePublishTransactionContext(context) {
  const {
    octokit, owner, repo, cwd, version, channel, sourceSha, releaseSha, targetRef,
    requiredArtifacts, expected, durableStateRef, resolvedStatePath, resolvedEvidencePath,
    requestedBundleRoot, requestedBundleManifest, expectedTransactionId,
  } = context;
  const durableExisting = await restoreDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef: durableStateRef,
    statePath: resolvedStatePath,
    evidencePath: resolvedEvidencePath,
    sealedBundleRoot: requestedBundleRoot,
  });
  const localExisting = readReleaseTransaction(resolvedStatePath);
  if (durableExisting && localExisting && durableExisting.id !== localExisting.id) {
    throw new Error(
      `release transaction local state ${localExisting.id} conflicts with durable state ${durableExisting.id}`,
    );
  }
  let existing = durableExisting || localExisting;
  if (expectedTransactionId && !existing) {
    throw new Error(`expected release transaction ${expectedTransactionId} does not exist`);
  }
  if (expectedTransactionId && existing.id !== expectedTransactionId) {
    throw new Error(`release transaction identity mismatch: expected ${expectedTransactionId}, got ${existing.id}`);
  }
  const durableBundleVerification = durableExisting?.sealed_bundle?.root
    ? readAndVerifySealedBundle({
        cwd,
        bundleRoot: requestedBundleRoot,
        manifest: durableExisting.sealed_bundle,
      })
    : undefined;
  const requestedBundleVerification = requestedBundleManifest
    ? readAndVerifySealedBundle({
        cwd,
        bundleRoot: requestedBundleRoot,
        manifest: requestedBundleManifest,
      })
    : undefined;
  const localBundleVerification =
    !durableExisting && localExisting?.sealed_bundle?.root
      ? readAndVerifySealedBundle({
          cwd,
          bundleRoot: requestedBundleRoot,
          manifest: localExisting.sealed_bundle,
        })
      : undefined;
  if (
    durableBundleVerification &&
    requestedBundleVerification &&
    durableBundleVerification.root !== requestedBundleVerification.root
  ) {
    throw new Error(
      `sealed bundle root mismatch: durable=${durableBundleVerification.root} requested=${requestedBundleVerification.root}`,
    );
  }
  let sealedBundleVerification = durableBundleVerification || requestedBundleVerification || localBundleVerification;
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
  return { ...context, durableExisting, localExisting, existing, sealedBundleVerification, existingEvidence, existingValidation };
}

async function canFinalizePublishVersionState({ context, error, existing }) {
  const {
    allowVersionStateFinalization, explicitOverride, version, exactTag, targetRef,
    requiredArtifacts, octokit, owner, repo, releaseSha,
  } = context;
  if (
    !(allowVersionStateFinalization || explicitOverride) ||
    !materialErrorRequiresRepair(error) ||
    existing?.version !== version ||
    existing?.exact_tag !== exactTag ||
    existing?.target_ref !== targetRef ||
    !["published", "finalizing", "complete"].includes(existing.state || "") ||
    !transactionCoversRequiredArtifacts(existing, requiredArtifacts)
  ) {
    return false;
  }
  const includesHead = (transactionReleaseSha) => releaseCommitIncludesTransactionHead({
    octokit, owner, repo, releaseSha, transactionReleaseSha,
  });
  return (await includesHead(existing.release_sha)) || (await includesHead(existing.release_material_sha));
}

async function resolvePublishTransactionResume(context) {
  const {
    octokit, owner, repo, cwd, version, exactTag, targetRef, channel, releaseSha,
    requiredArtifacts, expected, explicitOverride, allowVersionStateFinalization,
    actor, runId, resolvedStatePath, resolvedEvidencePath, durableExisting, localExisting,
  } = context;
  let { existing, existingEvidence, existingValidation } = context;
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
    const canRebindExactTag = await canRebindPublishedTransactionExactTag({
      octokit,
      owner,
      repo,
      error,
      existing,
      validation: existingValidation,
      version,
      exactTag,
      releaseSha,
      releaseMaterialSha: expected.releaseMaterialSha,
      requiredArtifacts,
    });
    const canFinalizeVersionState = await canFinalizePublishVersionState({ context, error, existing });
    const canReplaceStaleVersionState =
      canReplaceStaleVersionStateTransaction({
        error,
        existing,
        version,
        exactTag,
        targetRef,
        channel,
        allowVersionStateFinalization,
        explicitOverride,
        localOnly: Boolean(localExisting && !durableExisting),
      });
    if (!canRebindExactTag && !canFinalizeVersionState && !canReplaceStaleVersionState) {
      throw error;
    }
    if (canRebindExactTag) {
      existing = {
        ...transitionReleaseTransaction(existing, existing.state, {
          actor,
          runId,
          failure: "",
        }),
        exact_tag: exactTag,
        state_path: path.relative(cwd, resolvedStatePath).split(path.sep).join("/"),
        evidence_path: path.relative(cwd, resolvedEvidencePath).split(path.sep).join("/"),
      };
    } else if (canFinalizeVersionState) {
      versionStateFinalization = true;
    } else {
      existing = undefined;
      existingEvidence = undefined;
      existingValidation = undefined;
      fs.rmSync(resolvedStatePath, { force: true });
      fs.rmSync(resolvedEvidencePath, { force: true });
    }
  }
  return { ...context, existing, existingEvidence, existingValidation, versionStateFinalization };
}

function publishTransactionEnvironment({
  version, channel, sourceSha, targetRef, resolvedStatePath, resolvedEvidencePath,
  releaseSha, expected, promotionGeneratedAt, sealedBundleVerification,
  requiredArtifacts, publishContract,
}, { useSealedBundle = true } = {}) {
  const sealedBundle = useSealedBundle ? sealedBundleVerification : undefined;
  return {
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
    BUILDCHAIN_SEALED_BUNDLE_ROOT: sealedBundle?.root || "",
    BUILDCHAIN_SEALED_NPM_TARBALL:
      sealedBundle?.npm.absolutePath || "",
    BUILDCHAIN_SEALED_NPM_INTEGRITY:
      sealedBundle?.npm.integrity || "",
    BUILDCHAIN_SEALED_NPM_SHA256: sealedBundle?.npm.sha256 || "",
    BUILDCHAIN_REQUIRED_ARTIFACTS: JSON.stringify(requiredArtifacts),
    BUILDCHAIN_PUBLISH_MODE: publishContract.mode,
    BUILDCHAIN_PUBLISH_AUTH: publishContract.auth,
    BUILDCHAIN_NPM_DIST_TAG: publishContract.distTag,
    BUILDCHAIN_PACKAGE_SET_ORDER: publishContract.packageSetOrder,
    BUILDCHAIN_PACKAGE_SET_MAIN_PACKAGE: publishContract.mainPackage,
  };
}

async function runPublishTransaction(options) {
  const prepared = preparePublishTransactionContext(options);
  if (!prepared) return undefined;
  const restored = await restorePublishTransactionContext(prepared);
  const context = await resolvePublishTransactionResume(restored);
  const {
    octokit, owner, repo, cwd, loadedConfig, targetRef, sourceSha, releaseSha,
    version, exactTag, channel, line, publishCommand, publishRematerializeOnResume,
    actor, runId, explicitOverride, promotionGeneratedAt, repository,
    resolvedStatePath, resolvedEvidencePath, requiredArtifacts, publishContract,
    existingNpmPromotion, expected, durableExisting, existing, existingEvidence,
    existingValidation, sealedBundleVerification, versionStateFinalization,
  } = context;
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
  if (sealedBundleVerification) {
    transaction = attachReleaseTransactionSealedBundle(transaction, sealedBundleVerification.manifest, {
      actor,
      runId,
    });
  }
  let sealedBundleFilesPending = Boolean(sealedBundleVerification && !durableExisting?.sealed_bundle?.root);
  const persistTransaction = async (record) => {
    const persisted = writeReleaseTransaction(resolvedStatePath, record);
    const durable = await persistDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      cwd,
      transaction: persisted,
      evidencePath: resolvedEvidencePath,
      extraFiles: sealedBundleFilesPending ? sealedBundleDurableFiles(sealedBundleVerification) : [],
    });
    sealedBundleFilesPending = false;
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
        artifacts: transaction.artifacts || requiredArtifacts,
        contract: publishContract,
      }),
      publishContract,
      sealedBundle: sealedBundleVerification,
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
  const publishEnvironment = publishTransactionEnvironment(context);
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
    if (existing && validation?.valid && publishRematerializeOnResume) {
      if (existingNpmPromotion) {
        throw new Error(
          "publish-rematerialize-on-resume cannot replay promote-existing-version provider mutations",
        );
      }
      publishSource = runRematerializedPublishCommand({
        cwd,
        command: publishCommand,
        loadedConfig,
        env: publishTransactionEnvironment(context, { useSealedBundle: false }),
        version,
      });
      if (publishSource === "none") {
        throw new Error(
          "publish-rematerialize-on-resume requires lifecycle.publish or publish-command",
        );
      }
      publishSource = `resume-rematerialized:${publishSource}`;
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
          env: publishEnvironment,
        });
      }
      if (publishSource === "none") {
        throw new Error("publish transaction requires lifecycle.publish, publish-command, or existing evidence",
        );
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
      artifacts: validation.evidence.artifacts,
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
    transaction = recordReleaseTransactionMilestone(transaction, "package-published", {
      artifactCount: validation.evidence.artifacts.length,
      sealedBundleRoot: transaction.sealed_bundle?.root || "",
    });
    ({ transaction, durable } = await persistTransaction(transaction));
    return {
      transaction,
      validation,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      distTagEvidencePath,
      packageSet: packageSetFromArtifacts({
        artifacts: validation.evidence.artifacts,
        contract: publishContract,
      }),
      publishContract,
      sealedBundle: sealedBundleVerification,
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
        },
        );
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

export async function recordGitHubReleaseTransactionCompletion({
  octokit,
  owner,
  repo,
  cwd = process.cwd(),
  statePath,
  evidencePath,
  release,
} = {}) {
  const resolvedStatePath = path.resolve(cwd, statePath);
  const transaction = readReleaseTransaction(resolvedStatePath);
  if (!transaction) {
    throw new Error(`release transaction state is missing: ${resolvedStatePath}`);
  }
  if (transaction.state !== "complete") {
    throw new Error(`github release completion requires a complete transaction, got ${transaction.state}`);
  }
  const completed = recordReleaseTransactionMilestone(transaction, "github-release", {
    action: String(release?.action || ""),
    tag: String(release?.tag || ""),
    url: String(release?.url || ""),
    assetCount: Number(release?.assetCount || 0),
  });
  const persisted = writeReleaseTransaction(resolvedStatePath, completed);
  const durable = await persistDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    cwd,
    transaction: persisted,
    evidencePath: path.resolve(cwd, evidencePath),
  });
  return {
    transaction: persisted,
    durable,
  };
}

function generateBuildchainSelfKfdInputs({ cwd, outputDir = ".buildchain/kfd", sourceSha = "" } = {}) {
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const outputPath = (canonicalPath) => path.join(resolvedOutputDir, path.relative(".buildchain/kfd", canonicalPath),
    );
  const paths = {
    kfd1Witness: outputPath(BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH),
    kfd3PrebuildWitness: outputPath(BUILDCHAIN_KFD3_PREBUILD_WITNESS_PATH),
    kfd3ArtifactWitness: outputPath(BUILDCHAIN_KFD3_ARTIFACT_WITNESS_PATH),
    kfd2ClaimsDir: outputPath(BUILDCHAIN_KFD2_CLAIMS_DIR),
  };
  writeJsonFile(paths.kfd1Witness, createBuildchainKfd1Witness({ root: cwd, sourceSha }),
  );
  writeJsonFile(paths.kfd3PrebuildWitness, createBuildchainKfd3PrebuildWitness({ root: cwd, sourceSha }),
  );
  writeJsonFile(paths.kfd3ArtifactWitness, createBuildchainKfd3ArtifactWitness({ root: cwd, sourceSha }),
  );
  const witnessFiles = {
    "kfd-1-witness": toRepoRelative(cwd, paths.kfd1Witness),
    "kfd-3-prebuild-witness": toRepoRelative(cwd, paths.kfd3PrebuildWitness),
    "kfd-3-artifact-witness": toRepoRelative(cwd, paths.kfd3ArtifactWitness),
  };
  const kfd2ClaimJsons = createBuildchainKfd2Claims({
    root: cwd,
    witnessFiles,
  }).map((claim) => {
    const slug =
      String(claim.id || "claim")
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

function generateReleaseEvidenceInputs({
  command,
  cwd,
  sourceSha,
  tag,
  channel,
  version,
  deploymentCoordinate,
  targetRef,
  outputDir,
}) {
  if (!command) {
    return [];
  }
  let parsed;
  try {
    const output = execSync(command, {
      cwd,
      env: {
        ...process.env,
        BUILDCHAIN_RELEASE_SOURCE_SHA: sourceSha,
        BUILDCHAIN_RELEASE_TAG: tag,
        BUILDCHAIN_RELEASE_CHANNEL: channel,
        BUILDCHAIN_RELEASE_VERSION: version,
        BUILDCHAIN_RELEASE_DEPLOYMENT_COORDINATE: deploymentCoordinate,
        BUILDCHAIN_RELEASE_TARGET_REF: targetRef,
        BUILDCHAIN_RELEASE_PASSPORT_OUTPUT_DIR: outputDir,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    parsed = JSON.parse(output);
  } catch (error) {
    const message = error.stderr?.toString?.().trim() || error.message;
    throw new Error(`release passport attachment command failed: ${message}`);
  }
  const files = Array.isArray(parsed) ? parsed : parsed?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      "release passport attachment command must emit a JSON array or an object with a non-empty files array",
    );
  }
  return files.map((file, index) => {
    const normalized = String(file || "").trim();
    const resolved = normalized ? resolveMaybeRelative(cwd, normalized) : "";
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(
        `release passport attachment command files[${index}] does not exist: ${normalized || "<empty>"}`,
      );
    }
    return resolved;
  });
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
  promotionRoutingJson = "",
  kfd1WitnessJsons = [],
  kfd2ClaimJsons = [],
  kfd3PrebuildWitnessJsons = [],
  kfd3ArtifactWitnessJsons = [],
  kfd3ArtifactVerifyCommand = "",
  kfdAdopterManifestJson = "",
  kfdSupportMatrixJson = "",
  kfdProductGateJsons = [],
  invariantPassportJsons = [],
  invariantPassportCommand = "",
  releaseEvidenceJsons = [],
  releaseEvidenceCommand = "",
  buildchainSelfKfd = false,
  githubArtifactAttestationPolicyJsons = [],
  enabled = true,
  releaseCandidateValidation = undefined,
}) {
  if (!enabled || !result?.transaction || result.transaction.state !== "complete") {
    return result;
  }
  if (!result.evidencePath || !fs.existsSync(result.evidencePath)) {
    return result;
  }
  const resolvedOutputDir = path.resolve(cwd, outputDir || ".buildchain/release-passport",
  );
  const resolvedBuildSummary = buildSummaryPath
    ? resolveMaybeRelative(cwd, buildSummaryPath)
    : path.resolve(cwd, ".buildchain/artifacts/build-summary.json");
  const configuredManifests = existingFiles(platformManifestPaths, cwd);
  const buildSummaryJson = existingJsonObjectFile(resolvedBuildSummary);
  const derivedManifests = buildSummaryJson
    ? platformManifestPathsFromBuildSummary(buildSummaryJson, cwd)
    : [];
  const platformManifests = [...new Set([...configuredManifests, ...derivedManifests]),
  ];
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
  const generatedReleaseEvidenceJsons = generateReleaseEvidenceInputs({
    command: releaseEvidenceCommand,
    cwd,
    sourceSha: passportSourceSha,
    tag: publicReleaseTag,
    channel,
    version: publishedVersion,
    deploymentCoordinate: `github-release:${owner}/${repo}@${publicReleaseTag}`,
    targetRef,
    outputDir: resolvedOutputDir,
  });
  const inferredImpactJson = createTreeEquivalentReleaseImpact({
    channel,
    version: publishedVersion,
    tag: publicReleaseTag,
    line,
    releaseCandidateValidation,
  });
  const resolvedImpactJson = resolveReleaseImpactInput({
    cwd,
    impactJson: String(impactJson || "").trim() || inferredImpactJson,
    version: publishedVersion,
    line,
  });
  const promotionRouting = String(promotionRoutingJson || "").trim()
    ? (() => {
        const candidate = resolveMaybeRelative(cwd, promotionRoutingJson);
        return fs.existsSync(candidate)
          ? JSON.parse(fs.readFileSync(candidate, "utf8"))
          : JSON.parse(promotionRoutingJson);
      })()
    : undefined;
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
    versionMaterialJson: result.versionMaterial
      ? JSON.stringify(result.versionMaterial)
      : "",
    impactJson: resolvedImpactJson,
    kfd1WitnessJsons: resolvedKfd1WitnessJsons,
    kfd2ClaimJsons: resolvedKfd2ClaimJsons,
    kfd3PrebuildWitnessJsons: resolvedKfd3PrebuildWitnessJsons,
    kfd3ArtifactWitnessJsons: resolvedKfd3ArtifactWitnessJsons,
    kfd3ArtifactVerifyCommand,
    kfdAdopterManifestJson,
    kfdSupportMatrixJson,
    kfdProductGateJsons,
    invariantPassportJsons,
    invariantPassportCommand,
    releaseEvidenceJsons: [
      ...releaseEvidenceJsons,
      ...generatedReleaseEvidenceJsons,
    ],
    githubArtifactAttestationPolicyJsons,
    buildSummaryJson,
    platformManifestJsons: platformManifests,
    distTagEvidenceJson: existingJsonObjectFile(result.distTagEvidencePath),
    controllerReceiptReferences: releaseCandidateValidation?.controllerReceipts || [],
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
            ...(releaseCandidateValidation.gateProfileEvidence
              ? {
                  gateProfileEvidence: releaseCandidateValidation.gateProfileEvidence,
                }
              : {}),
          }
        : {}),
      publishToolingSha: result.transaction.publish_tooling_sha,
      releaseStateRef: `refs/heads/${result.transaction.state_ref}`,
      ...(promotionRouting ? { promotionRouting } : {}),
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
  },
  );
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
    },
    );
    return persistTransactionResult(result, cleared);
  }
  const current =
    result.transaction.state === "published"
      ? transitionReleaseTransaction(result.transaction, "finalizing", {
          actor,
          runId,
        })
      : result.transaction;
  const transaction = transitionReleaseTransaction(current, "complete", {
    actor,
    runId,
  });
  return persistTransactionResult(result, transaction);
}

async function getCommitInfo(octokit, owner, repo, sha) {
  const { data } = await getGitCommitWithRetry({
    octokit,
    owner,
    repo,
    commitSha: sha,
  });
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
    const matchingReleaseRecoveryTarget =
      parseReleaseLineRecoveryRef(headRef)?.targetRef;
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
        matchingPublishGateTarget === targetRef ||
        (
          getPromotionRule(targetRef).channel === "release" &&
          matchingReleaseRecoveryTarget === targetRef
        )
      ) &&
      headRepo === `${owner}/${repo}`
    );
  });
  if (!matchingPullRequest) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR ${expectedHeadRef} -> ${targetRef}, publish-gate/${getPromotionRule(targetRef).channel}/... -> ${targetRef}, buildchain/version-state/* -> ${targetRef}, or an exact line-scoped release recovery PR`,
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

function protectedStatusCheckNames(protection = {}) {
  const checks = protection.required_status_checks;
  return [...new Set([...(checks?.contexts || []), ...((checks?.checks || []).map((check) => check.context || check.app_id,
        ) || []),
      ].map(String),
    ),
  ];
}

export function resolveProtectedStatusCheckContext({ protection = {}, requiredStatusCheck = "check",
} = {}) {
  const declared = String(requiredStatusCheck || "").trim();
  const checkNames = protectedStatusCheckNames(protection);
  if (checkNames.includes(declared)) return declared;
  const emittedCandidates = [...new Set(checkNames.filter((name) => name === `${declared} / ${declared}` || name.startsWith(`${declared} / `),
      ),
    ),
  ];
  return emittedCandidates.length === 1 ? emittedCandidates[0] : declared;
}

async function assertProviderEnforcedChannelTransaction({
  octokit,
  owner,
  repo,
  targetRef,
  sourceSha,
  expectedChannelSha = sourceSha,
  requiredStatusCheck,
}) {
  const { data: branch } = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch: targetRef,
  });
  const protection = branch.protection || {};
  const resolvedStatusCheck = resolveProtectedStatusCheckContext({
    protection,
    requiredStatusCheck,
  });
  const requiredCheck = (protection.required_status_checks?.checks || []).find(
    (entry) => entry.context === resolvedStatusCheck,
  );
  const pullRequest = await assertChannelPromotionPr({
    octokit,
    owner,
    repo,
    sha: sourceSha,
    targetRef,
  });
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const latestReviews = new Map();
  for (const review of reviews || []) {
    const login = String(review?.user?.login || "");
    if (login) latestReviews.set(login, review);
  }
  const independentApproval = [...latestReviews.values()].some((review) =>
    review.state === "APPROVED" && review.user?.login !== pullRequest.user?.login,
  );
  const pullRequestHeadSha = String(pullRequest.head?.sha || "").trim();
  const validPullRequestHeadSha = /^[0-9a-f]{40}$/i.test(pullRequestHeadSha);
  const { data: checkRuns } = validPullRequestHeadSha
    ? await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: pullRequestHeadSha,
        per_page: 100,
      })
    : { data: { check_runs: [] } };
  const requiredCheckPassed = (checkRuns.check_runs || []).some((entry) =>
    entry.name === resolvedStatusCheck &&
    entry.conclusion === "success" &&
    (!requiredCheck?.app_id || entry.app?.id === requiredCheck.app_id),
  );
  const missing = [];
  if (branch.protected !== true) missing.push("must be provider-protected");
  if (branch.commit?.sha !== expectedChannelSha) missing.push("must still point at the exact admitted channel head");
  if (protection.required_status_checks?.enforcement_level !== "everyone") {
    missing.push("must enforce required status checks for everyone");
  }
  if (!protectedStatusCheckNames(protection).includes(resolvedStatusCheck)) {
    missing.push(`must require a ${requiredStatusCheck} status check using the exact context`,
    );
  }
  if (!validPullRequestHeadSha) {
    missing.push("merged source PR must expose an immutable head SHA");
  }
  if (!requiredCheckPassed) missing.push(`required status check ${resolvedStatusCheck} must pass from its configured app`,
    );
  if (!independentApproval) missing.push("must have an independent approving review on the merged source PR",
    );
  if (missing.length > 0) {
    throw new Error(
      `Protected channel ${targetRef} provider transaction is not qualifying: ${missing.join("; ")}`,
    );
  }
  return resolvedStatusCheck;
}

async function assertProtectedChannel({
  octokit,
  owner,
  repo,
  targetRef,
  sourceSha,
  expectedChannelSha = sourceSha,
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
    if (error.status === 403 || notFound(error)) {
      return assertProviderEnforcedChannelTransaction({
        octokit,
        owner,
        repo,
        targetRef,
        sourceSha,
        expectedChannelSha,
        requiredStatusCheck,
      });
    }
    throw error;
  }
  const missing = [];
  if (protection.enforce_admins?.enabled !== true) {
    missing.push("must enforce branch protection for administrators");
  }
  if (protection.allow_force_pushes?.enabled !== false) {
    missing.push("must disallow force pushes");
  }
  if (protection.allow_deletions?.enabled !== false) {
    missing.push("must disallow branch deletion");
  }
  if (protection.required_conversation_resolution?.enabled !== true) {
    missing.push("must require conversation resolution");
  }
  const reviews = protection.required_pull_request_reviews;
  if (!reviews || Number(reviews.required_approving_review_count || 0) < 1) {
    missing.push("must require at least one approving review");
  }
  const checks = protection.required_status_checks;
  if (!checks) missing.push("must require status checks");
  const checkNames = protectedStatusCheckNames(protection);
  const resolvedStatusCheck = resolveProtectedStatusCheckContext({ protection, requiredStatusCheck,
  });
  if (!checkNames.includes(resolvedStatusCheck)) {
    missing.push(`must require a ${requiredStatusCheck} status check using the exact context`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Protected channel ${targetRef} is missing required protection settings: ${missing.join("; ")}`,
    );
  }
  return resolvedStatusCheck;
}

function isManagedChannelBranch(ref) {
  return /^(dev|alpha|release)\/v\d+\/v\d+\.\d+$/.test(String(ref || ""));
}

function managedChannelStrictStatusChecks(branch, currentProtection) {
  if (/^(alpha|release)\//.test(String(branch || ""))) return false;
  if (currentProtection?.required_status_checks) {
    return currentProtection.required_status_checks.strict === true;
  }
  return true;
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
    allowances.users.length > 0 ||
    allowances.teams.length > 0 ||
    allowances.apps.some((app) => app !== "github-actions")
  ) {
    throw new Error(
      "managed channel protection permits only the descriptor-bound github-actions App bypass actor",
    );
  }
  if (
    allowances.apps.length === 0 &&
    allowances.users.length === 0 &&
    allowances.teams.length === 0
  ) {
    return undefined;
  }
  return allowances;
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
    return undefined;
  }
  let currentProtection;
  if (typeof octokit.rest.repos?.getBranchProtection === "function") {
    try {
      ({ data: currentProtection } = await octokit.rest.repos.getBranchProtection({ owner, repo, branch }));
    } catch (error) {
      if (
        (error.status === 403 || notFound(error)) &&
        typeof octokit.rest.repos?.getBranch === "function"
      ) {
        const { data: branchSummary } = await octokit.rest.repos.getBranch({ owner, repo, branch,
        });
        const providerProtection = branchSummary.protection || {};
        const resolvedStatusCheck = resolveProtectedStatusCheckContext({
          protection: providerProtection,
          requiredStatusCheck,
        });
        const missing = [];
        if (branchSummary.protected !== true) missing.push("must be provider-protected");
        if (providerProtection.required_status_checks?.enforcement_level !== "everyone") {
          missing.push("must enforce required status checks for everyone");
        }
        if (!protectedStatusCheckNames(providerProtection).includes(resolvedStatusCheck,
          )) {
          missing.push(`must require a ${requiredStatusCheck} status check using the exact context`,
          );
        }
        if (missing.length > 0) {
          throw new Error(
            `Managed channel ${branch} provider policy is not qualifying: ${missing.join("; ")}`,
          );
        }
        const observedPolicy = {
          requiredStatusChecks: protectedStatusCheckNames(providerProtection),
          enforcementLevel: providerProtection.required_status_checks.enforcement_level,
        };
        return {
          action: "branch-protection-policy-observed",
          ref: branch,
          policySource: "provider-enforced-existing-policy",
          before: observedPolicy,
          after: observedPolicy,
        };
      }
      if (!notFound(error)) throw error;
    }
  }
  const resolvedStatusCheck = currentProtection
    ? resolveProtectedStatusCheckContext({
        protection: currentProtection,
        requiredStatusCheck,
      })
    : requiredStatusCheck;
  const preservedChecks = (currentProtection?.required_status_checks?.checks || [])
    .filter((check) => check?.context)
    .map((check) => ({
      context: check.context,
      app_id: check.app_id ?? GITHUB_ACTIONS_APP_ID,
    }));
  for (const context of currentProtection?.required_status_checks?.contexts || []) {
    if (!preservedChecks.some((check) => check.context === context)) {
      preservedChecks.push({ context, app_id: GITHUB_ACTIONS_APP_ID });
    }
  }
  if (!preservedChecks.some((check) => check.context === resolvedStatusCheck)) {
    preservedChecks.push({
      context: resolvedStatusCheck,
      app_id: GITHUB_ACTIONS_APP_ID,
    });
  }
  const configuredBypassAllowances = branchProtectionBypassAllowances({
    apps: branchProtectionBypassApps,
    users: branchProtectionBypassUsers,
    teams: branchProtectionBypassTeams,
  });
  const bypassAllowances = configuredBypassAllowances;
  const strictStatusChecks = managedChannelStrictStatusChecks(branch, currentProtection,
  );
  await retryGitHubOperation(
    `repos.updateBranchProtection ${branch}`,
    () => octokit.rest.repos.updateBranchProtection({
      owner,
      repo,
      branch,
      required_status_checks: {
        strict: strictStatusChecks,
        checks: preservedChecks,
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: true,
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
  return {
    action: "branch-protection-policy",
    ref: branch,
    policySource: "release-governance-required-status-check",
    before: currentProtection ? {
      requiredStatusChecks: protectedStatusCheckNames(currentProtection),
      strict: currentProtection.required_status_checks?.strict === true,
      enforceAdmins: currentProtection.enforce_admins?.enabled === true,
      requiredApprovals: Number(currentProtection.required_pull_request_reviews?.required_approving_review_count || 0,
          ),
    } : null,
    after: { requiredStatusChecks: preservedChecks.map((check) => check.context), strict: strictStatusChecks, enforceAdmins: true, requiredApprovals: 1,
    },
  };
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

function ownsMajorAlphaChannel({ refs = [], major, minor }) {
  const floatingPattern = new RegExp(`^refs/tags/v${major}\\.(\\d+)-alpha$`);
  const exactPattern = new RegExp(
    `^refs/tags/v${major}\\.(\\d+)\\.\\d+-alpha\\.\\d+$`,
  );
  let highestPublishedMinor = -1;
  for (const ref of refs) {
    const refName = String(ref?.ref || "");
    const match = refName.match(floatingPattern) || refName.match(exactPattern);
    if (match) {
      highestPublishedMinor = Math.max(highestPublishedMinor, Number(match[1]));
    }
  }
  return Number(minor) >= highestPublishedMinor;
}

function resolveTagsForTarget(targetRef, inputTags) {
  const rule = getPromotionRule(targetRef);
  if (rule.channel === "major" && (!inputTags || inputTags.length === 0)) {
    return [];
  }
  if (rule.channel === "major") {
    for (const tag of inputTags) {
      if (!/^v\d+$|^v\d+-alpha$|^v\d+\.0$|^v\d+\.0-alpha$|^v\d+\.0\.\d+$|^v\d+\.0\.\d+-alpha\.\d+$/.test(tag)) {
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
          tag === rule.majorAlphaTag ||
          tag === rule.minorTag ||
          tag === rule.alphaTag ||
          isLineReleaseTag ||
          isLineAlphaTag
        : tag === rule.majorAlphaTag || tag === rule.alphaTag || isLineAlphaTag;
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

async function readDurableTransactionForVersion({ octokit, owner, repo, version,
}) {
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
  expectedVersion = "",
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
      ((await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_sha,
        })) ||
        (await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_material_sha,
        })
      ));
    const exactCompletedTransaction =
      transaction?.state === "complete" && exactTransactionSource;
    if (
      transaction &&
      (!expectedVersion || transaction.version === expectedVersion) &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["abandoned", "failed_permanently"].includes(transaction.state) &&
      (exactCompletedTransaction ||
        (transaction.state !== "complete" &&
          (exactTransactionSource || transactionInSourceHistory)))
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
  expectedVersion = "",
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
      ((await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_sha,
        })) ||
        (await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_material_sha,
        })
      ));
    if (
      transaction &&
      (!expectedVersion || transaction.version === expectedVersion) &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["complete", "abandoned", "failed_permanently"].includes(transaction.state,
      ) &&
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

function assertExpectedPublicationVersion(expectedVersion, actualVersion) {
  const expected = String(expectedVersion || "").trim();
  const actual = String(actualVersion || "").trim();
  if (expected && expected !== actual) {
    throw new Error(
      `publication version changed after authority planning: expected ${expected}, got ${actual || "<empty>"}`,
    );
  }
  return actual;
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
      "The promotion caller must enable Buildchain's protected version-state PR fallback or use an explicitly admitted release authority; do not weaken branch protection or bypass the repository's declared governance.",
  );
}

async function createGeneratedVersionStateChecks({
  octokit,
  owner,
  repo,
  branch,
  branchSha,
  currentSha,
  requiredStatusCheck,
  requiredStatusChecks = [],
}) {
  if (!isManagedChannelBranch(branch)) {
    return [];
  }
  const statusChecks = [...new Set(
    [...requiredStatusChecks, requiredStatusCheck]
      .map((check) => String(check || "").trim())
      .filter(Boolean),
  ),
  ];
  if (statusChecks.length === 0) {
    return [];
  }
  if (typeof octokit?.rest?.checks?.create !== "function") {
    console.log(
      `buildchain: unable to create generated version-state checks '${statusChecks.join(", ")}' for ${branchSha}; checks.create is unavailable`,
    );
    return [];
  }
  for (const statusCheck of statusChecks) {
    await retryGitHubOperation(
      `checks.create ${statusCheck} ${branchSha}`,
      () => octokit.rest.checks.create({
        owner,
        repo,
        name: statusCheck,
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
  }
  return statusChecks;
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

function createRefMutationOperations(context) {
  const {
    octokit,
    owner,
    repo,
    sha,
    targetRef,
    tags,
    dryRun,
    allowRepository,
    cwd,
    versionState,
    requireVersionState,
    requireGovernance,
    verificationCommand,
    requiredStatusCheck,
    statusCheckOctokit,
    pullRequestOctokit,
    refUpdateOctokit,
    branchProtectionBypassApps,
    branchProtectionBypassUsers,
    branchProtectionBypassTeams,
    reconciliationWorkspace,
    publishTransaction,
    publishCommand,
    publishEvidencePath,
    transactionStatePath,
    publishSealedBundleRoot,
    publishSealedBundleManifest,
    publishRequiredArtifactsJson,
    releaseMaterialSha,
    publishToolingSha,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
    publishRematerializeOnResume,
    expectedPublicationVersion,
    requirePublicationQualification,
    publicationCapabilityJson,
    publicationGateAggregateJson,
    publicationQualificationReceiptJson,
    publicationUsedQualificationNoncesJson,
    publicationQualificationNow,
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportPromotionRoutingJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd2ClaimJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
    releasePassportKfdAdopterManifestJson,
    releasePassportKfdSupportMatrixJson,
    releasePassportKfdProductGateJsons,
    releasePassportInvariantPassportJsons,
    releasePassportInvariantPassportCommand,
    releasePassportEvidenceJsons,
    releasePassportAttachmentCommand,
    releasePassportBuildchainSelfKfd,
    releasePassportGitHubArtifactAttestationPolicyJsons,
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    releaseCandidateFamilyEvidenceRequired,
    releaseCandidateFamilyEvidenceRoot,
    releaseCandidateFamilyInitiativeId,
    releaseCandidateFamilyAssignmentId,
    actor,
    runId,
    publishTransactionOverride,
    rule,
    assertPublicationQualification,
    requestedTags,
    updates,
    promotionGeneratedAt,
    releaseCandidateValidation,
    advancedPublicationTransaction,
    lineRefs,
    getReconciliationOperations,
    getVersionStateOperations,
  } = context;
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

  const majorAlphaRefCache = new Map();
  const listMajorAlphaRefs = async (major = rule.major) => {
    if (!majorAlphaRefCache.has(major)) {
      majorAlphaRefCache.set(
        major,
        octokit.rest.git.listMatchingRefs({
          owner,
          repo,
          ref: `tags/v${major}.`,
        }).then(({ data }) => data),
      );
    }
    return majorAlphaRefCache.get(major);
  };

  const ownsMajorAlphaFloatingTag = async ({
    major = rule.major,
    minor = rule.minor } = {}) => ownsMajorAlphaChannel({
    refs: await listMajorAlphaRefs(major),
    major,
    minor,
  });

  const ensureTag = async (tag, tagSha = sha, options = {}) => {
    const acceptedExistingShas = uniqueShas([
      tagSha,
      ...(options.acceptedExistingShas || [])]);
    const acceptedExistingMaterialShas = uniqueShas(
      options.acceptedExistingMaterialShas || []);
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
          `Tag ${tag} points at ${tagRef.object.sha}, not one of requested SHAs ${acceptedExistingShas.join(", ")}`);
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

  const updateMajorAlphaFloatingTag = async ({
    major = rule.major,
    minor = rule.minor,
    sha: tagSha = sha } = {}) => {
    const tag = `v${major}-alpha`;
    if (await ownsMajorAlphaFloatingTag({ major, minor })) {
      await updateTag(tag, tagSha);
      return true;
    }
    updates.push({
      tag,
      action: "skipped-newer-minor-alpha-exists",
      sha: tagSha,
    });
    return false;
  };

  const readRefSha = async (ref) => {
    const refData = await getGitRefOrUndefined({
      octokit,
      owner,
      repo,
      ref,
    });
    return refData?.object?.sha;
  };

  const updateBranch = async (branch, branchSha, action = "updated", protectedUpdate) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run", sha: branchSha });
      return { updated: true };
    }
    const ensureChannelProtection = async () => {
      const policyEvidence = await ensureManagedChannelBranchProtection({ octokit, owner, repo, branch, requiredStatusCheck, branchProtectionBypassApps, branchProtectionBypassUsers, branchProtectionBypassTeams,
      });
      if (policyEvidence) updates.push(policyEvidence);
      return policyEvidence;
    };
    const currentSha = await readRefSha(`heads/${branch}`);
    const protectionPolicy = currentSha
      ? await ensureChannelProtection()
      : undefined;
    const generatedStatusChecks = protectionPolicy?.after?.requiredStatusChecks || [requiredStatusCheck];
    if (currentSha === branchSha) {
      updates.push({ ref: branch, action: "existing", sha: branchSha });
      return { updated: true, existing: true };
    }
    const generatedVersionStateBranch = protectedUpdate
      ? versionStateBranchName(branch, branchSha)
      : "";
    const generatedVersionStateSha = generatedVersionStateBranch
      ? await readRefSha(`heads/${generatedVersionStateBranch}`)
      : undefined;
    if (
      currentSha &&
      generatedVersionStateSha === branchSha &&
      typeof octokit.rest.repos?.compareCommitsWithBasehead === "function"
    ) {
      const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${branchSha}...${currentSha}`,
      });
      if (comparison.status === "ahead") {
        updates.push({
          ref: branch,
          action: "existing-contained-version-state",
          sha: currentSha,
          sourceSha: branchSha,
        });
        return {
          updated: true,
          existing: true,
          contained: true,
          currentSha,
        };
      }
    }
    const branchWriteOctokit = protectedUpdate ? refUpdateOctokit || octokit : octokit;
    const openVersionStatePullRequest = async ({ error }) => {
      const message = error?.response?.data?.message || error?.message || String(error || "");
      if (
        !protectedUpdate?.allowPendingPullRequest ||
        !protectedUpdate?.title ||
        typeof pullRequestOctokit.rest.pulls?.create !== "function"
      ) {
        throw protectedBranchDirectUpdateError({ branch, branchSha, error });
      }
      const versionStateBranch = versionStateBranchName(branch, branchSha);
      const versionStateRef = `heads/${versionStateBranch}`;
      const existingVersionStateSha = await readRefSha(versionStateRef);
      if (existingVersionStateSha && existingVersionStateSha !== branchSha) {
        throw new Error(
          `Buildchain generated version-state branch ${versionStateBranch} points at ${existingVersionStateSha}, not ${branchSha}`);
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
      if (typeof pullRequestOctokit.rest.pulls?.list === "function") {
        const { data: existingPullRequests } = await pullRequestOctokit.rest.pulls.list({
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
      const { data: pullRequest } = await pullRequestOctokit.rest.pulls.create({
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
      const { data: generatedCommit } = await getGitCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha: branchSha,
      });
      const generatedParentSha = generatedCommit.parents?.[0]?.sha;
      if (!generatedParentSha) {
        throw new Error(
          `Generated version-state commit ${branchSha} must have a parent before merging into ${branch}`);
      }
      await getReconciliationOperations().assertOnlyAllowedChangesBetween({
        baseSha: generatedParentSha,
        headSha: branchSha,
        allowedPaths,
      });
      if (protectedUpdate?.reconciliationVersion && reconciliationWorkspace) {
        const workspaceCwd = path.resolve(cwd, reconciliationWorkspace);
        if (!fs.existsSync(workspaceCwd)) {
          throw new Error(`Version-state reconciliation workspace does not exist: ${workspaceCwd}`);
        }
        const workspaceSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: workspaceCwd,
          encoding: "utf8",
        }).trim();
        if (workspaceSha !== currentSha) {
          throw new Error(
            `Version-state reconciliation workspace ${workspaceSha} does not match current ${branch} ${currentSha}`);
        }
        const reconciled = await getVersionStateOperations().createVersionStateCommit({
          baseSha: currentSha,
          version: protectedUpdate.reconciliationVersion,
          message:
            protectedUpdate?.mergeMessage ||
            `${protectedUpdate?.title || "Apply generated version-state"}\n\n` +
              `Buildchain regenerated version state from current ${branch} before reconciling ` +
              `${currentSha} with ${branchSha}.`,
          workspaceCwd,
          parents: [currentSha, branchSha],
        });
        updates.push({
          ref: branch,
          action: "created-version-state-merge",
          sha: reconciled.sha,
          sourceSha: branchSha,
          currentSha,
          files: reconciled.files,
          regenerated: true,
        });
        return reconciled.sha;
      }
      const { data: currentCommit } = await getGitCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha: currentSha,
      });
      const { data: generatedTree } = await retryGitHubOperation(
        `git.getTree ${branchSha} recursive`,
        () => octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: generatedCommit.tree.sha,
          recursive: "1",
        }),
      );
      const generatedEntries = new Map(
        (generatedTree.tree || []).map((entry) => [entry.path, entry]));
      const overlayEntries = allowedPaths.map((allowedPath) => {
        const entry = generatedEntries.get(allowedPath);
        return entry
          ? {
              path: entry.path,
              mode: entry.mode,
              type: entry.type,
              sha: entry.sha,
            }
          : {
              path: allowedPath,
              mode: "100644",
              type: "blob",
              sha: null,
            };
      });
      const { data: mergedTree } = await retryGitHubOperation(
        `git.createTree ${branch} generated version-state overlay`,
        () => octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: currentCommit.tree.sha,
          tree: overlayEntries,
        }),
      );
      const { data: mergeCommit } = await retryGitHubOperation(
        `git.createCommit ${branch} generated version-state merge`,
        () => octokit.rest.git.createCommit({
          owner,
          repo,
          message: signedGeneratedCommitMessage(
            protectedUpdate?.mergeMessage ||
              `${protectedUpdate?.title || "Apply generated version-state"}\n\n` +
                `Buildchain generated this merge commit to fast-forward ${branch} after ` +
                "the channel had diverged only by generated version-state files.",
          ),
          tree: mergedTree.sha,
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
      const createdChecks = await createGeneratedVersionStateChecks({
        octokit: statusCheckOctokit,
        owner,
        repo,
        branch,
        branchSha,
        currentSha,
        requiredStatusCheck,
        requiredStatusChecks: generatedStatusChecks,
      });
      for (const check of createdChecks) {
        updates.push({
          ref: branch,
          action: "generated-status-check",
          check,
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
          const createdMergeChecks = await createGeneratedVersionStateChecks({
            octokit: statusCheckOctokit,
            owner,
            repo,
            branch,
            branchSha: mergeSha,
            currentSha,
            requiredStatusCheck,
            requiredStatusChecks: generatedStatusChecks,
          });
          for (const check of createdMergeChecks) {
            updates.push({
              ref: branch,
              action: "generated-status-check",
              check,
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
    if (typeof octokit.rest.repos?.get === "function") {
      const { data: repository } = await octokit.rest.repos.get({
        owner,
        repo,
      });
      if (repository.default_branch === branch) {
        updates.push({ ref: branch, action: "existing-default-branch" });
        return;
      }
    }
    if (typeof octokit.rest.repos?.update !== "function") {
      updates.push({ ref: branch, action: "skipped-default-branch-update-unavailable",
      });
      return;
    }
    await octokit.rest.repos.update({
      owner,
      repo,
      default_branch: branch,
    });
    updates.push({ ref: branch, action: "updated-default-branch" });
  };
  return {
    listLineRefs,
    listMajorAlphaRefs,
    ownsMajorAlphaFloatingTag,
    ensureTag,
    updateTag,
    updateMajorAlphaFloatingTag,
    readRefSha,
    updateBranch,
    updateDefaultBranch,
  };
}

function createReconciliationOperations(context) {
  const {
    octokit,
    owner,
    repo,
    sha,
    targetRef,
    tags,
    dryRun,
    allowRepository,
    cwd,
    versionState,
    requireVersionState,
    requireGovernance,
    verificationCommand,
    requiredStatusCheck,
    statusCheckOctokit,
    pullRequestOctokit,
    refUpdateOctokit,
    branchProtectionBypassApps,
    branchProtectionBypassUsers,
    branchProtectionBypassTeams,
    reconciliationWorkspace,
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
    publishRematerializeOnResume,
    expectedPublicationVersion,
    requirePublicationQualification,
    publicationCapabilityJson,
    publicationGateAggregateJson,
    publicationQualificationReceiptJson,
    publicationUsedQualificationNoncesJson,
    publicationQualificationNow,
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportPromotionRoutingJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd2ClaimJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
    releasePassportKfdAdopterManifestJson,
    releasePassportKfdSupportMatrixJson,
    releasePassportKfdProductGateJsons,
    releasePassportInvariantPassportJsons,
    releasePassportInvariantPassportCommand,
    releasePassportBuildchainSelfKfd,
    releasePassportGitHubArtifactAttestationPolicyJsons,
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    actor,
    runId,
    publishTransactionOverride,
    rule,
    assertPublicationQualification,
    requestedTags,
    updates,
    promotionGeneratedAt,
    releaseCandidateValidation,
    advancedPublicationTransaction,
    lineRefs,
    listLineRefs,
    listMajorAlphaRefs,
    ownsMajorAlphaFloatingTag,
    ensureTag,
    updateTag,
    updateMajorAlphaFloatingTag,
    readRefSha,
    updateBranch,
    updateDefaultBranch,
  } = context;
  const assertOnlyAllowedChangesBetween = async ({ baseSha, headSha, allowedPaths }) => {
    const changedPaths = await listChangedPathsBetweenTrees({
      baseSha,
      headSha,
    });
    const unexpected = changedPaths.filter((file) => !allowedPaths.includes(file));
    if (unexpected.length > 0) {
      throw new Error(
        `Version-state PR changed files outside declared version state: ${unexpected.join(", ")}`);
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
          `${entry.type || ""}:${entry.mode || ""}:${entry.sha || ""}`);
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
    allowedPaths = [] }) => {
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const changedPaths = (comparison.files || []).map((file) => file.filename);
    const unexpected = changedPaths.filter(
      (file) => !isAllowedReleaseLineRecoveryPath(file, allowedPaths));
    if (unexpected.length > 0) {
      const recoveryScope = [
        ...RELEASE_LINE_RECOVERY_PATHS,
        ...allowedPaths].join(", ");
      throw new Error(
        `Release-line recovery PR changed files outside buildchain recovery scope: ${unexpected.join(", ")}. ` +
          `Open a follow-up exact line-scoped recovery PR that contains this candidate and changes only: ${recoveryScope}`,
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
      return pullRequest.merged_at &&
        baseRef === targetRef &&
        recovery?.targetRef === targetRef &&
        headRepo === `${owner}/${repo}`;
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
      return pullRequest.merged_at &&
        baseRef === targetRef &&
        headRepo === `${owner}/${repo}`;
    });
  };

  const findAlphaMaterialFromPromotionPullRequest = async ({ commitSha, targetRef, releasePrefix, patch, refs }) => {
    if (typeof octokit.rest.repos?.listPullRequestsAssociatedWithCommit !== "function") {
      return undefined;
    }
    const pullRequest = await findMatchingTargetPullRequest({
      commitSha,
      targetRef,
    });
    const pullRequestHeadSha = pullRequest?.head?.sha;
    if (!pullRequestHeadSha) {
      return undefined;
    }
    for (const candidate of alphaTagsForPatch(refs, releasePrefix, patch)) {
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
        return pullRequest.merged_at &&
          baseRef === targetRef &&
          parseVersionStateBranchName(headRef) === targetRef &&
          headRepo === `${owner}/${repo}`;
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
    exactReleaseCandidateSource }) => {
    const commit = await getCommitInfo(octokit, owner, repo, commitSha);
    if (
      exactReleaseCandidateSource?.treeEquivalent === true &&
      exactReleaseCandidateSource.promotionChannelSha === commitSha &&
      exactReleaseCandidateSource.promotionChannelTreeSha === commit.treeSha
    ) {
      let promotionPullRequest;
      try {
        promotionPullRequest = await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
      } catch (error) {
        promotionPullRequest = await findMatchingTargetPullRequest({
          commitSha,
          targetRef,
        });
        if (!promotionPullRequest) {
          throw error;
        }
      }
      updates.push({
        action: "accepted-exact-release-candidate-source",
        sha: commitSha,
        treeSha: commit.treeSha,
        builtSourceSha: exactReleaseCandidateSource.builtSourceSha,
        builtSourceTreeSha: exactReleaseCandidateSource.builtSourceTreeSha,
        alphaTag,
        alphaSha,
        targetRef,
        pullRequest: promotionPullRequest?.html_url || promotionPullRequest?.url,
      });
      return;
    }
    if (commit.treeSha === alphaTreeSha) {
      try {
        const promotionPullRequest = await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
        if (
          parseReleaseLineRecoveryRef(promotionPullRequest.head?.ref)?.targetRef ===
          targetRef
        ) {
          updates.push({
            action: "accepted-release-recovery-tree-equivalent-source",
            sha: commitSha,
            alphaTag,
            alphaSha,
            targetRef,
          });
        }
      } catch (error) {
        const matchingReleaseRecoveryPullRequest =
          await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef,
        });
        if (!matchingReleaseRecoveryPullRequest) {
          throw error;
        }
        updates.push({
          action: "accepted-release-recovery-tree-equivalent-source",
          sha: commitSha,
          alphaTag,
          alphaSha,
          targetRef,
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
    const matchingCurrentReleaseRecoveryPullRequest =
      await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
    if (matchingCurrentReleaseRecoveryPullRequest) {
      const recoveryBaseSha =
        matchingCurrentReleaseRecoveryPullRequest.base?.sha;
      const recoveryHeadSha =
        matchingCurrentReleaseRecoveryPullRequest.head?.sha;
      if (recoveryBaseSha && recoveryHeadSha) {
        const exactCandidateSha =
          exactReleaseCandidateSource?.promotionChannelSha;
        if (
          recoveryBaseSha !== alphaSha &&
          recoveryBaseSha !== exactCandidateSha
        ) {
          throw new Error(
            `Release-line recovery PR base ${recoveryBaseSha} must equal ${alphaTag} ${alphaSha} or the exact release candidate ${exactCandidateSha || "(missing)"}`);
        }
        const recoveryHead = await getCommitInfo(
          octokit,
          owner,
          repo,
          recoveryHeadSha);
        if (recoveryHead.treeSha !== commit.treeSha) {
          throw new Error(
            `Release-line recovery PR head tree ${recoveryHead.treeSha} must equal promotion tree ${commit.treeSha}`);
        }
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: recoveryBaseSha,
          headSha: recoveryHeadSha,
          allowedPaths,
        });
      } else {
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
      }
      updates.push({
        action: "accepted-exact-release-recovery-source",
        sha: commitSha,
        recoveryBaseSha,
        recoveryHeadSha,
        alphaTag,
        alphaSha,
        targetRef,
      });
      return;
    }
    for (const parentSha of commit.parents) {
      const parent = await getCommitInfo(octokit, owner, repo, parentSha);
      if (parent.treeSha === alphaTreeSha) {
        try {
          const promotionPullRequest = await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
          if (
            parseReleaseLineRecoveryRef(promotionPullRequest.head?.ref)?.targetRef ===
            targetRef
          ) {
            updates.push({
              action: "accepted-release-recovery-tree-equivalent-source",
              sha: parentSha,
              alphaTag,
              alphaSha,
              targetRef,
            });
          }
        } catch (error) {
          const matchingReleaseRecoveryPullRequest =
            await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef,
          });
          if (!matchingReleaseRecoveryPullRequest) {
            throw error;
          }
          updates.push({
            action: "accepted-release-recovery-tree-equivalent-source",
            sha: parentSha,
            alphaTag,
            alphaSha,
            targetRef,
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
        await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef,
      });
      if (matchingReleaseRecoveryPullRequest) {
        const recoveryBaseSha = matchingReleaseRecoveryPullRequest.base?.sha;
        const recoveryHeadSha = matchingReleaseRecoveryPullRequest.head?.sha;
        const exactCandidateSha =
          exactReleaseCandidateSource?.promotionChannelSha;
        const exactCandidateTreeSha =
          exactReleaseCandidateSource?.promotionChannelTreeSha;
        if (
          recoveryBaseSha &&
          recoveryHeadSha &&
          exactReleaseCandidateSource?.treeEquivalent === true &&
          parentSha === exactCandidateSha &&
          parent.treeSha === exactCandidateTreeSha
        ) {
          const recoveryHead = await getCommitInfo(
            octokit,
            owner,
            repo,
            recoveryHeadSha);
          if (recoveryHead.treeSha !== parent.treeSha) {
            throw new Error(
              `Release-line recovery PR head tree ${recoveryHead.treeSha} must equal exact release candidate tree ${parent.treeSha}`);
          }
          await assertOnlyAllowedReleaseRecoveryChangesBetween({
            baseSha: recoveryBaseSha,
            headSha: recoveryHeadSha,
            allowedPaths,
          });
          await assertOnlyAllowedChangesBetween({
            baseSha: parentSha,
            headSha: commitSha,
            allowedPaths,
          });
          updates.push({
            action: "accepted-exact-release-recovery-parent",
            sha: parentSha,
            treeSha: parent.treeSha,
            recoveryBaseSha,
            recoveryHeadSha,
            builtSourceSha: exactReleaseCandidateSource.builtSourceSha,
            builtSourceTreeSha: exactReleaseCandidateSource.builtSourceTreeSha,
            alphaTag,
            alphaSha,
            targetRef,
          });
          return;
        }
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
      const exactCandidateSha =
        exactReleaseCandidateSource?.promotionChannelSha;
      const exactCandidateTreeSha =
        exactReleaseCandidateSource?.promotionChannelTreeSha;
      if (
        exactReleaseCandidateSource?.treeEquivalent === true &&
        parentSha === exactCandidateSha &&
        parent.treeSha === exactCandidateTreeSha
      ) {
        let promotionPullRequest;
        try {
          promotionPullRequest = await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
        } catch (error) {
          promotionPullRequest = await findMatchingTargetPullRequest({
            commitSha: parentSha,
            targetRef,
          });
          if (!promotionPullRequest) {
            throw error;
          }
        }
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        updates.push({
          action: "accepted-exact-release-candidate-parent",
          sha: parentSha,
          treeSha: parent.treeSha,
          builtSourceSha: exactReleaseCandidateSource.builtSourceSha,
          builtSourceTreeSha: exactReleaseCandidateSource.builtSourceTreeSha,
          alphaTag,
          alphaSha,
          targetRef,
          pullRequest:
            promotionPullRequest?.html_url || promotionPullRequest?.url,
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
      `Release source ${commitSha} must have the same tree as ${alphaTag}, except declared version-state files`);
  };

  const isSettledAlphaVersionState = async (selectedAlpha) => {
    if (!selectedAlpha?.exists || selectedAlpha.sha !== sha) {
      return false;
    }
    const devRef = `heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`;
    const ownsMajorAlphaTag = await ownsMajorAlphaFloatingTag();
    const [devSha, exactAlphaTagSha, floatingAlphaTagSha, majorFloatingAlphaTagSha] = await Promise.all([
      readRefSha(devRef),
      readRefSha(`tags/${selectedAlpha.tag}`),
      readRefSha(`tags/${rule.alphaTag}`),
      ownsMajorAlphaTag ? readRefSha(`tags/${rule.majorAlphaTag}`) : undefined,
    ]);
    return devSha === sha &&
      exactAlphaTagSha === sha &&
      floatingAlphaTagSha === sha &&
      (!ownsMajorAlphaTag || majorFloatingAlphaTagSha === sha);
  };
  return {
    assertOnlyAllowedChangesBetween,
    listChangedPathsBetweenTrees,
    assertOnlyAllowedReleaseRecoveryChangesBetween,
    findMatchingReleaseRecoveryPullRequest,
    findMatchingTargetPullRequest,
    findAlphaMaterialFromPromotionPullRequest,
    assertPromotionPrOrVersionStateParent,
    assertReleasePrOrVersionStateParent,
    isSettledAlphaVersionState,
  };
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
  pullRequestOctokit = octokit,
  refUpdateOctokit = octokit,
  branchProtectionBypassApps = "",
  branchProtectionBypassUsers = "",
  branchProtectionBypassTeams = "",
  reconciliationWorkspace = "",
  publishTransaction = false,
  publishCommand = "",
  publishEvidencePath = "",
  transactionStatePath = "",
  expectedTransactionId = "",
  publishSealedBundleRoot = "",
  publishSealedBundleManifest = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
  publishRematerializeOnResume = false,
  expectedPublicationVersion = "",
  requirePublicationQualification = false,
  publicationCapabilityJson = "",
  publicationGateAggregateJson = "",
  publicationQualificationReceiptJson = "",
  publicationUsedQualificationNoncesJson = "[]",
  publicationQualificationNow,
  releasePassport = true,
  releasePassportOutputDir = ".buildchain/release-passport",
  releasePassportProductName = "Buildchain",
  releasePassportBuildSummaryPath = ".buildchain/artifacts/build-summary.json",
  releasePassportPlatformManifestPaths = "",
  releasePassportImpactJson = "",
  releasePassportPromotionRoutingJson = "",
  releasePassportKfd1WitnessJsons = "",
  releasePassportKfd2ClaimJsons = "",
  releasePassportKfd3PrebuildWitnessJsons = "",
  releasePassportKfd3ArtifactWitnessJsons = "",
  releasePassportKfd3ArtifactVerifyCommand = "",
  releasePassportKfdAdopterManifestJson = "",
  releasePassportKfdSupportMatrixJson = "",
  releasePassportKfdProductGateJsons = "",
  releasePassportInvariantPassportJsons = "",
  releasePassportInvariantPassportCommand = "",
  releasePassportEvidenceJsons = "",
  releasePassportAttachmentCommand = "",
  releasePassportBuildchainSelfKfd = false,
  releasePassportGitHubArtifactAttestationPolicyJsons = "",
  promoteOnlyReleaseCandidate = false,
  releaseCandidatePassportPath = ".buildchain/artifacts/release-candidate-passport.json",
  releaseCandidateBuildSummaryPath = ".buildchain/artifacts/build-summary.json",
  releaseCandidateVersion = "",
  releaseCandidateRecoveryReceiptPath = "",
  releaseCandidateFamilyEvidenceRequired = false,
  releaseCandidateFamilyEvidenceRoot = "",
  releaseCandidateFamilyInitiativeId = "",
  releaseCandidateFamilyAssignmentId = "",
  actor = process.env.GITHUB_ACTOR || process.env.USER || "",
  runId = process.env.GITHUB_RUN_ID || "",
  publishTransactionOverride = false,
}) {
  assertPromotableRepository(owner, repo, allowRepository);
  assertPromotableTargetRef(targetRef);
  assertSha(sha);
  const rule = getPromotionRule(targetRef);
  const assertPublicationQualification = ({ version = expectedPublicationVersion, channel = rule.channel } = {}) => {
    if (!requirePublicationQualification || dryRun) return;
    const parseQualificationJson = (value, label) => {
      if (!String(value || "").trim()) {
        throw new Error(`${label} is required before provider mutation`);
      }
      try {
        return JSON.parse(value);
      } catch (error) {
        throw new Error(`${label} must be valid JSON: ${error.message}`);
      }
    };
    verifyPublicationQualificationReceipt({
      receipt: parseQualificationJson(publicationQualificationReceiptJson, "publication-qualification-receipt-json"),
      capability: parseQualificationJson(publicationCapabilityJson, "publication-capability-json"),
      gateAggregate: parseQualificationJson(publicationGateAggregateJson, "publication-gate-aggregate-json"),
      usedNonces: parseQualificationJson(publicationUsedQualificationNoncesJson || "[]", "publication-used-qualification-nonces-json"),
      expected: {
        sourceSha: sha,
        channel,
        ...(version ? { version } : {}),
        ...(publishPackageMain ? { target: `npm:${publishPackageMain}` } : {}),
      },
      now: publicationQualificationNow || new Date(),
    });
  };
  assertPublicationQualification();
  const requestedTags = tags ? resolveTagsForTarget(targetRef, tags) : undefined;

  const { data: branchRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${targetRef}`,
  });
  const branchSha = branchRef.object.sha; let advancedPublicationTransaction;
  if (branchSha !== sha) {
    if (requireGovernance && !dryRun) {
      const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${sha}...${branchSha}`,
      });
      if (comparison.status !== "ahead") {
        throw new Error(`Ref ${targetRef} moved incompatibly from requested SHA ${sha} to ${branchSha} (${comparison.status})`);
      }
      const publicationEnabled = Boolean(publishTransaction || publishCommand || getLifecycleStage(loadBuildchainConfig(cwd), "publish"));
      advancedPublicationTransaction =
        publicationEnabled && expectedPublicationVersion
          ? await readDurableTransactionForVersion({
              octokit,
              owner,
              repo,
              version: expectedPublicationVersion,
            })
          : undefined;
      let targetAdvancedByExactPublication = advancedPublicationTransaction?.source_sha === sha && advancedPublicationTransaction?.target_ref === targetRef && advancedPublicationTransaction?.release_sha === branchSha && advancedPublicationTransaction?.version === expectedPublicationVersion && !["abandoned", "failed_permanently"].includes(advancedPublicationTransaction?.state || "");
      if (!targetAdvancedByExactPublication && publishTransactionOverride && publicationEnabled) { const statePrefix = rule.releasePrefix.replace(/^v/, "").replaceAll(".", "-"); const { data: stateRefs } = await octokit.rest.git.listMatchingRefs({ owner, repo, ref: `heads/buildchain/release-state/${statePrefix}-` }); const resumeResolver = rule.channel === "alpha" ? resumableAlphaTransactionState : rule.channel === "release" ? resumableReleaseTransactionState : undefined; const resumable = resumeResolver && await resumeResolver({ octokit, owner, repo, cwd, refs: stateRefs, releasePrefix: rule.releasePrefix, targetRef, sourceSha: sha, expectedVersion: expectedPublicationVersion }); if (!resumable) throw new Error(`Ref ${targetRef} advanced to ${branchSha}, but no exact resumable transaction accepts requested SHA ${sha}`); advancedPublicationTransaction = resumable.transaction; targetAdvancedByExactPublication = true; }
      if (!targetAdvancedByExactPublication) {
        return {
          owner,
          repo,
          sourceSha: sha,
          sha: branchSha,
          targetRef,
          superseded: true,
          updates: [
            {
              action: "superseded-promotion",
              ref: targetRef,
              requestedSha: sha,
              currentSha: branchSha,
              comparisonStatus: comparison.status,
              reason: "target-ref-advanced",
              sha: branchSha,
            },
          ],
        };
      }
    } else if (dryRun && publishTransactionOverride && Boolean(publishTransaction || publishCommand || getLifecycleStage(loadBuildchainConfig(cwd), "publish"))) {
      const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${sha}...${branchSha}` }); const statePrefix = rule.releasePrefix.replace(/^v/, "").replaceAll(".", "-"); const { data: stateRefs } = await octokit.rest.git.listMatchingRefs({ owner, repo, ref: `heads/buildchain/release-state/${statePrefix}-` }); const resumeResolver = rule.channel === "alpha" ? resumableAlphaTransactionState : rule.channel === "release" ? resumableReleaseTransactionState : undefined; const resumable = resumeResolver && await resumeResolver({ octokit, owner, repo, cwd, refs: stateRefs, releasePrefix: rule.releasePrefix, targetRef, sourceSha: sha, expectedVersion: expectedPublicationVersion }); if (comparison.status !== "ahead") throw new Error(`Ref ${targetRef} moved incompatibly from requested SHA ${sha} to ${branchSha} (${comparison.status})`); if (!resumable) throw new Error(`Ref ${targetRef} advanced to ${branchSha}, but no exact resumable transaction accepts requested SHA ${sha}`); advancedPublicationTransaction = resumable.transaction;
    }
    if (!advancedPublicationTransaction) {
      throw new Error(`Ref ${targetRef} points at ${branchSha}, not requested SHA ${sha}`);
    }
  }

  const updates = []; if (advancedPublicationTransaction) {
    updates.push({
      action: "resumed-advanced-publication",
      ref: targetRef,
      requestedSha: sha,
      currentSha: branchSha,
      transactionId: advancedPublicationTransaction.id,
      transactionState: advancedPublicationTransaction.state,
      sha: branchSha,
    });
  }
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
      recoveryReceiptPath: releaseCandidateRecoveryReceiptPath,
      targetRef,
      sourceHeadSha: sha,
      sourceTreeSha: targetCommitInfo.treeSha,
      requireFamilyEvidence: releaseCandidateFamilyEvidenceRequired,
      familyEvidenceRoot: releaseCandidateFamilyEvidenceRoot,
      familyInitiativeId: releaseCandidateFamilyInitiativeId,
      familyAssignmentId: releaseCandidateFamilyAssignmentId,
    });
    updates.push({
      action: "verified-release-candidate",
      sha,
      candidateHash: releaseCandidateValidation.candidateHash,
      platformCount: releaseCandidateValidation.platformCount,
      passportPath: path.relative(cwd, releaseCandidateValidation.passportPath).split(path.sep).join("/"),
      publicationVersionBinding: releaseCandidateValidation.publicationVersionBinding,
    });
  }

  let reconciliationOperations;
  let versionOperations;
  const baseContext = {
    octokit,
    owner,
    repo,
    sha,
    targetRef,
    tags,
    dryRun,
    allowRepository,
    cwd,
    versionState,
    requireVersionState,
    requireGovernance,
    verificationCommand,
    requiredStatusCheck,
    statusCheckOctokit,
    pullRequestOctokit,
    refUpdateOctokit,
    branchProtectionBypassApps,
    branchProtectionBypassUsers,
    branchProtectionBypassTeams,
    reconciliationWorkspace,
    publishTransaction,
    publishCommand,
    publishEvidencePath,
    transactionStatePath,
    expectedTransactionId,
    publishSealedBundleRoot,
    publishSealedBundleManifest,
    publishRequiredArtifactsJson,
    releaseMaterialSha,
    publishToolingSha,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
    publishRematerializeOnResume,
    expectedPublicationVersion,
    requirePublicationQualification,
    publicationCapabilityJson,
    publicationGateAggregateJson,
    publicationQualificationReceiptJson,
    publicationUsedQualificationNoncesJson,
    publicationQualificationNow,
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportPromotionRoutingJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd2ClaimJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
    releasePassportKfdAdopterManifestJson,
    releasePassportKfdSupportMatrixJson,
    releasePassportKfdProductGateJsons,
    releasePassportInvariantPassportJsons,
    releasePassportInvariantPassportCommand,
    releasePassportEvidenceJsons,
    releasePassportAttachmentCommand,
    releasePassportBuildchainSelfKfd,
    releasePassportGitHubArtifactAttestationPolicyJsons,
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    releaseCandidateRecoveryReceiptPath,
    releaseCandidateFamilyEvidenceRequired,
    releaseCandidateFamilyEvidenceRoot,
    releaseCandidateFamilyInitiativeId,
    releaseCandidateFamilyAssignmentId,
    actor,
    runId,
    publishTransactionOverride,
    rule,
    assertPublicationQualification,
    requestedTags,
    updates,
    promotionGeneratedAt,
    releaseCandidateValidation,
    advancedPublicationTransaction,
    advancedChannelSha: advancedPublicationTransaction ? branchSha : "",
    COMMIT_IDENTITY,
    fs,
    path,
    alignMajorBootstrapReleaseImpact,
    alphaDistTagForPromotion,
    alphaTagsForPatch,
    assertExpectedPublicationVersion,
    beginTransactionFinalization,
    collectAndPersistReleasePassport,
    collectRemoteVersionMaterial,
    completeTransactionFinalization,
    currentAlphaVersionState,
    currentConfiguredVersion,
    currentReleaseVersionState,
    discoverConfiguredDerivedVersionMaterial,
    discoverVersionStateFiles,
    getCommitInfo,
    getGitCommitWithRetry,
    getGitRefOrUndefined,
    getLifecycleStage,
    getMajorGateSource,
    getPublishContract,
    getVersionStrategy,
    latestAlphaForPatch,
    loadConfiguredAnchorManifest,
    loadBuildchainConfig,
    materializeTransactionSourceWorkspace,
    publicReleaseTagForTransaction,
    readDurableTransactionForVersion,
    releaseTagForPublishedVersion,
    releaseCommitIncludesTransactionHead,
    releaseTransactionPublicationState,
    resumableAlphaTransactionState,
    resumableReleaseTransactionState,
    selectAlphaTag,
    selectReleaseTag,
    runPublishTransaction,
    runVersionVerification,
    sha256Content,
    signedGeneratedCommitMessage,
    splitPathList,
    stripTagPrefix,
    transactionAcceptedExactTagShas,
    transactionHasPublishedMaterial,
    uniquePaths,
    updateVersionStateContents,
    versionVerificationAllowedPathsForPromotion,
    versionVerificationEnv,
    getReconciliationOperations: () => reconciliationOperations,
    getVersionStateOperations: () => versionOperations,
  };
  const refOperations = createRefMutationOperations(baseContext);
  reconciliationOperations = createReconciliationOperations({
    ...baseContext,
    ...refOperations,
  });
  versionOperations = createVersionStateOperations({
    ...baseContext,
    ...refOperations,
    ...reconciliationOperations,
  });
  const transactionOperations = createDurableTransactionOperations({
    ...baseContext,
    ...refOperations,
    ...reconciliationOperations,
    ...versionOperations,
  });
  const channelContext = {
    ...baseContext,
    ...refOperations,
    ...reconciliationOperations,
    ...versionOperations,
    ...transactionOperations,
  };

  if (requireGovernance && !dryRun) {
    requiredStatusCheck = await assertProtectedChannel({
      octokit,
      owner,
      repo,
      targetRef,
      sourceSha: sha,
      expectedChannelSha: advancedPublicationTransaction ? branchSha : sha,
      requiredStatusCheck,
    });
  }

  if (rule.channel === "major") {
    return promoteMajorChannel(channelContext);
  }

  const lineRefs = await refOperations.listLineRefs();
  const lineContext = { ...channelContext, lineRefs };
  if (rule.channel === "alpha") {
    return promoteAlphaChannel(lineContext);
  }
  return promoteReleaseChannel(lineContext);
}

export {
  DEFAULT_REPOSITORY,
  assertChannelPromotionPr,
  assertAllowedLocalChanges,
  assertProviderEnforcedChannelTransaction,
  assertProtectedChannel,
  assertPromotableRepository,
  assertPromotableTargetRef,
  ensureManagedChannelBranchProtection,
  assertSha,
  discoverVersionStateFiles,
  expectedHeadRefForTarget,
  getPromotionRule,
  isAllowedReleaseLineRecoveryPath,
  latestAlphaForPatch,
  ownsMajorAlphaChannel,
  parseReleaseLineRef,
  parseAlphaPrereleaseTag,
  parseRepository,
  parseReleasePatchTag,
  parseTags,
  promoteBuildchainRefs,
  persistDurableReleaseTransaction,
  readDurableReleaseTransaction,
  restoreDurableReleaseTransaction,
  runPublishTransaction,
  resolveTagsForTarget,
  runVersionVerification,
  selectAlphaTag,
  selectReleaseTag,
  assertExpectedPublicationVersion,
  alphaDistTagForPromotion,
  stripTagPrefix,
  updateVersionStateContents,
  alignMajorBootstrapReleaseImpact,
  versionVerificationAllowedPathsForPromotion,
  resolveReleaseImpactInput,
  generateReleaseEvidenceInputs,
  createTreeEquivalentReleaseImpact,
  createDurableTransactionOperations,
  createRefMutationOperations,
  releasePassportArtifactFiles,
  validatePromotionReleaseCandidate,
};

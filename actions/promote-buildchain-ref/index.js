import * as core from "@actions/core";
import * as github from "@actions/github";
import { pathToFileURL } from "node:url";
import { parseTags, promoteBuildchainRefs, recordGitHubReleaseTransactionCompletion } from "./lib.js";
import { explainReleaseLineDryRun, formatReleaseLineDryRun } from "../../packages/core/release-line-dry-run.js";
import {
  publishSelectedGitHubRelease,
  recoveryCompletedBeforeThisRun,
} from "./github-release.js";

export { reuseCompleteGitHubReleaseEvidence } from "./reuse-complete-release.js";
export {
  collectGitHubReleaseEvidenceAssets,
  createDeclarativeGitHubReleasePlan,
  publishGitHubReleaseEvidence,
} from "./github-release.js";

const releaseCandidateRecoveryReceiptPath = process.env.BUILDCHAIN_RELEASE_CANDIDATE_RECOVERY_RECEIPT_PATH || "";

export function plannedPublicationExactTag(plannedPublication = {}) {
  return plannedPublication.publicTag || plannedPublication.tag || "";
}

function normalizePublishSourceRef(ref = "") {
  return String(ref || "").trim().replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
}

function parseLockedPublishSource(ref = "") {
  const sourceRef = normalizePublishSourceRef(ref);
  if (sourceRef === "publish-gate/major") {
    return { sourceRef, channel: "major", line: "", consumerVersion: "" };
  }
  const match = sourceRef.match(/^publish-gate\/(alpha|release)\/(.+)\/([^/]+)$/);
  if (!match) {
    return { sourceRef, channel: "", line: "", consumerVersion: "" };
  }
  return {
    sourceRef,
    channel: match[1],
    line: match[2],
    consumerVersion: match[3],
  };
}

function checkSourceLock(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

export function validateRequiredPublishSourceLock({
  sha,
  publishSourceRef = "",
  publishSourceSha = "",
  publishSourceLocked = "",
} = {}) {
  if (publishSourceSha && publishSourceSha !== sha) {
    throw new Error(`publish-source-sha ${publishSourceSha} does not match promotion sha ${sha}`);
  }
  const parsed = parseLockedPublishSource(publishSourceRef);
  const locked = String(publishSourceLocked || "").toLowerCase();
  const effectiveSha = publishSourceSha || sha || "";
  const sourceLockReport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-publish-source-lock-validation",
    ok: false,
    checks: [
      checkSourceLock(
        locked === "true" || locked === "1" || publishSourceLocked === true,
        "publish.source_locked",
        "publish source lock is required before package publication",
        { sourceLocked: publishSourceLocked || "" },
      ),
      checkSourceLock(
        !!parsed.channel,
        "publish.source_ref",
        "publish source ref uses publish-gate/{alpha,release,major}",
        {
          sourceRef: parsed.sourceRef || publishSourceRef || "",
          channel: parsed.channel,
        },
      ),
      checkSourceLock(
        /^[0-9a-f]{40}$/i.test(String(effectiveSha)),
        "publish.source_sha",
        "publish source SHA is a 40-character Git SHA",
        { sourceSha: effectiveSha },
      ),
    ],
    summary: {
      publishSource: {
        sourceRef: parsed.sourceRef || publishSourceRef || "",
        sourceSha: effectiveSha,
        sourceLocked: publishSourceLocked || "",
        channel: parsed.channel,
        line: parsed.line,
        consumerVersion: parsed.consumerVersion,
      },
    },
  };
  sourceLockReport.ok = sourceLockReport.checks.every((check) => check.status === "pass");
  if (!sourceLockReport.ok) {
    const failed = sourceLockReport.checks
      .filter((check) => check.status !== "pass")
      .map((check) => `${check.id}: ${check.message}`)
      .join("; ");
    throw new Error(`publish source-lock validation failed: ${failed}`);
  }
  return sourceLockReport;
}

async function publishReleaseTail({
  enabled,
  dryRun,
  declarative,
  releaseTailStatePath,
  result,
  octokit,
  token,
  sha,
  title,
  notes,
  artifactPaths,
  targetRef,
} = {}) {
  if (!enabled || dryRun) return null;
  const releaseComplete = result.publishTransaction?.state === "complete";
  const finalizationComplete = result.publishTransaction?.finalizationNeeded !== true;
  if (
    !releaseComplete ||
    !finalizationComplete
  ) {
    core.info(
      `github-release=true is waiting for a complete release transaction before creating or updating the public GitHub Release; transaction-state=${result.publishTransaction?.state || ""} finalization-needed=${result.publishTransaction?.finalizationNeeded === true}`,
    );
    return null;
  }
  const releaseOptions = {
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    token,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    tag:
      result.publishTransaction?.publicReleaseTag ||
      result.publishTransaction?.exactTag ||
      "",
    target: result.publishTransaction?.releaseSha || sha,
    channel: result.publishTransaction?.channel || "",
    title,
    notes,
    publishEvidencePath: result.publishTransaction?.evidencePath || "",
    releasePassportPath: result.publishTransaction?.releasePassportPath || "",
    releasePassportOutputDir:
      result.publishTransaction?.releasePassportOutputDir || "",
    additionalAssetPaths: result.publishTransaction?.sealedReleaseAssetPaths
      ?.length
      ? result.publishTransaction.sealedReleaseAssetPaths
      : artifactPaths,
    reuseExistingCompleteEvidence: recoveryCompletedBeforeThisRun(
      releaseCandidateRecoveryReceiptPath,
    ),
    targetRef,
  };
  const release = await publishSelectedGitHubRelease({
    declarative,
    title,
    notes,
    legacyOptions: releaseOptions,
    declarativeOptions: {
      octokit,
      repository: `${github.context.repo.owner}/${github.context.repo.repo}`,
      sourceSha: releaseOptions.target,
      version:
        result.publishTransaction?.version ||
        String(releaseOptions.tag).replace(/^v/u, ""),
      tag: releaseOptions.tag,
      channel: releaseOptions.channel,
      publishEvidencePath: releaseOptions.publishEvidencePath,
      releasePassportPath: releaseOptions.releasePassportPath,
      releasePassportOutputDir: releaseOptions.releasePassportOutputDir,
      additionalAssetPaths: releaseOptions.additionalAssetPaths,
      statePath: releaseTailStatePath,
      targetRef,
    },
  });
  const completion = await recordGitHubReleaseTransactionCompletion({
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    cwd: process.cwd(),
    statePath: result.publishTransaction.statePath,
    evidencePath: result.publishTransaction.evidencePath,
    release,
  });
  result.publishTransaction.publicationState =
    completion.transaction.publication_state;
  result.publishTransaction.stateSha = completion.durable?.sha || "";
  core.setOutput(
    "transaction-publication-state",
    completion.transaction.publication_state,
  );
  core.setOutput("transaction-state-sha", completion.durable?.sha || "");
  core.info(
    `github release ${release.action}: ${release.tag} (${release.assetCount} assets)`,
  );
  return release;
}

async function main() {
  const token = core.getInput("token", { required: true });
  const sha = core.getInput("sha", { required: true });
  const targetRef = core.getInput("target-ref", { required: true });
  const tagInput = core.getInput("tags");
  const tags = tagInput ? parseTags(tagInput) : undefined;
  const dryRun = core.getBooleanInput("dry-run");
  const planBeforeTargetAdvance = core.getBooleanInput("plan-before-target-advance");
  const requireGovernance = core.getBooleanInput("require-governance");
  const requireVersionState = core.getBooleanInput("require-version-state");
  const verificationCommand = core.getInput("verification-command");
  const reconciliationWorkspace = core.getInput("reconciliation-workspace");
  const requiredStatusCheck = core.getInput("required-status-check") || "check / check";
  const generatedStatusCheckToken = core.getInput("generated-status-check-token") || token;
  const generatedPullRequestToken = core.getInput("generated-pull-request-token") || token;
  const generatedRefUpdateToken = core.getInput("generated-ref-update-token") || token;
  const branchProtectionBypassApps = core.getInput("branch-protection-bypass-apps");
  const branchProtectionBypassUsers = core.getInput("branch-protection-bypass-users");
  const branchProtectionBypassTeams = core.getInput("branch-protection-bypass-teams");
  const allowRepository = core.getInput("allow-repository") || "kungfu-systems/buildchain";
  const publishTransaction = core.getBooleanInput("publish-transaction");
  const publishCommand = core.getInput("publish-command");
  const publishEvidencePath = core.getInput("publish-evidence-path");
  const transactionStatePath = core.getInput("transaction-state-path");
  const publishSealedBundleRoot = core.getInput("publish-sealed-bundle-root");
  const publishSealedBundleManifest = core.getInput("publish-sealed-bundle-manifest");
  const publishRequiredArtifactsJson = core.getInput("publish-required-artifacts-json");
  const publishMode = core.getInput("publish-mode");
  const publishAuth = core.getInput("publish-auth");
  const publishDistTag = core.getInput("publish-dist-tag");
  const publishPackageSetOrder = core.getInput("publish-package-set-order");
  const publishPackageMain = core.getInput("publish-package-main");
  const expectedPublicationVersion = core.getInput("expected-publication-version");
  const requirePublicationQualification = core.getBooleanInput("require-publication-qualification");
  const publicationCapabilityJson = core.getInput("publication-capability-json");
  const publicationGateAggregateJson = core.getInput("publication-gate-aggregate-json");
  const publicationQualificationReceiptJson = core.getInput("publication-qualification-receipt-json");
  const publicationUsedQualificationNoncesJson = core.getInput("publication-used-qualification-nonces-json") || "[]";
  const requirePublishSourceLock = core.getBooleanInput("require-publish-source-lock");
  const publishSourceRef = core.getInput("publish-source-ref");
  const publishSourceSha = core.getInput("publish-source-sha");
  const publishSourceLocked = core.getInput("publish-source-locked");
  const releaseMaterialSha = core.getInput("release-material-sha");
  const publishToolingSha = core.getInput("publish-tooling-sha");
  const publishTransactionOverride = core.getBooleanInput("publish-transaction-override");
  const publishRematerializeOnResume = core.getBooleanInput("publish-rematerialize-on-resume");
  const releasePassport = core.getBooleanInput("release-passport");
  const releasePassportOutputDir = core.getInput("release-passport-output-dir");
  const releasePassportProductName = core.getInput("release-passport-product-name");
  const releasePassportBuildSummaryPath = core.getInput("release-passport-build-summary-path");
  const releasePassportPlatformManifestPaths = core.getInput("release-passport-platform-manifest-paths");
  const releasePassportImpactJson = core.getInput("release-passport-impact-json");
  const releasePassportPromotionRoutingJson = core.getInput("release-passport-promotion-routing-json");
  const releasePassportKfd1WitnessJsons = core.getInput("release-passport-kfd-1-witness-jsons");
  const releasePassportKfd2ClaimJsons = core.getInput("release-passport-kfd-2-claim-jsons");
  const releasePassportKfd3PrebuildWitnessJsons = core.getInput("release-passport-kfd-3-prebuild-witness-jsons");
  const releasePassportKfd3ArtifactWitnessJsons = core.getInput("release-passport-kfd-3-artifact-witness-jsons");
  const releasePassportKfd3ArtifactVerifyCommand = core.getInput("release-passport-kfd-3-artifact-verify-command");
  const releasePassportKfdSupportMatrixJson = core.getInput("release-passport-kfd-support-matrix-json");
  const releasePassportKfdProductGateJsons = core.getInput("release-passport-kfd-product-gate-jsons");
  const releasePassportInvariantPassportJsons = core.getInput("release-passport-invariant-passport-jsons");
  const releasePassportInvariantPassportCommand = core.getInput("release-passport-invariant-passport-command");
  const releasePassportEvidenceJsons = core.getInput("release-passport-evidence-jsons");
  const releasePassportAttachmentCommand =
    core.getInput("release-passport-attachment-command") ||
    core.getInput("release-passport-evidence-command");
  const releasePassportBuildchainSelfKfd = core.getBooleanInput("release-passport-buildchain-self-kfd");
  const releasePassportGitHubArtifactAttestationPolicyJsons = core.getInput(
    "release-passport-github-artifact-attestation-policy-jsons",
  );
  const githubRelease = core.getBooleanInput("github-release");
  const declarativeReleaseTail = core.getBooleanInput("declarative-release-tail");
  const releaseTailStatePath = core.getInput("release-tail-state-path") || ".buildchain/release-tail/github-release-state.json";
  const githubReleaseArtifactPaths = core.getMultilineInput("github-release-artifact-paths")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const githubReleaseTitle = core.getInput("github-release-title");
  const githubReleaseNotes = core.getInput("github-release-notes");
  const promoteOnlyReleaseCandidate = core.getBooleanInput("promote-only-release-candidate");
  const releaseCandidatePassportPath = core.getInput("release-candidate-passport-path");
  const releaseCandidateBuildSummaryPath = core.getInput("release-candidate-build-summary-path");
  const releaseCandidateVersion = core.getInput("release-candidate-version");
  const releaseCandidateFamilyEvidenceRequired = core.getBooleanInput("release-candidate-family-evidence-required");
  const releaseCandidateFamilyEvidenceRoot = core.getInput("release-candidate-family-evidence-root");
  const releaseCandidateFamilyInitiativeId = core.getInput("release-candidate-family-initiative-id");
  const releaseCandidateFamilyAssignmentId = core.getInput("release-candidate-family-assignment-id");
  const octokit = github.getOctokit(token);
  const statusCheckOctokit =
    generatedStatusCheckToken === token ? octokit : github.getOctokit(generatedStatusCheckToken);
  const pullRequestOctokit =
    generatedPullRequestToken === token ? octokit : github.getOctokit(generatedPullRequestToken);
  const refUpdateOctokit =
    generatedRefUpdateToken === token ? octokit : github.getOctokit(generatedRefUpdateToken);
  if (requirePublishSourceLock) {
    const sourceLockReport = validateRequiredPublishSourceLock({
      sha,
      publishSourceRef,
      publishSourceSha,
      publishSourceLocked,
    });
    core.info(`publish source-lock validation ok: ${sourceLockReport.summary.publishSource.sourceRef}`);
  }
  if (dryRun) {
    console.log(formatReleaseLineDryRun(explainReleaseLineDryRun({
      targetRef,
      sha,
      tags,
      publishTransaction,
      publishCommand,
      publishMode,
      publishAuth,
    })));
  }
  const result = await promoteBuildchainRefs({
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    sha,
    targetRef,
    tags,
    dryRun,
    planBeforeTargetAdvance,
    allowRepository,
    requireGovernance,
    requireVersionState,
    verificationCommand,
    reconciliationWorkspace,
    requiredStatusCheck,
    statusCheckOctokit,
    pullRequestOctokit,
    refUpdateOctokit,
    branchProtectionBypassApps,
    branchProtectionBypassUsers,
    branchProtectionBypassTeams,
    publishTransaction,
    publishCommand,
    publishEvidencePath,
    transactionStatePath,
    expectedTransactionId: process.env.BUILDCHAIN_EXPECTED_TRANSACTION_ID,
    publishSealedBundleRoot,
    publishSealedBundleManifest,
    publishRequiredArtifactsJson,
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
    releaseMaterialSha,
    publishToolingSha,
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
    releaseCandidateBuildSummaryPath, releaseCandidateVersion,
    releaseCandidateRecoveryReceiptPath,
    releaseCandidateFamilyEvidenceRequired,
    releaseCandidateFamilyEvidenceRoot,
    releaseCandidateFamilyInitiativeId,
    releaseCandidateFamilyAssignmentId,
    actor: github.context.actor,
    runId: String(github.context.runId || ""),
    publishTransactionOverride,
  });
  for (const update of result.updates) {
    const target =
      update.tag ||
      update.ref ||
      (update.version ? `version-state ${update.version}` : "promotion");
    const detail = update.files?.length ? ` (${update.files.join(", ")})` : "";
    console.log(`${update.action}: ${target} -> ${update.sha}${detail}`);
  }
  core.setOutput("sha", result.sha);
  core.setOutput("next-anchor-required", String(result.nextAlphaRequired === true));
  core.setOutput("transaction-id", result.publishTransaction?.id || "");
  core.setOutput("transaction-state", result.publishTransaction?.state || "");
  core.setOutput("transaction-publication-state", result.publishTransaction?.publicationState || "");
  core.setOutput("transaction-sealed-bundle-root", result.publishTransaction?.sealedBundleRoot || "");
  core.setOutput("transaction-resume-command", result.publishTransaction?.resumeCommand || "");
  core.setOutput("transaction-exact-tag", result.publishTransaction?.exactTag || "");
  const plannedPublication = result.updates.find(
    (update) => update.action === "dry-run-publish-transaction",
  );
  core.setOutput("planned-publication-version", plannedPublication?.version || "");
  core.setOutput("planned-publication-exact-tag", plannedPublicationExactTag(plannedPublication));
  core.setOutput(
    "planned-release-candidate-version",
    plannedPublication?.releaseCandidateVersion || "",
  );
  core.setOutput("public-release-tag", result.publishTransaction?.publicReleaseTag || result.publishTransaction?.exactTag || "");
  core.setOutput("transaction-release-sha", result.publishTransaction?.releaseSha || "");
  core.setOutput("transaction-state-ref", result.publishTransaction?.stateRef || "");
  core.setOutput("transaction-state-sha", result.publishTransaction?.stateSha || "");
  core.setOutput("transaction-state-path", result.publishTransaction?.statePath || "");
  core.setOutput("publish-evidence-path", result.publishTransaction?.evidencePath || "");
  core.setOutput("release-passport-path", result.publishTransaction?.releasePassportPath || "");
  core.setOutput("release-passport-output-dir", result.publishTransaction?.releasePassportOutputDir || "");
  core.setOutput("release-passport-state-sha", result.publishTransaction?.releasePassportStateSha || "");
  core.setOutput(
    "finalization-needed",
    String(result.publishTransaction?.finalizationNeeded === true),
  );
  const githubReleaseResult = await publishReleaseTail({
    enabled: githubRelease,
    dryRun,
    declarative: declarativeReleaseTail,
    releaseTailStatePath,
    result,
    octokit,
    token,
    sha,
    title: githubReleaseTitle,
    notes: githubReleaseNotes,
    artifactPaths: githubReleaseArtifactPaths,
    targetRef,
  });
  core.setOutput("github-release-url", githubReleaseResult?.url || "");
  core.setOutput("github-release-action", githubReleaseResult?.action || "");
  core.setOutput("release-tail-declaration-path", githubReleaseResult?.declarationPath || "");
  core.setOutput("release-tail-declaration-root", githubReleaseResult?.declarationRoot || "");
  core.setOutput("release-tail-transaction-state", githubReleaseResult?.transaction?.state || "");
  core.setOutput("release-tail-transaction-root", githubReleaseResult?.transaction?.transactionRoot || "");
  core.setOutput("release-tail-state-path", githubReleaseResult?.statePath || "");
  core.setOutput("release-tail-state-root", githubReleaseResult?.transaction?.stateRoot || "");
  core.setOutput("release-tail-receipt-roots-json", JSON.stringify((githubReleaseResult?.transaction?.receipts || []).map((receipt) => receipt.receiptRoot)));
  core.setOutput(
    "tags",
    result.updates
      .map((update) => update.tag)
      .filter(Boolean)
      .join(","),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failureMessage = String(error?.message || error || "promotion failed")
      .replace(/\r?\n/g, " ")
      .slice(0, 2000);
    core.setOutput("failure-message", failureMessage);
    console.error(error);
    core.setFailed(failureMessage);
  });
}

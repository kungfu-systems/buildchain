import * as core from "@actions/core";
import fs from "node:fs";
import path from "node:path";
import { parseTags } from "./internal/promotion-policy.js";
function readPublicationInputs() {
  const token = core.getInput("token", { required: true });
  const sha = core.getInput("sha", { required: true });
  const targetRef = core.getInput("target-ref", { required: true });
  const tagInput = core.getInput("tags");
  const tags = tagInput ? parseTags(tagInput) : undefined;
  const dryRun = core.getBooleanInput("dry-run");
  const requireGovernance = core.getBooleanInput("require-governance");
  const requireVersionState = core.getBooleanInput("require-version-state");
  const verificationCommand = core.getInput("verification-command");
  const reconciliationWorkspace = core.getInput("reconciliation-workspace");
  const requiredStatusCheck =
    core.getInput("required-status-check") || "check / check";
  const generatedStatusCheckToken =
    core.getInput("generated-status-check-token") || token;
  const generatedPullRequestToken =
    core.getInput("generated-pull-request-token") || token;
  const generatedRefUpdateToken =
    core.getInput("generated-ref-update-token") || token;
  const tagUpdateToken = process.env.BUILDCHAIN_TAG_UPDATE_TOKEN || token;
  const branchProtectionBypassApps = core.getInput(
    "branch-protection-bypass-apps",
  );
  const allowRepository =
    core.getInput("allow-repository") || "kungfu-systems/buildchain";
  const publishTransaction = core.getBooleanInput("publish-transaction");
  const publishCommand = core.getInput("publish-command");
  const publishProvider = core.getInput("publish-provider-json") ? JSON.parse(core.getInput("publish-provider-json")) : undefined;
  const publishEvidencePath = core.getInput("publish-evidence-path");
  const transactionStatePath = core.getInput("transaction-state-path");
  const publishSealedBundleRoot = core.getInput("publish-sealed-bundle-root");
  const publishSealedBundleManifest = core.getInput(
    "publish-sealed-bundle-manifest",
  );
  const publishRequiredArtifactsPath = core.getInput(
    "publish-required-artifacts-path",
  );
  const publishRequiredArtifactsJson = publishRequiredArtifactsPath
    ? fs.readFileSync(path.resolve(publishRequiredArtifactsPath), "utf8")
    : core.getInput("publish-required-artifacts-json");
  const publishMode = core.getInput("publish-mode");
  const publishAuth = core.getInput("publish-auth");
  const publishDistTag = core.getInput("publish-dist-tag");
  const publishPackageSetOrder = core.getInput("publish-package-set-order");
  const publishPackageMain = core.getInput("publish-package-main");
  const expectedPublicationVersion = core.getInput(
    "expected-publication-version",
  );
  const requirePublicationQualification = core.getBooleanInput(
    "require-publication-qualification",
  );
  const publicationCapabilityJson = core.getInput(
    "publication-capability-json",
  );
  const publicationGateAggregateJson = core.getInput(
    "publication-gate-aggregate-json",
  );
  const publicationQualificationReceiptJson = core.getInput(
    "publication-qualification-receipt-json",
  );
  const publicationUsedQualificationNoncesJson =
    core.getInput("publication-used-qualification-nonces-json") || "[]";
  const requirePublishSourceLock = core.getBooleanInput(
    "require-publish-source-lock",
  );
  const publishSourceRef = core.getInput("publish-source-ref");
  const publishSourceSha = core.getInput("publish-source-sha");
  const publishSourceLocked = core.getInput("publish-source-locked");
  const releaseMaterialSha = core.getInput("release-material-sha");
  const publishToolingSha = core.getInput("publish-tooling-sha");
  const publishTransactionOverride = core.getBooleanInput(
    "publish-transaction-override",
  );
  const publishRematerializeOnResume = core.getBooleanInput(
    "publish-rematerialize-on-resume",
  );
  return {
    token,
    sha,
    targetRef,
    tagInput,
    tags,
    dryRun,
    requireGovernance,
    requireVersionState,
    verificationCommand,
    reconciliationWorkspace,
    requiredStatusCheck,
    generatedStatusCheckToken,
    generatedPullRequestToken,
    generatedRefUpdateToken,
    tagUpdateToken,
    branchProtectionBypassApps,
    allowRepository,
    publishTransaction,
    publishCommand,
    publishProvider,
    publishEvidencePath,
    transactionStatePath,
    publishSealedBundleRoot,
    publishSealedBundleManifest,
    publishRequiredArtifactsPath,
    publishRequiredArtifactsJson,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
    expectedPublicationVersion,
    requirePublicationQualification,
    publicationCapabilityJson,
    publicationGateAggregateJson,
    publicationQualificationReceiptJson,
    publicationUsedQualificationNoncesJson,
    requirePublishSourceLock,
    publishSourceRef,
    publishSourceSha,
    publishSourceLocked,
    releaseMaterialSha,
    publishToolingSha,
    publishTransactionOverride,
    publishRematerializeOnResume,
  };
}
function readPassportInputs() {
  const releasePassport = core.getBooleanInput("release-passport");
  const releasePassportOutputDir = core.getInput("release-passport-output-dir");
  const releasePassportProductName = core.getInput(
    "release-passport-product-name",
  );
  const releasePassportBuildSummaryPath = core.getInput(
    "release-passport-build-summary-path",
  );
  const releasePassportPlatformManifestPaths = core.getInput(
    "release-passport-platform-manifest-paths",
  );
  const releasePassportImpactJson = core.getInput(
    "release-passport-impact-json",
  );
  const releasePassportPromotionRoutingJson = core.getInput(
    "release-passport-promotion-routing-json",
  );
  const releasePassportConsumerPolicyCertificationJson = core.getInput(
    "release-passport-v4-consumer-policy-certification-json",
  );
  const releasePassportConsumerPolicyCertificationRoot = core.getInput(
    "release-passport-v4-consumer-policy-certification-root",
  );
  const releasePassportRuntimeResumeEvidenceJson = core.getInput(
    "release-passport-v4-runtime-resume-evidence-json",
  );
  const releasePassportRuntimeResumeEvidenceCommand = core.getInput(
    "release-passport-v4-runtime-resume-evidence-command",
  );
  const releasePassportKfd1WitnessJsons = core.getInput(
    "release-passport-kfd-1-witness-jsons",
  );
  const releasePassportKfd2ClaimJsons = core.getInput(
    "release-passport-kfd-2-claim-jsons",
  );
  const releasePassportKfd3PrebuildWitnessJsons = core.getInput(
    "release-passport-kfd-3-prebuild-witness-jsons",
  );
  const releasePassportKfd3ArtifactWitnessJsons = core.getInput(
    "release-passport-kfd-3-artifact-witness-jsons",
  );
  const releasePassportKfd3ArtifactVerifyCommand = core.getInput(
    "release-passport-kfd-3-artifact-verify-command",
  );
  const releasePassportKfdAdopterManifestJson = core.getInput(
    "release-passport-kfd-adopter-manifest-json",
  );
  const releasePassportKfdSupportMatrixJson = core.getInput(
    "release-passport-kfd-support-matrix-json",
  );
  const releasePassportKfdProductGateJsons = core.getInput(
    "release-passport-kfd-product-gate-jsons",
  );
  const releasePassportInvariantPassportJsons = core.getInput(
    "release-passport-invariant-passport-jsons",
  );
  const releasePassportInvariantPassportCommand = core.getInput(
    "release-passport-invariant-passport-command",
  );
  const releasePassportEvidenceJsons = core.getInput(
    "release-passport-evidence-jsons",
  );
  const releasePassportAttachmentCommand = core.getInput(
    "release-passport-attachment-command",
  );
  const releasePassportBuildchainSelfKfd = core.getBooleanInput(
    "release-passport-buildchain-self-kfd",
  );
  const releasePassportGitHubArtifactAttestationPolicyJsons = core.getInput(
    "release-passport-github-artifact-attestation-policy-jsons",
  );
  return {
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportPromotionRoutingJson,
    releasePassportConsumerPolicyCertificationJson,
    releasePassportConsumerPolicyCertificationRoot,
    releasePassportRuntimeResumeEvidenceJson,
    releasePassportRuntimeResumeEvidenceCommand,
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
  };
}
function readReleaseTailInputs() {
  const githubRelease = core.getBooleanInput("github-release");
  const releaseTailStatePath =
    core.getInput("release-tail-state-path") ||
    ".buildchain/release-tail/github-release-state.json";
  const githubReleaseArtifactPaths = core
    .getMultilineInput("github-release-artifact-paths")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    githubRelease,
    releaseTailStatePath,
    githubReleaseArtifactPaths,
  };
}
function readCandidateInputs() {
  const promoteOnlyReleaseCandidate = core.getBooleanInput(
    "promote-only-release-candidate",
  );
  const releaseCandidatePassportPath = core.getInput(
    "release-candidate-passport-path",
  );
  const releaseCandidateBuildSummaryPath = core.getInput(
    "release-candidate-build-summary-path",
  );
  const releaseCandidateVersion = core.getInput("release-candidate-version");
  const releaseCandidateFamilyEvidenceRequired = core.getBooleanInput(
    "release-candidate-family-evidence-required",
  );
  const releaseCandidateFamilyEvidenceRoot = core.getInput(
    "release-candidate-family-evidence-root",
  );
  const releaseCandidateFamilyInitiativeId = core.getInput(
    "release-candidate-family-initiative-id",
  );
  const releaseCandidateFamilyAssignmentId = core.getInput(
    "release-candidate-family-assignment-id",
  );
  return {
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    releaseCandidateFamilyEvidenceRequired,
    releaseCandidateFamilyEvidenceRoot,
    releaseCandidateFamilyInitiativeId,
    releaseCandidateFamilyAssignmentId,
  };
}
export function readActionInputs() {
  return {
    ...readPublicationInputs(),
    ...readPassportInputs(),
    ...readReleaseTailInputs(),
    ...readCandidateInputs(),
  };
}

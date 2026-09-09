import { DEFAULT_REPOSITORY } from "./promotion-policy.js";

export function normalizePromotionOptions(options) {
  const normalized = { ...options };
  const defaults = {
    dryRun: false,
    allowRepository: DEFAULT_REPOSITORY,
    cwd: process.cwd(),
    versionState: true,
    requireVersionState: false,
    requireGovernance: false,
    verificationCommand: "",
    requiredStatusCheck: "check",
    branchProtectionBypassApps: "",

    reconciliationWorkspace: "",
    publishTransaction: false,
    publishCommand: "",
    publishEvidencePath: "",
    transactionStatePath: "",
    expectedTransactionId: "",
    publishSealedBundleRoot: "",
    publishSealedBundleManifest: "",
    publishRequiredArtifactsJson: "",
    releaseMaterialSha: "",
    publishToolingSha: "",
    publishMode: "",
    publishAuth: "",
    publishDistTag: "",
    publishPackageSetOrder: "",
    publishPackageMain: "",
    publishRematerializeOnResume: false,
    expectedPublicationVersion: "",
    requirePublicationQualification: false,
    publicationCapabilityJson: "",
    publicationGateAggregateJson: "",
    publicationQualificationReceiptJson: "",
    publicationUsedQualificationNoncesJson: "[]",
    releasePassport: true,
    releasePassportOutputDir: ".buildchain/release-passport",
    releasePassportProductName: "Buildchain",
    releasePassportBuildSummaryPath: ".buildchain/artifacts/build-summary.json",
    releasePassportPlatformManifestPaths: "",
    releasePassportImpactJson: "",
    releasePassportPromotionRoutingJson: "",
    releasePassportConsumerPolicyCertificationJson: "",
    releasePassportConsumerPolicyCertificationRoot: "",
    releasePassportRuntimeResumeEvidenceJson: "",
    releasePassportRuntimeResumeEvidenceCommand: "",
    releasePassportKfd1WitnessJsons: "",
    releasePassportKfd2ClaimJsons: "",
    releasePassportKfd3PrebuildWitnessJsons: "",
    releasePassportKfd3ArtifactWitnessJsons: "",
    releasePassportKfd3ArtifactVerifyCommand: "",
    releasePassportKfdAdopterManifestJson: "",
    releasePassportKfdSupportMatrixJson: "",
    releasePassportKfdProductGateJsons: "",
    releasePassportInvariantPassportJsons: "",
    releasePassportInvariantPassportCommand: "",
    releasePassportEvidenceJsons: "",
    releasePassportAttachmentCommand: "",
    releasePassportBuildchainSelfKfd: false,
    releasePassportGitHubArtifactAttestationPolicyJsons: "",
    promoteOnlyReleaseCandidate: false,
    releaseCandidatePassportPath:
      ".buildchain/artifacts/release-candidate-passport.json",
    releaseCandidateBuildSummaryPath:
      ".buildchain/artifacts/build-summary.json",
    releaseCandidateVersion: "",
    releaseCandidateRecoveryReceiptPath: "",
    releaseCandidateFamilyEvidenceRequired: false,
    releaseCandidateFamilyEvidenceRoot: "",
    releaseCandidateFamilyInitiativeId: "",
    releaseCandidateFamilyAssignmentId: "",
    actor: process.env.GITHUB_ACTOR || process.env.USER || "",
    runId: process.env.GITHUB_RUN_ID || "",
    publishTransactionOverride: false,
  };
  const allowed = new Set([...Object.keys(defaults), "octokit", "owner", "repo", "sha", "targetRef", "tags", "statusCheckOctokit", "pullRequestOctokit", "refUpdateOctokit", "tagUpdateOctokit", "publicationQualificationNow"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`unsupported promotion option: ${key}`);
  for (const [key, value] of Object.entries(defaults)) {
    if (normalized[key] === undefined) normalized[key] = value;
  }
  for (const key of [
    "statusCheckOctokit",
    "pullRequestOctokit",
    "refUpdateOctokit",
    "tagUpdateOctokit",
  ]) {
    if (normalized[key] === undefined) normalized[key] = normalized.octokit;
  }
  return normalized;
}

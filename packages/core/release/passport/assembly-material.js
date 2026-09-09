import {
  releaseField,
  nonEmptyString,
  optionalString,
  nowIso,
  firstTruthy,
} from "./identity.js";
import { normalizePublishEvidence } from "./publish.js";
import {
  normalizePackageSet,
  normalizeTrustedPublishing,
  normalizePublishSummary,
} from "./packages.js";
import { normalizeTransaction } from "./transaction.js";
import { preparePromotionBuild } from "./build.js";
import { normalizeRuntimeResumeEvidence } from "../../consumer/floating-consumer-release-passport.js";
import { runtimeResumeSourceSha } from "./consumer-input.js";
import { normalizeImpactLedger } from "./impact.js";
import { resolveKfd1Metadata } from "../../adoption/kfd-gate.js";
import { normalizeKfdAgentHubEvidence } from "./documents.js";
import { prepareReleasePassportKfdSections } from "../release-passport-contract.js";
import { createKfd2ReleaseTrustPassportAudit } from "./trust-claims.js";
import { prepareReleaseKfdAdopterArtifacts } from "./assembly-artifacts.js";
import { normalizeControllerReceiptReferences } from "../../observability/controller-evidence.js";
import { normalizeGitHubArtifactAttestationPolicy } from "../../build/github-artifact-attestation.js";
import { readPackageVersion } from "./discovery.js";
export function normalizeReleaseSourceFields(release) {
  return {
    builtSourceSha: releaseField(release, "builtSourceSha", "built_source_sha"),
    builtSourceTreeSha: releaseField(
      release,
      "builtSourceTreeSha",
      "built_source_tree_sha",
    ),
    promotionChannelSha: releaseField(
      release,
      "promotionChannelSha",
      "promotion_channel_sha",
    ),
    promotionChannelTreeSha: releaseField(
      release,
      "promotionChannelTreeSha",
      "promotion_channel_tree_sha",
    ),
  };
}
export function acceptedControllerSourceShas(input) {
  const {
    treeEquivalent,
    builtSourceSha,
    promotionChannelSha,
    sourceSha,
    recoveryTreeEquivalent,
  } = input;
  return treeEquivalent &&
    builtSourceSha &&
    (promotionChannelSha === sourceSha || recoveryTreeEquivalent)
    ? [builtSourceSha]
    : [];
}
export function preparePassportSections({
  assets,
  checkedAt,
  domainRuntimeResumeEvidence,
  impact,
  kfd1,
  kfd2Claims,
  kfd3,
  kfdAdopter,
  kfdAdopterGateEvidencePath,
  kfdAdopterManifestEvidencePath,
  kfdAgentHubEvidence,
  kfdSupport,
  kfdSupportEvidencePath,
  line,
  options,
  packageName,
  packageSet,
  packageVersion,
  publish,
  publishEvidence,
  release,
  repository,
  sourceSha,
  tag,
  transaction,
  trustedPublishing,
  workflow,
}) {
  const normalizedTag = nonEmptyString(tag, "tag");
  const { normalized: normalizedKfdAdopter, artifactEvidence } =
    prepareReleaseKfdAdopterArtifacts({
      kfdAdopter,
      assets,
      repository,
      tag: normalizedTag,
      sourceSha,
      workflow,
    });
  const normalizedPublishEvidence = normalizePublishEvidence(publishEvidence);
  const normalizedPackageSet = normalizePackageSet(packageSet, {
    packageName,
    packageVersion,
    publish,
  });
  const normalizedTrustedPublishing = normalizeTrustedPublishing(
    trustedPublishing,
    { workflow, publish },
  );
  const normalizedTransaction = normalizeTransaction(transaction);
  const { promotion, buildEvidence } = preparePromotionBuild(options);
  const normalizedRuntimeResume = normalizeRuntimeResumeEvidence(
    domainRuntimeResumeEvidence,
    {
      repository,
      sourceSha: runtimeResumeSourceSha(release, sourceSha),
      resumeRuntimeSha: promotion.routing?.runtime?.resolvedSha || "",
      consumerPolicyReceiptRoot:
        promotion.consumerPolicy?.certification?.receiptRoot || "",
    },
  );
  const normalizedImpact = normalizeImpactLedger(impact, {
    tag: normalizedTag,
    line,
  });
  const generatedAt = optionalString(checkedAt) || nowIso();
  const kfd1Metadata = resolveKfd1Metadata();
  const normalizedKfdAgentHub =
    normalizeKfdAgentHubEvidence(kfdAgentHubEvidence);
  const kfdParts = prepareReleasePassportKfdSections({
    kfd1,
    kfd2Claims,
    kfd3,
    kfdAdopter: normalizedKfdAdopter,
    kfdSupport,
    kfd1DefaultKey: kfd1Metadata.key,
    createKfd2: createKfd2ReleaseTrustPassportAudit,
    evidencePaths: {
      manifest: kfdAdopterManifestEvidencePath,
      gate: kfdAdopterGateEvidencePath,
      support: kfdSupportEvidencePath,
    },
  });
  return {
    artifactEvidence,
    buildEvidence,
    generatedAt,
    kfdParts,
    normalizedImpact,
    normalizedKfdAgentHub,
    normalizedPackageSet,
    normalizedPublishEvidence,
    normalizedRuntimeResume,
    normalizedTag,
    normalizedTransaction,
    normalizedTrustedPublishing,
    promotion,
  };
}
export function preparePassportReleaseIdentity({
  controllerReceiptReferences,
  controllerReceipts,
  cwd,
  githubArtifactAttestations,
  normalizedPackageSet,
  normalizedPublishEvidence,
  normalizedTransaction,
  packageVersion,
  publish,
  release,
  sourceSha,
}) {
  const sourceFields = normalizeReleaseSourceFields(release);
  const treeEquivalent = release.treeEquivalent === true;
  const recoveryTreeEquivalent = Boolean(
    treeEquivalent &&
    sourceFields.builtSourceTreeSha &&
    sourceFields.promotionChannelTreeSha &&
    sourceFields.builtSourceTreeSha === sourceFields.promotionChannelTreeSha,
  );
  const normalizedControllerReceipts = normalizeControllerReceiptReferences({
    receipts: controllerReceipts,
    references: controllerReceiptReferences,
    expectedSourceSha: sourceSha,
    acceptedSourceShas: acceptedControllerSourceShas({
      treeEquivalent,
      builtSourceSha: sourceFields.builtSourceSha,
      promotionChannelSha: sourceFields.promotionChannelSha,
      sourceSha,
      recoveryTreeEquivalent,
    }),
    requirePassed: true,
  });
  const normalizedGitHubArtifactAttestations = (
    githubArtifactAttestations || []
  ).map(normalizeGitHubArtifactAttestationPolicy);
  const publishArtifacts = normalizedPublishEvidence?.artifacts || [];
  const normalizedPublishSummary = normalizePublishSummary({
    packageSet: normalizedPackageSet,
    publishEvidence: normalizedPublishEvidence,
    publish,
  });
  const releaseMaterialSha = releaseField(
    release,
    "releaseMaterialSha",
    "release_material_sha",
    normalizedPublishEvidence?.releaseMaterialSha,
    normalizedTransaction?.releaseMaterialSha,
  );
  const releaseSha = releaseField(
    release,
    "releaseSha",
    "release_sha",
    normalizedPublishEvidence?.releaseSha,
    normalizedTransaction?.releaseSha,
  );
  const targetRef = releaseField(
    release,
    "targetRef",
    "target_ref",
    normalizedPublishEvidence?.targetRef,
  );
  const mainPublishedVersion = normalizedPublishSummary?.packages?.find(
    (entry) => entry.role === "main",
  )?.publishedVersion;
  const packageDisplayVersion = optionalString(
    firstTruthy(
      packageVersion,
      normalizedPackageSet?.main?.version,
      mainPublishedVersion,
      normalizedPublishEvidence?.version,
      normalizedTransaction?.version,
      readPackageVersion(cwd),
    ),
  );
  const publishedVersion = releaseField(
    release,
    "publishedVersion",
    "published_version",
    packageDisplayVersion,
  );
  const internalVersion = releaseField(
    release,
    "internalVersion",
    "internal_version",
    normalizedTransaction?.version,
  );
  return {
    internalVersion,
    normalizedControllerReceipts,
    normalizedGitHubArtifactAttestations,
    normalizedPublishSummary,
    packageDisplayVersion,
    publishArtifacts,
    publishedVersion,
    releaseMaterialSha,
    releaseSha,
    sourceFields,
    targetRef,
  };
}

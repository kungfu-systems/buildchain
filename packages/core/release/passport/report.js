import { RELEASE_CHECK_REPORT_CONTRACT } from "../release-passport-contract.js";
import { nowIso } from "./identity.js";
import {
  validateReleaseEvidenceContracts,
  validateReleaseEvidenceAttachments,
} from "./evidence-validation.js";
import { issue } from "./issues.js";
import { normalizePublishEvidence } from "./publish.js";
import {
  validateConsumerPolicyPassportSection,
  validateRuntimeResumePassportSection,
} from "./consumer-validation.js";
import {
  validatePublishEvidenceSection,
  validateReleaseArtifacts,
  validatePackageSet,
} from "./publish-validation.js";
import { indexEvidenceArtifacts } from "./artifact-index.js";
import {
  validateReleaseState,
  validateVersionMaterial,
} from "./state-validation.js";
import {
  createReleaseImpactContext,
  validateReleaseImpact,
} from "./impact-validation.js";
import { validatePassportTrustSections } from "./trust-validation.js";
export function buildReleaseCheckReport({
  checkedAt,
  issues,
  requiredSurfaceImpacts,
  artifacts,
  evidenceArtifacts,
  passport,
  impact,
  agentIndex,
  productMechanism,
  surfaceImpacts,
  releaseEvidence,
}) {
  const ok = issues.every((entry) => entry.level !== "error");
  return {
    schemaVersion: 1,
    contract: RELEASE_CHECK_REPORT_CONTRACT,
    checkedAt,
    ok,
    trust: ok ? "pass" : "fail",
    surfaceImpactRequirement: requiredSurfaceImpacts,
    completeness: {
      artifactCount: artifacts.length,
      evidenceArtifactCount: evidenceArtifacts.length,
      packageSetPresent: Boolean(passport?.packageSet),
      trustedPublishingPresent: Boolean(passport?.trustedPublishing),
      transactionPresent: Boolean(passport?.transaction),
      anchorManifestPresent: Boolean(passport?.anchorManifest),
      buildSummaryPresent: Boolean(passport?.buildSummary),
      platformArtifactManifestCount: Array.isArray(
        passport?.platformArtifactManifests,
      )
        ? passport.platformArtifactManifests.length
        : 0,
      distTagPromotionEvidencePresent: Boolean(passport?.distTagPromotion),
      impactPresent: Boolean(impact),
      agentIndexPresent: Boolean(agentIndex),
      productMechanismPresent: Boolean(productMechanism),
      surfaceImpactsRequired: requiredSurfaceImpacts.required,
      surfaceImpactCount: surfaceImpacts.length,
      versionImpact: impact?.versionImpact?.final || "",
      releaseEvidenceCount: releaseEvidence.length,
    },
    issues,
  };
}
export function createReleaseCheckReport({
  passport,
  artifactEvidence,
  publishEvidence,
  impact,
  agentIndex,
  productMechanism,
  kfdAgentHubEvidence,
  kfdSupportEvidence,
  kfdAdopterManifest,
  kfdAdopterManifestGate,
  releaseEvidenceDocuments = [],
  checkedAt = nowIso(),
} = {}) {
  const issues = [];
  validateReleaseEvidenceContracts({
    passport,
    artifactEvidence,
    impact,
    agentIndex,
    productMechanism,
    kfdAgentHubEvidence,
    kfdSupportEvidence,
    kfdAdopterManifest,
    kfdAdopterManifestGate,
    checkedAt,
    issues,
  });

  const tag = passport?.release?.tag || "";
  if (!tag) {
    issues.push(issue("error", "release.tag", "release.tag is required"));
  }
  if (!passport?.release?.sourceSha) {
    issues.push(
      issue("warning", "release.sourceSha", "release.sourceSha is recommended"),
    );
  }
  const artifacts = Array.isArray(passport?.artifacts)
    ? passport.artifacts
    : [];
  const normalizedPublishEvidence = normalizePublishEvidence(publishEvidence);
  const { evidenceArtifacts, releaseEvidence } =
    validateReleaseEvidenceAttachments({
      passport,
      artifactEvidence,
      normalizedPublishEvidence,
      releaseEvidenceDocuments,
      issues,
    });
  validateConsumerPolicyPassportSection({ passport, issues });
  validateRuntimeResumePassportSection({ passport, issues });
  validatePublishEvidenceSection({
    passport,
    publishEvidence,
    normalizedPublishEvidence,
    issues,
  });
  const evidenceIndex = indexEvidenceArtifacts(evidenceArtifacts);
  validateReleaseArtifacts({ artifacts, evidenceIndex, issues });
  validatePackageSet({ passport, evidenceIndex, issues });
  validateReleaseState({ passport, issues });
  validateVersionMaterial({ passport, issues });
  const impactContext = createReleaseImpactContext({ passport, impact });
  const { requiredSurfaceImpacts, surfaceImpacts } = impactContext;
  validatePassportTrustSections({ passport, issues });
  validateReleaseImpact({ passport, impact, context: impactContext, issues });
  return buildReleaseCheckReport({
    checkedAt,
    issues,
    requiredSurfaceImpacts,
    artifacts,
    evidenceArtifacts,
    passport,
    impact,
    agentIndex,
    productMechanism,
    surfaceImpacts,
    releaseEvidence,
  });
}

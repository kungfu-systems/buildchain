import {
  normalizeEvidenceDocument,
  normalizePlatformArtifactManifest,
} from "./documents.js";
import { normalizePromotionEvidence } from "../../consumer/floating-consumer-release-passport.js";
export function prepareBuildEvidence({
  buildSummary,
  buildFacts,
  platformArtifactManifests,
  distTagPromotionEvidence,
}) {
  return {
    buildSummary: buildSummary
      ? normalizeEvidenceDocument(buildSummary, "buildSummary")
      : undefined,
    buildFacts: (buildFacts || [])
      .map((value, index) =>
        normalizeEvidenceDocument(value, `buildFacts[${index}]`),
      )
      .filter(Boolean),
    platformArtifactManifests: (platformArtifactManifests || [])
      .map((manifest, index) =>
        normalizePlatformArtifactManifest(manifest, index),
      )
      .filter(Boolean),
    distTagPromotionEvidence: distTagPromotionEvidence
      ? normalizeEvidenceDocument(
          distTagPromotionEvidence,
          "distTagPromotionEvidence",
        )
      : undefined,
  };
}
export function preparePromotionBuild(options) {
  return {
    promotion: normalizePromotionEvidence(options),
    buildEvidence: prepareBuildEvidence(options),
  };
}

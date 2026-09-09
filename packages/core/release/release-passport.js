import { resolveReleasePassportVerificationInputs } from "./release-passport-contract.js";
import { nowIso } from "./passport/identity.js";
import {
  readJsonFromLocation,
  resolveSiblingJson,
} from "./passport/locations.js";
import { createReleaseCheckReport } from "./passport/report.js";
export async function verifyReleasePassport({
  passportLocation,
  artifactEvidenceLocation = "",
  publishEvidenceLocation = "",
  impactLocation = "",
  agentIndexLocation = "",
  productMechanismLocation = "",
  kfdAgentHubEvidenceLocation = "",
  kfdAdopterManifestLocation = "",
  kfdAdopterManifestGateLocation = "",
  kfdSupportEvidenceLocation = "",
  checkedAt = nowIso(),
} = {}) {
  const evidence = await resolveReleasePassportVerificationInputs({
    passportLocation,
    locations: {
      artifactEvidence: artifactEvidenceLocation,
      publishEvidence: publishEvidenceLocation,
      impact: impactLocation,
      agentIndex: agentIndexLocation,
      productMechanism: productMechanismLocation,
      kfdAgentHubEvidence: kfdAgentHubEvidenceLocation,
      kfdAdopterManifest: kfdAdopterManifestLocation,
      kfdAdopterManifestGate: kfdAdopterManifestGateLocation,
      kfdSupportEvidence: kfdSupportEvidenceLocation,
    },
    readJson: readJsonFromLocation,
    resolveSibling: resolveSiblingJson,
  });
  return createReleaseCheckReport({
    ...evidence,
    checkedAt,
  });
}
export async function explainReleasePassport({
  passportLocation,
  forAudience = "human",
} = {}) {
  const report = await verifyReleasePassport({ passportLocation });
  const passport = await readJsonFromLocation(passportLocation);
  const nextAction = report.ok
    ? "install-or-upgrade-after-policy-review"
    : "block-release-and-report-verification-failure";
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-explanation",
    audience: forAudience,
    release: passport.release,
    trust: report.trust,
    complete: report.ok,
    artifactCount: report.completeness.artifactCount,
    runnerPolicy: passport.runnerPolicy,
    impact: {
      versionImpact: passport.versionImpact || {},
      surfaceImpacts: Array.isArray(passport.surfaceImpacts)
        ? passport.surfaceImpacts
        : [],
      surfaceImpactRequirement: report.surfaceImpactRequirement,
      breaking: Boolean(passport.versionImpact?.final === "major"),
      migrationRequired: Boolean(passport.versionImpact?.final === "major"),
      summary: passport.versionImpact?.rationale || "",
    },
    recovery: passport.recovery,
    nextAction,
    issues: report.issues,
  };
}

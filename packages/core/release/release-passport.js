import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyPublishedDocuments } from "../publication/pipeline/stable-products.js";
import { resolveReleasePassportVerificationInputs } from "./release-passport-contract.js";
import { nowIso } from "./passport/identity.js";
import {
  readJsonFromLocation,
  resolveSiblingJson,
} from "./passport/locations.js";
import { createReleaseCheckReport } from "./passport/report.js";

async function verifyPipelinePassport(location, release, checkedAt, execute) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-passport-"),
  );
  const report = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-check-report",
    checkedAt,
    verificationScope: "signed-release-metadata",
    artifactBytesVerified: false,
    providerStateVerified: false,
    completeness: { artifactCount: 0 },
    issues: [],
  };
  try {
    const values = { release };
    for (const name of ["plan", "qualification", "capsules", "invocation"])
      values[name] = await resolveSiblingJson(
        location,
        `buildchain.${name}.json`,
      );
    const bundle = await resolveSiblingJson(
      location,
      "buildchain.attestation.json",
      { raw: true },
    );
    verifyPublishedDocuments(values, bundle, {
      directory,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
      execute,
    });
    report.completeness.artifactCount = values.qualification.artifacts.length;
    report.source = release.source;
    report.release = release.release;
  } catch {
    report.issues.push({
      level: "error",
      code: "pipeline.evidence",
      message:
        "Signed release metadata verification failed. Supply all five unchanged companion files and GitHub CLI with attestation verification support.",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  report.ok = report.issues.length === 0;
  report.trust = report.ok ? "pass" : "fail";
  return report;
}

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
  execute,
} = {}) {
  const passport = await readJsonFromLocation(passportLocation);
  if (passport?.schema === "kungfu.buildchain.release-passport/v4")
    return verifyPipelinePassport(
      passportLocation,
      passport,
      checkedAt,
      execute,
    );
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
  return createReleaseCheckReport({ ...evidence, checkedAt });
}
export async function explainReleasePassport({
  passportLocation,
  forAudience = "human",
} = {}) {
  const report = await verifyReleasePassport({ passportLocation });
  const passport = await readJsonFromLocation(passportLocation);
  const nextAction = report.ok
    ? report.verificationScope === "signed-release-metadata"
      ? "verify-artifact-bytes-and-review-policy"
      : "install-or-upgrade-after-policy-review"
    : "block-release-and-report-verification-failure";
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-explanation",
    audience: forAudience,
    release: passport.release,
    trust: report.trust,
    verificationScope: report.verificationScope,
    artifactBytesVerified: report.artifactBytesVerified,
    providerStateVerified: report.providerStateVerified,
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

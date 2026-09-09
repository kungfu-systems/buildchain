import { validateKfd2TrustTaxonomyEntry } from "../../adoption/kfd-gate.js";
import {
  optionalString,
  KFD2_TRUST_PROOF_CONTRACT,
  nowIso,
  KFD2_RELEASE_TRUST_PASSPORT_CONTRACT,
} from "./identity.js";
export function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}
export function arrayOrSingleton(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value && typeof value === "object" ? [value] : [];
}
export function normalizeKfd2Claim(raw = {}, index = 0) {
  const claim =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const {
    artifacts,
    auditBoundary,
    hashes,
    machineEvidence,
    responsibility,
    sourceBindings,
    verification,
  } = claimMachineFields({ claim });
  const residualRisk = arrayOrSingleton(
    claim.residualRisk || claim.residual_risk,
  ).map((entry, riskIndex) =>
    validateKfd2TrustTaxonomyEntry(entry, {
      kind: "residualRisk",
      label: `kfd-2.claims[${index}].residualRisk[${riskIndex}]`,
    }),
  );
  const downgradeReasons = arrayOrSingleton(
    claim.downgradeReasons ||
      claim.downgrade_reasons ||
      claim.downgradeReason ||
      claim.downgrade_reason,
  ).map((entry, reasonIndex) =>
    validateKfd2TrustTaxonomyEntry(entry, {
      kind: "downgradeReason",
      label: `kfd-2.claims[${index}].downgradeReasons[${reasonIndex}]`,
    }),
  );
  const trustProof =
    claim.trustProof &&
    typeof claim.trustProof === "object" &&
    !Array.isArray(claim.trustProof)
      ? claim.trustProof
      : undefined;
  const { missingBindings } = claimMissingBindings({
    artifacts,
    auditBoundary,
    claim,
    hashes,
    machineEvidence,
    responsibility,
    sourceBindings,
    verification,
  });
  const proseOnly = Boolean(
    claim.proseOnly ||
    claim.prose_only ||
    claim.support === "prose" ||
    claim.supportLevel === "prose",
  );
  const explicitStatus = optionalString(claim.status || claim.result);
  const status =
    explicitStatus ||
    (missingBindings.length > 0
      ? "failed"
      : proseOnly || residualRisk.length > 0
        ? "downgraded"
        : "passed");
  return {
    id: optionalString(claim.id || `claim-${index + 1}`),
    public: claim.public === undefined ? true : Boolean(claim.public),
    claim: optionalString(claim.claim || claim.statement || claim.summary),
    sourceBindings,
    machineEvidence,
    hashes,
    artifacts,
    verification,
    auditBoundary,
    responsibility,
    residualRisk,
    downgradeReasons,
    ...(trustProof ? { trustProof } : {}),
    proseOnly,
    missingBindings,
    status,
  };
}
export function kfd2ClaimFromKfd1World(world = {}, index = 0) {
  const sourceSurfaces = arrayOrEmpty(world.sourceVerification?.surfaces);
  const artifactSurfaces = arrayOrEmpty(world.artifactVerification?.surfaces);
  return normalizeKfd2Claim(
    {
      id: `kfd-1:${world.id || index + 1}`,
      public: true,
      claim: `KFD-1 contract world ${world.id || index + 1} is verified from declared source surfaces to packaged artifact bytes.`,
      sourceBindings: sourceSurfaces.map((surface) => ({
        id: surface.name,
        path: surface.sourcePath,
        sha256: surface.actualSha256 || surface.expectedSha256,
      })),
      machineEvidence: [
        { id: "kfd-1-witness", sha256: world.preBuildWitnessSha256 },
        {
          id: "source-verification",
          status: world.sourceVerification?.status || "",
        },
        {
          id: "artifact-verification",
          status: world.artifactVerification?.status || "",
        },
      ],
      hashes: {
        witnessSha256: world.preBuildWitnessSha256,
        sourceSha256: world.sourceHashes?.sha256 || "",
        artifactSha256: world.artifactHashes?.sha256 || "",
      },
      artifacts: artifactSurfaces.map((surface) => ({
        id: surface.name,
        path: surface.artifactPath,
        sha256: surface.actualSha256,
      })),
      verification: {
        result: world.result === "passed" ? "passed" : "failed",
        source: world.sourceVerification?.status || "",
        artifact: world.artifactVerification?.status || "",
      },
      auditBoundary: world.selfHostingBoundary,
      responsibility: world.responsibility,
      residualRisk: world.selfHostingBoundary?.residualRisk || [],
    },
    index,
  );
}
export function kfd2ClaimFromKfd3Interface(entry = {}, index = 0) {
  const witnessHashes = {
    prebuildWitnessSha256: entry.preBuildWitnessSha256,
    artifactWitnessSha256: entry.artifactWitnessSha256,
    prebuildCanonicalSha256:
      entry.witnessEvidence?.prebuild?.canonicalSha256 || "",
    artifactCanonicalSha256:
      entry.witnessEvidence?.artifact?.canonicalSha256 || "",
  };
  const reverseAuditBoundary =
    entry.reverseAudit?.auditBoundary || entry.auditBoundary;
  const residualRisk = arrayOrEmpty(entry.residualRisk);
  const proofResult =
    entry.trustProof?.result === "pass"
      ? residualRisk.length > 0
        ? "downgraded"
        : "passed"
      : "failed";
  return normalizeKfd2Claim(
    {
      id: `kfd-3:${entry.id || index + 1}`,
      public: true,
      claim: `KFD-3 collaboration interface ${entry.id || index + 1} exposes only declared public participant-facing shipped surfaces within its audit boundary.`,
      sourceBindings: arrayOrEmpty(entry.declaredSurfaces).map((surface) => ({
        id: surface.id,
        kind: surface.kind,
        sourcePath: surface.sourcePath,
      })),
      machineEvidence: [
        { id: "prebuild-witness", ...entry.witnessEvidence?.prebuild },
        { id: "artifact-witness", ...entry.witnessEvidence?.artifact },
        {
          id: "declared-capability-verification",
          result: entry.declaredCapabilityVerification?.result || "",
        },
        { id: "reverse-audit", result: entry.reverseAudit?.status || "" },
      ],
      hashes: {
        ...witnessHashes,
      },
      artifacts:
        entry.artifactWitness?.artifact?.name ||
        entry.artifactWitness?.artifact?.path
          ? [entry.artifactWitness.artifact]
          : arrayOrEmpty(entry.exposedSurfaces).map((surface) => ({
              id: surface.id,
              kind: surface.kind,
            })),
      verification: {
        result: entry.comparison?.status === "passed" ? "passed" : "failed",
        declaredCapabilityVerification:
          entry.declaredCapabilityVerification?.result || "",
        reverseAudit: entry.reverseAudit?.status || "",
      },
      auditBoundary: entry.auditBoundary,
      responsibility: entry.responsibility,
      residualRisk,
      trustProof: {
        contract: KFD2_TRUST_PROOF_CONTRACT,
        source: "kfd-3-collaboration-interface-release-gate",
        result: proofResult,
        statement: entry.trustProof?.statement || "",
        kfd3TrustProof: {
          contract: entry.trustProof?.contract || "",
          result: entry.trustProof?.result || "",
          releaseStatus:
            entry.trustProof?.releaseStatus || entry.releaseStatus || "",
        },
        witnessHashes,
        declaredCapabilityVerification: entry.declaredCapabilityVerification,
        reverseAudit: entry.reverseAudit,
        reverseAuditBoundary,
        residualRisk,
        responsibility: entry.responsibility,
      },
      status: proofResult,
    },
    index,
  );
}
export function createKfd2ReleaseTrustPassportAudit({
  explicitClaims = [],
  kfd1Section = undefined,
  kfd3Section = undefined,
  verifiedAt = nowIso(),
} = {}) {
  const generatedClaims = [
    ...arrayOrEmpty(kfd1Section?.contractWorlds).map((world, index) =>
      kfd2ClaimFromKfd1World(world, index),
    ),
    ...arrayOrEmpty(kfd3Section?.collaborationInterfaces).map((entry, index) =>
      kfd2ClaimFromKfd3Interface(entry, index),
    ),
  ];
  const claims = [
    ...generatedClaims,
    ...explicitClaims.map((claim, index) =>
      normalizeKfd2Claim(claim, generatedClaims.length + index),
    ),
  ];
  if (claims.length === 0) {
    return undefined;
  }
  const failed = claims.filter(
    (claim) => claim.public && claim.status === "failed",
  );
  const downgraded = claims.filter(
    (claim) =>
      claim.public && (claim.status === "downgraded" || claim.proseOnly),
  );
  const downgradeReasons = claims.flatMap((claim) =>
    arrayOrEmpty(claim.downgradeReasons),
  );
  return {
    schemaVersion: 1,
    contract: KFD2_RELEASE_TRUST_PASSPORT_CONTRACT,
    status:
      failed.length > 0
        ? "failed"
        : downgraded.length > 0
          ? "downgraded"
          : "passed",
    verifiedAt,
    auditBoundary: {
      scope: "public release claims visible to humans or agents",
      policy:
        "public claims must bind declared sources, machine-readable evidence, hashes, artifact coordinates, verification results, audit boundaries, responsibility state, and residual risk",
    },
    downgradeReasons,
    claims,
    summary: {
      claimCount: claims.length,
      failed: failed.length,
      downgraded: downgraded.length,
      proseOnly: claims.filter((claim) => claim.proseOnly).length,
    },
  };
}

function claimMissingBindings({
  artifacts,
  auditBoundary,
  claim,
  hashes,
  machineEvidence,
  responsibility,
  sourceBindings,
  verification,
}) {
  const missingBindings = [];
  if (sourceBindings.length === 0) missingBindings.push("declared-sources");
  if (machineEvidence.length === 0)
    missingBindings.push("machine-readable-evidence");
  if (Object.keys(hashes).length === 0) missingBindings.push("hashes");
  if (artifacts.length === 0) missingBindings.push("artifact-coordinates");
  if (!verification.result && !verification.status)
    missingBindings.push("verification-result");
  if (Object.keys(auditBoundary).length === 0)
    missingBindings.push("audit-boundary");
  if (
    !responsibility.owner &&
    !responsibility.sourceOwner &&
    !responsibility.sourceContractOwner &&
    !responsibility.releasePassportProofOwner
  ) {
    missingBindings.push("responsibility-state");
  }
  if (!Array.isArray(claim.residualRisk || claim.residual_risk))
    missingBindings.push("residual-risk");
  return { missingBindings };
}

function claimMachineFields({ claim }) {
  const sourceBindings = arrayOrEmpty(
    claim.sourceBindings ||
      claim.source_bindings ||
      claim.sources ||
      claim.declaredSources,
  );
  const machineEvidence = arrayOrEmpty(
    claim.machineEvidence || claim.machine_evidence || claim.evidence,
  );
  const hashes =
    claim.hashes &&
    typeof claim.hashes === "object" &&
    !Array.isArray(claim.hashes)
      ? claim.hashes
      : {};
  const artifacts = arrayOrEmpty(
    claim.artifacts || claim.artifactCoordinates || claim.artifact_coordinates,
  );
  const verification =
    claim.verification &&
    typeof claim.verification === "object" &&
    !Array.isArray(claim.verification)
      ? claim.verification
      : {};
  const auditBoundary =
    claim.auditBoundary &&
    typeof claim.auditBoundary === "object" &&
    !Array.isArray(claim.auditBoundary)
      ? claim.auditBoundary
      : claim.audit_boundary &&
          typeof claim.audit_boundary === "object" &&
          !Array.isArray(claim.audit_boundary)
        ? claim.audit_boundary
        : {};
  const responsibility =
    claim.responsibility &&
    typeof claim.responsibility === "object" &&
    !Array.isArray(claim.responsibility)
      ? claim.responsibility
      : {};
  return {
    artifacts,
    auditBoundary,
    hashes,
    machineEvidence,
    responsibility,
    sourceBindings,
    verification,
  };
}

import {
  devDeliveryContentRoot as contentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryText as text,
} from "./dev-delivery-common.js";
import {
  BUILDCHAIN_COMPATIBILITY_PROOF_REGISTRY_SCHEMA,
  BUILDCHAIN_COMPATIBILITY_RELEASE_EVIDENCE_SCHEMA,
  createBuildchainCompatibilityFactRegistry,
  createHistoricalBuildchainCompatibilityProofs,
  verifyBuildchainCompatibilityProof,
} from "./buildchain-compatibility-fact.js";
import {
  KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA,
  verifyKungfuTemporalPath,
} from "./kungfu-temporal-fact.js";

const COMPATIBILITY_OPERATION = "accept-contract-lock";
const COMPATIBILITY_DIRECTION = "source-to-target";

function exactText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function factInputFromProof(proof) {
  return {
    proofId: proof.proofId,
    surfaceId: proof.source.surfaceId,
    surfaceKind: proof.source.surfaceKind,
    sourceBreakingDigest: proof.source.breakingDigest,
    targetBreakingDigest: proof.target.breakingDigest,
    scope: proof.scope,
    evidence: proof.evidence,
    authority: proof.authority,
    cut: proof.cut,
  };
}

function projectionForSurface({ proofs, factByProofRoot, surface }) {
  const matching = proofs.filter(
    (proof) =>
      proof.target.surfaceId === surface.id &&
      proof.target.surfaceKind === surface.kind &&
      proof.target.breakingDigest === surface.breakingDigest &&
      proof.operation === COMPATIBILITY_OPERATION,
  );
  const bySource = new Map();
  for (const proof of matching) {
    const sourceDigest = proof.source.breakingDigest;
    if (bySource.has(sourceDigest))
      throw new Error(
        `ambiguous compatibility proof for ${surface.id} ${sourceDigest}`,
      );
    bySource.set(sourceDigest, proof);
  }
  return [...bySource.values()]
    .sort((left, right) =>
      left.source.breakingDigest.localeCompare(right.source.breakingDigest),
    )
    .map((proof) => ({
      breakingDigest: proof.source.breakingDigest,
      proofRoot: proof.proofRoot,
      factRoot: factByProofRoot.get(proof.proofRoot)?.factRoot || "",
    }));
}

export function createBuildchainCompatibilityProofRegistry({
  proofs = createHistoricalBuildchainCompatibilityProofs(),
  surfaces = [],
  majorLine = "",
} = {}) {
  const verifiedProofs = proofs
    .map((proof) => {
      const verification = verifyBuildchainCompatibilityProof(proof);
      if (!verification.ok)
        throw new Error(
          `invalid compatibility proof: ${verification.reason}${verification.error ? `: ${verification.error}` : ""}`,
        );
      return verification.proof;
    })
    .sort((left, right) => left.proofRoot.localeCompare(right.proofRoot));
  const factRegistry = createBuildchainCompatibilityFactRegistry({
    factInputs: verifiedProofs.map(factInputFromProof),
  });
  const factByProofRoot = new Map(
    factRegistry.facts.map((fact) => [fact.proof.proofRoot, fact]),
  );
  const projections = Object.fromEntries(
    [...surfaces]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((surface) => [
        surface.id,
        projectionForSurface({
          proofs: verifiedProofs,
          factByProofRoot,
          surface,
        }),
      ])
      .filter(([, entries]) => entries.length > 0),
  );
  const identity = {
    schema: BUILDCHAIN_COMPATIBILITY_PROOF_REGISTRY_SCHEMA,
    proofRoots: verifiedProofs.map((proof) => proof.proofRoot),
  };
  return {
    ...identity,
    proofs: verifiedProofs,
    facts: factRegistry.facts,
    factRegistry,
    factRegistryRoot: factRegistry.registryRoot,
    factCutRoot: factRegistry.currentCutRoot,
    projections,
    registryRoot: contentRoot(identity),
  };
}

export function assertBuildchainCompatibilityProjection(contractWorld) {
  if (
    !Array.isArray(contractWorld?.compatibilityFacts) ||
    !Array.isArray(contractWorld?.compatibilityProofs)
  ) {
    throw new Error(
      "compatibility Facts and their proof projection are required",
    );
  }
  const registry = createBuildchainCompatibilityProofRegistry({
    proofs: contractWorld.compatibilityProofs,
    surfaces: contractWorld.surfaces || [],
    majorLine: contractWorld.majorLine,
  });
  if (contractWorld.compatibilityProofRegistryRoot !== registry.registryRoot) {
    throw new Error("compatibility proof registry root mismatch");
  }
  if (
    contractWorld.compatibilityFactRegistryRoot !== registry.factRegistryRoot
  ) {
    throw new Error("compatibility Fact registry root mismatch");
  }
  if (contractWorld.compatibilityFactCutRoot !== registry.factCutRoot) {
    throw new Error("compatibility Fact Cut root mismatch");
  }
  if (
    JSON.stringify(contractWorld.compatibilityFacts) !==
    JSON.stringify(registry.facts)
  ) {
    throw new Error("compatibility Facts drift from the verified registry");
  }
  for (const surface of contractWorld.surfaces || []) {
    const expected = registry.projections[surface.id] || [];
    const expectedDigests = expected.map((entry) => entry.breakingDigest);
    const expectedRoots = expected.map((entry) => entry.proofRoot);
    const expectedFactRoots = expected.map((entry) => entry.factRoot);
    const actualDigests = surface.compatibleBreakingDigests || [];
    const actualRoots = surface.compatibilityProofRoots || [];
    const actualFactRoots = surface.compatibilityFactRoots || [];
    if (JSON.stringify(actualDigests) !== JSON.stringify(expectedDigests)) {
      throw new Error(
        `compatibleBreakingDigests projection mismatch for ${surface.id}`,
      );
    }
    if (JSON.stringify(actualRoots) !== JSON.stringify(expectedRoots)) {
      throw new Error(
        `compatibilityProofRoots projection mismatch for ${surface.id}`,
      );
    }
    if (JSON.stringify(actualFactRoots) !== JSON.stringify(expectedFactRoots)) {
      throw new Error(
        `compatibilityFactRoots projection mismatch for ${surface.id}`,
      );
    }
  }
  return {
    ok: true,
    reason: "exact-Fact-backed-projection",
    registryRoot: registry.registryRoot,
    factRegistryRoot: registry.factRegistryRoot,
    factCutRoot: registry.factCutRoot,
  };
}

export function verifyBuildchainCompatibilityPath({ registry, query } = {}) {
  if (!registry?.temporalBundle)
    throw new Error("compatibility Fact registry is required");
  return verifyKungfuTemporalPath(registry.temporalBundle, query);
}

export function createBuildchainCompatibilityPathQuery({
  registry,
  queryId,
  sourceRoot,
  targetRoot,
  relationPathRoots,
  maxDepth = 1,
} = {}) {
  if (!registry?.temporalBundle || registry.predicateRoots?.length !== 1) {
    throw new Error(
      "one exact compatibility Fact registry predicate is required",
    );
  }
  const predicateRoot = registry.predicateRoots[0];
  const predicate = registry.temporalBundle.predicates.find(
    (entry) => entry.root === predicateRoot,
  )?.record;
  return {
    schema: KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA,
    queryId: exactText(queryId, "queryId"),
    operation: COMPATIBILITY_OPERATION,
    predicateRoot,
    sourceRoot: exactRoot(sourceRoot, "sourceRoot"),
    targetRoot: exactRoot(targetRoot, "targetRoot"),
    cutRoot: exactRoot(registry.currentCutRoot, "currentCutRoot"),
    relationPathRoots: (relationPathRoots || []).map((entry) =>
      exactRoot(entry, "relationPathRoot"),
    ),
    requiredAuthorityRoot: exactRoot(
      predicate?.authorityRoot,
      "requiredAuthorityRoot",
    ),
    maxDepth,
  };
}

export function resolveBuildchainCompatibilityProof({
  registry,
  surface,
  sourceBreakingDigest,
  majorLine,
} = {}) {
  const candidates = (registry?.proofs || []).filter(
    (proof) =>
      proof.source.surfaceId === surface.id &&
      proof.source.surfaceKind === surface.kind &&
      proof.source.breakingDigest === sourceBreakingDigest &&
      proof.target.breakingDigest === surface.breakingDigest &&
      proof.operation === COMPATIBILITY_OPERATION,
  );
  if (candidates.length === 0)
    return { ok: false, reason: "compatibility-proof-missing" };
  if (candidates.length > 1)
    return { ok: false, reason: "ambiguous-compatibility-proof" };
  const verification = verifyBuildchainCompatibilityProof(candidates[0]);
  if (!verification.ok) return verification;
  const projection = registry.projections?.[surface.id] || [];
  if (
    !projection.some(
      (entry) =>
        entry.breakingDigest === sourceBreakingDigest &&
        entry.proofRoot === verification.proofRoot,
    )
  ) {
    return { ok: false, reason: "compatibility-proof-projection-missing" };
  }
  const fact = registry.factRegistry?.facts.find(
    (entry) => entry.proof.proofRoot === verification.proofRoot,
  );
  if (!fact) return { ok: false, reason: "compatibility-fact-missing" };
  const query = createBuildchainCompatibilityPathQuery({
    registry: registry.factRegistry,
    queryId: `buildchain:compatibility:${surface.id}:${sourceBreakingDigest}:${surface.breakingDigest}`,
    sourceRoot: fact.sourceRoot,
    targetRoot: fact.targetRoot,
    relationPathRoots: [fact.factRoot],
    maxDepth: 1,
  });
  const pathReceipt = verifyBuildchainCompatibilityPath({
    registry: registry.factRegistry,
    query,
  });
  if (pathReceipt.record.status !== "accepted") {
    return {
      ok: false,
      reason: pathReceipt.record.failureCode,
      pathReceipt,
      pathReceiptRoot: pathReceipt.root,
    };
  }
  return {
    ok: true,
    reason: "Fact-backed-compatible-relation",
    proof: verification.proof,
    proofRoot: verification.proofRoot,
    fact,
    factRoot: fact.factRoot,
    pathReceipt,
    pathReceiptRoot: pathReceipt.root,
  };
}

export function createBuildchainCompatibilityReleaseEvidence({
  contractWorld,
  release,
  decisions = [],
} = {}) {
  const projection = assertBuildchainCompatibilityProjection(contractWorld);
  const normalizedRelease = {
    sourceSha: exactSha(release?.sourceSha, "release.sourceSha"),
    tag: exactText(release?.tag, "release.tag"),
    channel: exactText(release?.channel, "release.channel"),
  };
  const rootSet = (field) =>
    [...new Set(decisions.map((entry) => entry[field]).filter(Boolean))]
      .map((entry) => exactRoot(entry, field))
      .sort();
  const compatibility = {
    operation: COMPATIBILITY_OPERATION,
    direction: COMPATIBILITY_DIRECTION,
    authority: "Fact-registry-only",
    grantsReleaseAuthority: false,
    contractDigest: exactRoot(
      contractWorld.contractDigest,
      "contractWorld.contractDigest",
    ),
    compatibilityDigest: exactRoot(
      contractWorld.compatibilityDigest,
      "contractWorld.compatibilityDigest",
    ),
    factRegistryRoot: projection.factRegistryRoot,
    factCutRoot: projection.factCutRoot,
    proofRegistryRoot: projection.registryRoot,
    usedFactRoots: rootSet("factRoot"),
    usedProofRoots: rootSet("proofRoot"),
    pathReceiptRoots: rootSet("pathReceiptRoot"),
  };
  const body = {
    schemaVersion: 1,
    contract: BUILDCHAIN_COMPATIBILITY_RELEASE_EVIDENCE_SCHEMA,
    id: "buildchain-compatibility-facts",
    kind: "compatibility-fact-lineage",
    release: normalizedRelease,
    compatibility,
  };
  return { ...body, evidenceRoot: contentRoot(body) };
}

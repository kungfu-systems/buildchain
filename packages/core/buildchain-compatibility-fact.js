import {
  devDeliveryClone as clone,
  devDeliveryContentRoot as contentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
} from "./dev-delivery-common.js";
import compatibilityFactSource from "./buildchain-compatibility-facts.json" with { type: "json" };
import {
  KUNGFU_FACT_ROOT_PROTOCOL,
  KUNGFU_TEMPORAL_BUNDLE_SCHEMA,
  KUNGFU_TEMPORAL_PATH_QUERY_SCHEMA,
  createKungfuTemporalEntry,
  verifyKungfuTemporalPath,
} from "./kungfu-temporal-fact.js";

export const BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA =
  "kungfu.buildchain.compatibility-proof/v1";
export const BUILDCHAIN_COMPATIBILITY_PROOF_REGISTRY_SCHEMA =
  "kungfu.buildchain.compatibility-proof-registry/v1";
export const BUILDCHAIN_COMPATIBILITY_FACT_SCHEMA =
  "kungfu.buildchain.compatibility-fact/v1";
export const BUILDCHAIN_COMPATIBILITY_FACT_REGISTRY_SCHEMA =
  "kungfu.buildchain.compatibility-fact-registry/v1";

const BUILDCHAIN_CONTRACT = "kungfu-buildchain-runtime-contract-world";
const COMPATIBILITY_PREDICATE = "compatible-breaking-digest";
const COMPATIBILITY_OPERATION = "accept-contract-lock";
const COMPATIBILITY_DIRECTION = "source-to-target";
const COMPATIBILITY_PREDICATE_ID =
  "kungfu.buildchain.compatibility:accept-contract-lock/v1";
const CURRENT_AUTHORITY = compatibilityFactSource.authority;
const CURRENT_PROOF_CUT = compatibilityFactSource.registryCut;

function exactText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function majorLines(values) {
  const normalized = [
    ...new Set((values || []).map((value) => exactText(value, "majorLine"))),
  ].sort();
  if (
    normalized.length === 0 ||
    normalized.some((value) => !/^v\d+$/.test(value))
  ) {
    throw new Error("scope.majorLines must contain version-major identifiers");
  }
  return normalized;
}

function normalizeEvidence(value = {}) {
  return {
    kind: exactText(value.kind, "evidence.kind"),
    pullRequest: exactText(value.pullRequest, "evidence.pullRequest"),
    protectedBase: protectedBase(value.protectedBase),
    sourceCommit: exactSha(value.sourceCommit, "evidence.sourceCommit"),
    mergeCommit: exactSha(value.mergeCommit, "evidence.mergeCommit"),
    contractDigest: exactRoot(value.contractDigest, "evidence.contractDigest"),
    compatibilityDigest: exactRoot(
      value.compatibilityDigest,
      "evidence.compatibilityDigest",
    ),
  };
}

function normalizeAuthority(value = {}) {
  return {
    kind: exactText(value.kind, "authority.kind"),
    repository: repository(value.repository),
    protectedBase: protectedBase(value.protectedBase),
  };
}

function normalizeCut(value = {}) {
  return {
    kind: exactText(value.kind, "cut.kind"),
    repository: repository(value.repository),
    protectedBase: protectedBase(value.protectedBase),
    commit: exactSha(value.commit, "cut.commit"),
  };
}

export function createBuildchainCompatibilityProof(input = {}) {
  const surfaceId = exactText(input.surfaceId, "surfaceId");
  const surfaceKind = exactText(input.surfaceKind, "surfaceKind");
  const sourceBreakingDigest = exactRoot(
    input.sourceBreakingDigest,
    "sourceBreakingDigest",
  );
  const targetBreakingDigest = exactRoot(
    input.targetBreakingDigest,
    "targetBreakingDigest",
  );
  if (sourceBreakingDigest === targetBreakingDigest) {
    throw new Error("compatibility proof source and target must differ");
  }
  const scope = {
    contract: BUILDCHAIN_CONTRACT,
    surfaceId,
    surfaceKind,
    majorLines: majorLines(input.scope?.majorLines || ["v2", "v3"]),
    operation: COMPATIBILITY_OPERATION,
  };
  const evidence = normalizeEvidence(input.evidence);
  const authority = normalizeAuthority(input.authority || CURRENT_AUTHORITY);
  const cut = normalizeCut(input.cut || CURRENT_PROOF_CUT);
  const body = {
    schema: BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA,
    proofId: exactText(input.proofId, "proofId"),
    predicate: COMPATIBILITY_PREDICATE,
    direction: COMPATIBILITY_DIRECTION,
    operation: COMPATIBILITY_OPERATION,
    source: {
      contract: BUILDCHAIN_CONTRACT,
      surfaceId,
      surfaceKind,
      breakingDigest: sourceBreakingDigest,
    },
    target: {
      contract: BUILDCHAIN_CONTRACT,
      surfaceId,
      surfaceKind,
      breakingDigest: targetBreakingDigest,
    },
    scope,
    scopeRoot: contentRoot(scope),
    evidence,
    evidenceRoot: contentRoot(evidence),
    authority,
    authorityRoot: contentRoot(authority),
    cut,
    cutRoot: contentRoot(cut),
  };
  return { ...body, proofRoot: contentRoot(body) };
}

export function verifyBuildchainCompatibilityProof(proofInput, expected = {}) {
  try {
    const proof = clone(proofInput || {});
    if (proof.schema !== BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA)
      return { ok: false, reason: "unsupported-schema" };
    const normalized = createBuildchainCompatibilityProof({
      ...proof,
      proofId: proof.proofId,
      surfaceId: proof.source?.surfaceId,
      surfaceKind: proof.source?.surfaceKind,
      sourceBreakingDigest: proof.source?.breakingDigest,
      targetBreakingDigest: proof.target?.breakingDigest,
      scope: proof.scope,
    });
    if (normalized.proofRoot !== proof.proofRoot)
      return { ok: false, reason: "proof-root-drift" };
    if (JSON.stringify(normalized) !== JSON.stringify(proof))
      return { ok: false, reason: "non-canonical-proof" };
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && normalized[field] !== value)
        return { ok: false, reason: `${field}-mismatch` };
    }
    return {
      ok: true,
      reason: "exact-compatibility-proof",
      proofRoot: normalized.proofRoot,
      proof: normalized,
    };
  } catch (error) {
    return { ok: false, reason: "invalid-proof", error: error.message };
  }
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

export function createBuildchainCompatibilityFact(input = {}) {
  const proof = createBuildchainCompatibilityProof(input);
  const predicate = {
    schema: "kungfu.fact.temporal-predicate/v1",
    predicateId: COMPATIBILITY_PREDICATE_ID,
    operations: [COMPATIBILITY_OPERATION],
    direction: COMPATIBILITY_DIRECTION,
    pathPolicy: "explicit-bounded",
    cyclePolicy: "forbid",
    authorityRoot: proof.authorityRoot,
  };
  const predicateEntry = createKungfuTemporalEntry(predicate);
  const relation = {
    schema: "kungfu.fact.temporal-relation/v1",
    relationId: `buildchain:compatibility:${proof.proofId}`,
    predicateRoot: predicateEntry.root,
    sourceRoot: contentRoot(proof.source),
    targetRoot: contentRoot(proof.target),
    validFromCutRoot: proof.cutRoot,
    scopeRoot: proof.scopeRoot,
    authorityRoot: proof.authorityRoot,
    admissionRoots: [proof.evidenceRoot],
  };
  const relationEntry = createKungfuTemporalEntry(relation);
  return {
    schema: BUILDCHAIN_COMPATIBILITY_FACT_SCHEMA,
    factId: proof.proofId,
    factRoot: relationEntry.root,
    sourceRoot: relation.sourceRoot,
    targetRoot: relation.targetRoot,
    predicate: predicateEntry,
    relation: relationEntry,
    proof,
  };
}

export function verifyBuildchainCompatibilityFact(factInput) {
  try {
    const fact = clone(factInput || {});
    if (fact.schema !== BUILDCHAIN_COMPATIBILITY_FACT_SCHEMA)
      return { ok: false, reason: "unsupported-schema" };
    const normalized = createBuildchainCompatibilityFact(
      factInputFromProof(fact.proof),
    );
    if (normalized.factRoot !== fact.factRoot)
      return { ok: false, reason: "fact-root-drift" };
    if (JSON.stringify(normalized) !== JSON.stringify(fact))
      return { ok: false, reason: "non-canonical-fact" };
    return {
      ok: true,
      reason: "exact-cut-bound-compatibility-fact",
      fact: normalized,
      factRoot: normalized.factRoot,
    };
  } catch (error) {
    return { ok: false, reason: "invalid-fact", error: error.message };
  }
}

export function createBuildchainCompatibilityFactRegistry({
  factInputs = compatibilityFactSource.facts.map((entry) => ({
    ...entry,
    authority: compatibilityFactSource.authority,
  })),
  registryCut = compatibilityFactSource.registryCut,
  supersessions = compatibilityFactSource.supersessions,
  revocations = compatibilityFactSource.revocations,
} = {}) {
  if (
    compatibilityFactSource.schema !==
    "kungfu.buildchain.compatibility-fact-source/v1"
  ) {
    throw new Error("compatibility Fact source schema is unsupported");
  }
  if (compatibilityFactSource.rootProtocol !== KUNGFU_FACT_ROOT_PROTOCOL) {
    throw new Error("compatibility Fact source root protocol mismatch");
  }
  const facts = factInputs
    .map(createBuildchainCompatibilityFact)
    .sort((left, right) => left.factRoot.localeCompare(right.factRoot));
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length)
    throw new Error("duplicate compatibility Fact id");
  if (new Set(facts.map((fact) => fact.factRoot)).size !== facts.length)
    throw new Error("duplicate compatibility Fact root");
  for (const fact of facts) {
    const verification = verifyBuildchainCompatibilityFact(fact);
    if (!verification.ok)
      throw new Error(`invalid compatibility Fact: ${verification.reason}`);
  }
  const predicates = [
    ...new Map(
      facts.map((fact) => [fact.predicate.root, fact.predicate]),
    ).values(),
  ].sort((left, right) => left.root.localeCompare(right.root));
  const relationEntries = facts
    .map((fact) => fact.relation)
    .sort((left, right) => left.root.localeCompare(right.root));
  const leafCuts = new Map();
  for (const fact of facts) {
    const cutRoot = fact.proof.cutRoot;
    const current = leafCuts.get(cutRoot) || {
      root: cutRoot,
      parentCutRoots: [],
      activeRelationRoots: [],
      declarationRoots: predicates.map((entry) => entry.root),
    };
    current.activeRelationRoots.push(fact.factRoot);
    current.activeRelationRoots.sort();
    leafCuts.set(cutRoot, current);
  }
  const currentCut = normalizeCut(registryCut);
  const currentCutRoot = contentRoot(currentCut);
  const cuts = [...leafCuts.values()].sort((left, right) =>
    left.root.localeCompare(right.root),
  );
  if (leafCuts.has(currentCutRoot)) {
    const cut = leafCuts.get(currentCutRoot);
    cut.activeRelationRoots = facts.map((fact) => fact.factRoot).sort();
  } else {
    cuts.push({
      root: currentCutRoot,
      parentCutRoots: [...leafCuts.keys()].sort(),
      activeRelationRoots: facts.map((fact) => fact.factRoot).sort(),
      declarationRoots: predicates.map((entry) => entry.root),
    });
  }
  const supersessionEntries = (supersessions || [])
    .map(createKungfuTemporalEntry)
    .sort((left, right) => left.root.localeCompare(right.root));
  const revocationEntries = (revocations || [])
    .map(createKungfuTemporalEntry)
    .sort((left, right) => left.root.localeCompare(right.root));
  const temporalBundle = {
    schema: KUNGFU_TEMPORAL_BUNDLE_SCHEMA,
    cuts,
    predicates,
    relations: relationEntries,
    supersessions: supersessionEntries,
    revocations: revocationEntries,
    authorityProofs: [],
    provenanceObjects: [],
  };
  const identity = {
    schema: BUILDCHAIN_COMPATIBILITY_FACT_REGISTRY_SCHEMA,
    rootProtocol: KUNGFU_FACT_ROOT_PROTOCOL,
    currentCutRoot,
    predicateRoots: predicates.map((entry) => entry.root),
    factRoots: facts.map((fact) => fact.factRoot),
    supersessionRoots: supersessionEntries.map((entry) => entry.root),
    revocationRoots: revocationEntries.map((entry) => entry.root),
    legacyProofRoots: facts.map((fact) => fact.proof.proofRoot).sort(),
    temporalBundleRoot: contentRoot(temporalBundle),
  };
  return {
    ...identity,
    facts,
    legacyProofs: facts
      .map((fact) => fact.proof)
      .sort((left, right) => left.proofRoot.localeCompare(right.proofRoot)),
    currentCut,
    temporalBundle,
    registryRoot: contentRoot(identity),
  };
}

export function createHistoricalBuildchainCompatibilityFacts() {
  return createBuildchainCompatibilityFactRegistry().facts;
}

export function createHistoricalBuildchainCompatibilityProofs() {
  return createBuildchainCompatibilityFactRegistry().legacyProofs;
}

function projectionForSurface({ proofs, factByProofRoot, surface, majorLine }) {
  const matching = proofs.filter(
    (proof) =>
      proof.target.surfaceId === surface.id &&
      proof.target.surfaceKind === surface.kind &&
      proof.target.breakingDigest === surface.breakingDigest &&
      proof.scope.majorLines.includes(majorLine) &&
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
          majorLine,
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
      proof.scope.majorLines.includes(majorLine) &&
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

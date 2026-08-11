import {
  devDeliveryClone as clone,
  devDeliveryContentRoot as contentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
} from "./dev-delivery-common.js";
import { evaluateBuildchainChannelBinding } from "./buildchain-channel-identity.js";

export const BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA = "kungfu.buildchain.compatibility-proof/v1";
export const BUILDCHAIN_COMPATIBILITY_PROOF_REGISTRY_SCHEMA = "kungfu.buildchain.compatibility-proof-registry/v1";
export const BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA = "kungfu.buildchain.compatibility-verification-receipt/v1";

const BUILDCHAIN_CONTRACT = "kungfu-buildchain-runtime-contract-world";
const COMPATIBILITY_PREDICATE = "compatible-breaking-digest";
const COMPATIBILITY_OPERATION = "accept-contract-lock";
const COMPATIBILITY_DIRECTION = "source-to-target";
const CURRENT_PROOF_CUT = {
  kind: "protected-git-cut",
  repository: "kungfu-systems/buildchain",
  protectedBase: "dev/v3/v3.0",
  commit: "ff0f9006be1c8f63be40e67789e0cfd28fd69d46",
};
const CURRENT_AUTHORITY = {
  kind: "protected-base-contract-authority",
  repository: "kungfu-systems/buildchain",
  protectedBase: "dev/v3/v3.0",
};

const HISTORICAL_ACCEPTANCES = [
  {
    proofId: "release-candidate-promote-acd401-to-e60642",
    surfaceId: "release-candidate-promote",
    surfaceKind: "workflow",
    sourceBreakingDigest: "sha256:acd401cfc46450115a3763fd4b679d85f185e8757ebd52510d6262e1533df4cf",
    targetBreakingDigest: "sha256:e60642aa298933d2c103284794921a6c340a50aa91ee528b06e58892a2a006bf",
    evidence: {
      kind: "protected-pull-request-contract-acceptance",
      pullRequest: "https://github.com/kungfu-systems/buildchain/pull/2342",
      protectedBase: "dev/v3/v3.0",
      sourceCommit: "8870db287a9ee5fb95eebbbe907b1649d84d5b7f",
      mergeCommit: "30b605adea1ed33dcf0bbb4cc7b666b64a6ccd18",
      contractDigest: "sha256:9c07dbdb9aa8390569cd07ace044af45e6751b91ffe8fcc0cb69a77388b0f72b",
      compatibilityDigest: "sha256:80cfdf1786019217c439810f1a80d2866bf8f7ef35a6fa569e1a687fb2bf4cbe",
    },
  },
  {
    proofId: "advanced-release-candidate-promote-aa30f2-to-9db8dd",
    surfaceId: "advanced-release-candidate-promote",
    surfaceKind: "workflow",
    sourceBreakingDigest: "sha256:aa30f22e3af0a89841310bdbdc900844dd95a66974db173fa140a71bbd7e82c0",
    targetBreakingDigest: "sha256:9db8dd07152855d03ff30f9c571438593c689d3e8139fa45431d000f548242f5",
    evidence: {
      kind: "protected-pull-request-contract-acceptance",
      pullRequest: "https://github.com/kungfu-systems/buildchain/pull/2342",
      protectedBase: "dev/v3/v3.0",
      sourceCommit: "8870db287a9ee5fb95eebbbe907b1649d84d5b7f",
      mergeCommit: "30b605adea1ed33dcf0bbb4cc7b666b64a6ccd18",
      contractDigest: "sha256:9c07dbdb9aa8390569cd07ace044af45e6751b91ffe8fcc0cb69a77388b0f72b",
      compatibilityDigest: "sha256:80cfdf1786019217c439810f1a80d2866bf8f7ef35a6fa569e1a687fb2bf4cbe",
    },
  },
  {
    proofId: "promote-buildchain-ref-action-a59f09-to-6147c0",
    surfaceId: "promote-buildchain-ref-action",
    surfaceKind: "action",
    sourceBreakingDigest: "sha256:a59f0910e6df842e7699139472e5dd69ac2fdd7f7213bf2cb346d1d622556874",
    targetBreakingDigest: "sha256:6147c0a8d5c36bfaa6021871574e1fc28192a3f1b8cfdae4d24ef3059ac1ebda",
    evidence: {
      kind: "protected-pull-request-contract-acceptance",
      pullRequest: "https://github.com/kungfu-systems/buildchain/pull/1556",
      protectedBase: "dev/v2/v2.14",
      sourceCommit: "f8e2c5d28ef34d711892589331b7e018095a96d7",
      mergeCommit: "6e0c29be1489f686a9a3792b46bfaa4466828393",
      contractDigest: "sha256:f6dbf5147d9ad3b8c49ba6630cd52b8c7853ead7c921d7e1210a393aebf97d1f",
      compatibilityDigest: "sha256:cdf588422ec6b460bd6f631400efa6e361a045e052c8967d6c50fadd7aa4dd90",
    },
  },
  {
    proofId: "build-lifecycle-e264a7-to-6b8d38",
    surfaceId: "controller:build-lifecycle",
    surfaceKind: "controller",
    sourceBreakingDigest: "sha256:e264a79f9f399038c2fcfd21e4168c68c2e1485ee5c651c02242a02b622ac2be",
    targetBreakingDigest: "sha256:6b8d38e92b2c67b5bc83fae0a3fd95bfa47582fbc176e6cdeebe7630a57534cb",
    evidence: {
      kind: "protected-pull-request-contract-acceptance",
      pullRequest: "https://github.com/kungfu-systems/buildchain/pull/2058",
      protectedBase: "dev/v3/v3.0",
      sourceCommit: "c9a86bd1ac17b4fae54b0410498830edad80d831",
      mergeCommit: "3991801a7a7d6fe5e31b9a670dfde7ea59e61253",
      contractDigest: "sha256:da72850bbd3088f0e9eb20c17382557e0dfb7e68bf4469d352ed870ee8a334e8",
      compatibilityDigest: "sha256:32a651504c57829085dc8863f0e41dee98eb60708ff6dec958c9c7e4b1010102",
    },
  },
  {
    proofId: "build-lifecycle-307459-to-6b8d38",
    surfaceId: "controller:build-lifecycle",
    surfaceKind: "controller",
    sourceBreakingDigest: "sha256:30745921541e9b0f70475bb2178c2559f6aef248f6680670ccd44d8c5a69a6b1",
    targetBreakingDigest: "sha256:6b8d38e92b2c67b5bc83fae0a3fd95bfa47582fbc176e6cdeebe7630a57534cb",
    evidence: {
      kind: "protected-pull-request-contract-acceptance",
      pullRequest: "https://github.com/kungfu-systems/buildchain/pull/2058",
      protectedBase: "dev/v3/v3.0",
      sourceCommit: "c9a86bd1ac17b4fae54b0410498830edad80d831",
      mergeCommit: "3991801a7a7d6fe5e31b9a670dfde7ea59e61253",
      contractDigest: "sha256:da72850bbd3088f0e9eb20c17382557e0dfb7e68bf4469d352ed870ee8a334e8",
      compatibilityDigest: "sha256:32a651504c57829085dc8863f0e41dee98eb60708ff6dec958c9c7e4b1010102",
    },
  },
];

function exactText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function majorLines(values) {
  const normalized = [...new Set((values || []).map((value) => exactText(value, "majorLine")))].sort();
  if (normalized.length === 0 || normalized.some((value) => !/^v\d+$/.test(value))) {
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
    compatibilityDigest: exactRoot(value.compatibilityDigest, "evidence.compatibilityDigest"),
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
  const sourceBreakingDigest = exactRoot(input.sourceBreakingDigest, "sourceBreakingDigest");
  const targetBreakingDigest = exactRoot(input.targetBreakingDigest, "targetBreakingDigest");
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
    if (proof.schema !== BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA) return { ok: false, reason: "unsupported-schema" };
    const normalized = createBuildchainCompatibilityProof({
      ...proof,
      proofId: proof.proofId,
      surfaceId: proof.source?.surfaceId,
      surfaceKind: proof.source?.surfaceKind,
      sourceBreakingDigest: proof.source?.breakingDigest,
      targetBreakingDigest: proof.target?.breakingDigest,
      scope: proof.scope,
    });
    if (normalized.proofRoot !== proof.proofRoot) return { ok: false, reason: "proof-root-drift" };
    if (JSON.stringify(normalized) !== JSON.stringify(proof)) return { ok: false, reason: "non-canonical-proof" };
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && normalized[field] !== value) return { ok: false, reason: `${field}-mismatch` };
    }
    return { ok: true, reason: "exact-compatibility-proof", proofRoot: normalized.proofRoot, proof: normalized };
  } catch (error) {
    return { ok: false, reason: "invalid-proof", error: error.message };
  }
}

export function createHistoricalBuildchainCompatibilityProofs() {
  return HISTORICAL_ACCEPTANCES.map((entry) => createBuildchainCompatibilityProof(entry)).sort((left, right) => left.proofRoot.localeCompare(right.proofRoot));
}

function projectionForSurface({ proofs, surface, majorLine }) {
  const matching = proofs.filter((proof) => (
    proof.target.surfaceId === surface.id
    && proof.target.surfaceKind === surface.kind
    && proof.target.breakingDigest === surface.breakingDigest
    && proof.scope.majorLines.includes(majorLine)
    && proof.operation === COMPATIBILITY_OPERATION
  ));
  const bySource = new Map();
  for (const proof of matching) {
    const sourceDigest = proof.source.breakingDigest;
    if (bySource.has(sourceDigest)) throw new Error(`ambiguous compatibility proof for ${surface.id} ${sourceDigest}`);
    bySource.set(sourceDigest, proof);
  }
  return [...bySource.values()]
    .sort((left, right) => left.source.breakingDigest.localeCompare(right.source.breakingDigest))
    .map((proof) => ({ breakingDigest: proof.source.breakingDigest, proofRoot: proof.proofRoot }));
}

export function createBuildchainCompatibilityProofRegistry({ proofs = createHistoricalBuildchainCompatibilityProofs(), surfaces = [], majorLine = "" } = {}) {
  const verifiedProofs = proofs.map((proof) => {
    const verification = verifyBuildchainCompatibilityProof(proof);
    if (!verification.ok) throw new Error(`invalid compatibility proof: ${verification.reason}${verification.error ? `: ${verification.error}` : ""}`);
    return verification.proof;
  }).sort((left, right) => left.proofRoot.localeCompare(right.proofRoot));
  const projections = Object.fromEntries(
    [...surfaces]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((surface) => [surface.id, projectionForSurface({ proofs: verifiedProofs, surface, majorLine })])
      .filter(([, entries]) => entries.length > 0),
  );
  const identity = {
    schema: BUILDCHAIN_COMPATIBILITY_PROOF_REGISTRY_SCHEMA,
    proofRoots: verifiedProofs.map((proof) => proof.proofRoot),
  };
  return {
    ...identity,
    proofs: verifiedProofs,
    projections,
    registryRoot: contentRoot(identity),
  };
}

export function assertBuildchainCompatibilityProjection(contractWorld) {
  if (!Array.isArray(contractWorld?.compatibilityProofs)) return { ok: true, reason: "legacy-world-without-proofs" };
  const registry = createBuildchainCompatibilityProofRegistry({
    proofs: contractWorld.compatibilityProofs,
    surfaces: contractWorld.surfaces || [],
    majorLine: contractWorld.majorLine,
  });
  if (contractWorld.compatibilityProofRegistryRoot !== registry.registryRoot) {
    throw new Error("compatibility proof registry root mismatch");
  }
  for (const surface of contractWorld.surfaces || []) {
    const expected = registry.projections[surface.id] || [];
    const expectedDigests = expected.map((entry) => entry.breakingDigest);
    const expectedRoots = expected.map((entry) => entry.proofRoot);
    const actualDigests = surface.compatibleBreakingDigests || [];
    const actualRoots = surface.compatibilityProofRoots || [];
    if (JSON.stringify(actualDigests) !== JSON.stringify(expectedDigests)) {
      throw new Error(`compatibleBreakingDigests projection mismatch for ${surface.id}`);
    }
    if (JSON.stringify(actualRoots) !== JSON.stringify(expectedRoots)) {
      throw new Error(`compatibilityProofRoots projection mismatch for ${surface.id}`);
    }
  }
  return { ok: true, reason: "exact-proof-backed-projection", registryRoot: registry.registryRoot };
}

export function resolveBuildchainCompatibilityProof({ registry, surface, sourceBreakingDigest, majorLine } = {}) {
  const candidates = (registry?.proofs || []).filter((proof) => (
    proof.source.surfaceId === surface.id
    && proof.source.surfaceKind === surface.kind
    && proof.source.breakingDigest === sourceBreakingDigest
    && proof.target.breakingDigest === surface.breakingDigest
    && proof.scope.majorLines.includes(majorLine)
    && proof.operation === COMPATIBILITY_OPERATION
  ));
  if (candidates.length === 0) return { ok: false, reason: "compatibility-proof-missing" };
  if (candidates.length > 1) return { ok: false, reason: "ambiguous-compatibility-proof" };
  const verification = verifyBuildchainCompatibilityProof(candidates[0]);
  if (!verification.ok) return verification;
  const projection = registry.projections?.[surface.id] || [];
  if (!projection.some((entry) => entry.breakingDigest === sourceBreakingDigest && entry.proofRoot === verification.proofRoot)) {
    return { ok: false, reason: "compatibility-proof-projection-missing" };
  }
  return { ok: true, reason: "proof-backed-compatible-relation", proof: verification.proof, proofRoot: verification.proofRoot };
}

export function createBuildchainCompatibilityVerificationReceipt(input = {}) {
  const decisions = clone(input.decisions || []);
  const usedProofRoots = [...new Set(decisions.map((decision) => decision.proofRoot).filter(Boolean).map((root) => exactRoot(root, "decision.proofRoot")))].sort();
  const body = {
    schema: BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA,
    operation: COMPATIBILITY_OPERATION,
    direction: COMPATIBILITY_DIRECTION,
    status: exactText(input.status, "status"),
    compatible: input.compatible === true,
    policy: exactText(input.policy, "policy"),
    scope: clone(input.scope || {}),
    acceptedContractDigest: text(input.acceptedContractDigest),
    acceptedCompatibilityDigest: text(input.acceptedCompatibilityDigest),
    acceptedProofRegistryRoot: text(input.acceptedProofRegistryRoot),
    currentContractDigest: text(input.currentContractDigest),
    currentCompatibilityDigest: text(input.currentCompatibilityDigest),
    currentProofRegistryRoot: text(input.currentProofRegistryRoot),
    decisions,
    usedProofRoots,
    reasonCodes: [...new Set((input.reasonCodes || []).map((reason) => exactText(reason, "reasonCode")))].sort(),
  };
  return { ...body, receiptRoot: contentRoot(body) };
}

export function verifyBuildchainCompatibilityVerificationReceipt(receiptInput) {
  try {
    const receipt = clone(receiptInput || {});
    if (receipt.schema !== BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA) return { ok: false, reason: "unsupported-schema" };
    const normalized = createBuildchainCompatibilityVerificationReceipt(receipt);
    if (normalized.receiptRoot !== receipt.receiptRoot) return { ok: false, reason: "receipt-root-drift" };
    if (JSON.stringify(normalized) !== JSON.stringify(receipt)) return { ok: false, reason: "non-canonical-receipt" };
    return { ok: true, reason: "exact-compatibility-verification-receipt", receiptRoot: receipt.receiptRoot };
  } catch (error) {
    return { ok: false, reason: "invalid-receipt", error: error.message };
  }
}

export function contractSummary(contractWorld, runtimeRef = "", runtimeSha = "") {
  return {
    ref: runtimeRef,
    resolvedSha: runtimeSha,
    contract: contractWorld.contract,
    contractDigest: contractWorld.contractDigest,
    compatibilityDigest: contractWorld.compatibilityDigest,
    compatibilityProofRegistryRoot: contractWorld.compatibilityProofRegistryRoot,
    majorLine: contractWorld.majorLine,
    surfaceCount: Array.isArray(contractWorld.surfaces) ? contractWorld.surfaces.length : 0,
  };
}

function evaluationReceipt({ status, compatible, policy, accepted, current, decisions = [], reasons = [] }) {
  return createBuildchainCompatibilityVerificationReceipt({
    status,
    compatible,
    policy,
    scope: { contract: current.contract, majorLine: current.majorLine },
    acceptedContractDigest: accepted.contractDigest,
    acceptedCompatibilityDigest: accepted.compatibilityDigest,
    acceptedProofRegistryRoot: accepted.compatibilityProofRegistryRoot,
    currentContractDigest: current.contractDigest,
    currentCompatibilityDigest: current.compatibilityDigest,
    currentProofRegistryRoot: current.compatibilityProofRegistryRoot,
    decisions,
    reasonCodes: reasons,
  });
}

function contractPolicyReasons(accepted, current, policy) {
  const reasons = [];
  if (accepted.contract !== current.contract) reasons.push(`contract changed from ${accepted.contract || "(unknown)"} to ${current.contract}`);
  if (accepted.majorLine && accepted.majorLine !== current.majorLine) reasons.push(`major line changed from ${accepted.majorLine} to ${current.majorLine}`);
  if (policy === "exact" && accepted.contractDigest !== current.contractDigest) reasons.push("exact policy requires the contract digest to remain unchanged");
  if (!["major-compatible", "allow-additive", "exact"].includes(policy)) reasons.push(`unsupported compatibility policy: ${policy}`);
  return reasons;
}

function evaluateSurfaceRelation({ oldSurface, nextSurface, proofRegistry, majorLine }) {
  if (!nextSurface) {
    return {
      reason: `surface removed: ${oldSurface.id}`,
      decision: { surfaceId: oldSurface.id, status: "surface-removed", sourceBreakingDigest: oldSurface.breakingDigest, targetBreakingDigest: "", reason: "surface-removed" },
    };
  }
  if (nextSurface.breakingDigest === oldSurface.breakingDigest) return {};
  const resolution = resolveBuildchainCompatibilityProof({
    registry: proofRegistry,
    surface: nextSurface,
    sourceBreakingDigest: oldSurface.breakingDigest,
    majorLine,
  });
  if (!resolution.ok) {
    return {
      reason: `surface breaking digest changed without a valid compatibility proof: ${oldSurface.id} (${resolution.reason})`,
      decision: { surfaceId: oldSurface.id, status: "rejected", sourceBreakingDigest: oldSurface.breakingDigest, targetBreakingDigest: nextSurface.breakingDigest, reason: resolution.reason },
    };
  }
  const proof = resolution.proof;
  return {
    decision: {
      surfaceId: oldSurface.id,
      status: "accepted",
      sourceBreakingDigest: oldSurface.breakingDigest,
      targetBreakingDigest: nextSurface.breakingDigest,
      proofRoot: proof.proofRoot,
      direction: proof.direction,
      operation: proof.operation,
      scope: proof.scope,
      scopeRoot: proof.scopeRoot,
      evidence: proof.evidence,
      evidenceRoot: proof.evidenceRoot,
      authority: proof.authority,
      authorityRoot: proof.authorityRoot,
      cut: proof.cut,
      cutRoot: proof.cutRoot,
    },
  };
}

function evaluateChannelBinding({ lock, workflowShellRef, runtimeRef, expectedChannel, expectedMajor, allowOpaqueRuntime }) {
  if (!workflowShellRef && !expectedChannel && !expectedMajor) return null;
  return evaluateBuildchainChannelBinding({
    workflowShellRef,
    runtimeRef,
    lockRef: lock?.buildchain?.ref || "",
    lockMajorLine: lock?.buildchain?.majorLine || "",
    expectedChannel,
    expectedMajor,
    allowOpaqueRuntime,
  });
}

export function evaluateBuildchainContractLock({
  lock,
  current,
  runtimeRef = "",
  runtimeSha = "",
  runtimeClass = "",
  compatibilityPolicy = "",
  workflowShellRef = "",
  expectedChannel = "",
  expectedMajor = "",
  allowOpaqueRuntime = false,
} = {}) {
  if (!current || current.contract !== BUILDCHAIN_CONTRACT) {
    throw new Error("current must be a Buildchain runtime contract world");
  }
  assertBuildchainCompatibilityProjection(current);
  const binding = evaluateChannelBinding({
    lock, workflowShellRef, runtimeRef, expectedChannel, expectedMajor, allowOpaqueRuntime,
  });
  if (binding?.ok === false) {
    return {
      ok: false,
      status: binding.status,
      drift: false,
      compatible: false,
      issueRecommended: false,
      reasons: binding.reasons,
      channelBinding: binding,
    };
  }
  if (!new Set(["stable", "alpha"]).has(runtimeClass)) {
    return {
      ok: true,
      status: "non-floating-runtime",
      drift: false,
      compatible: true,
      issueRecommended: false,
      reason: `runtime class ${runtimeClass || "unknown"} is not a stable floating ref`,
    };
  }
  if (!lock) {
    return {
      ok: true,
      status: "missing-lock",
      drift: false,
      compatible: true,
      issueRecommended: false,
      reason: "consumer repository has no Buildchain contract lock",
    };
  }
  const accepted = lock.buildchain || {};
  const policy = compatibilityPolicy || accepted.compatibilityPolicy || "major-compatible";
  const shaDrift = !!accepted.resolvedSha && !!runtimeSha && accepted.resolvedSha !== runtimeSha;
  const contractDrift = !!accepted.contractDigest && accepted.contractDigest !== current.contractDigest;
  if (!shaDrift && !contractDrift) {
    const verificationReceipt = evaluationReceipt({ status: "unchanged", compatible: true, policy, accepted, current });
    return {
      ok: true,
      status: "unchanged",
      drift: false,
      compatible: true,
      issueRecommended: false,
      policy,
      accepted,
      current: contractSummary(current, runtimeRef, runtimeSha),
      compatibilityDecisions: [],
      usedProofRoots: [],
      verificationReceipt,
      receiptRoot: verificationReceipt.receiptRoot,
    };
  }
  const reasons = contractPolicyReasons(accepted, current, policy);
  const compatibilityDecisions = [];
  const currentSurfaces = new Map(current.surfaces.map((entry) => [entry.id, entry]));
  const proofRegistry = createBuildchainCompatibilityProofRegistry({
    proofs: current.compatibilityProofs,
    surfaces: current.surfaces,
    majorLine: current.majorLine,
  });
  for (const oldSurface of accepted.surfaces || []) {
    const result = evaluateSurfaceRelation({
      oldSurface,
      nextSurface: currentSurfaces.get(oldSurface.id),
      proofRegistry,
      majorLine: current.majorLine,
    });
    if (result.reason) reasons.push(result.reason);
    if (result.decision) compatibilityDecisions.push(result.decision);
  }
  const compatible = reasons.length === 0;
  const status = compatible ? "compatible-drift" : "breaking-drift";
  const verificationReceipt = evaluationReceipt({ status, compatible, policy, accepted, current, decisions: compatibilityDecisions, reasons });
  return {
    ok: compatible,
    status,
    drift: shaDrift || contractDrift,
    shaDrift,
    contractDrift,
    compatible,
    issueRecommended: true,
    policy,
    reasons,
    accepted,
    current: contractSummary(current, runtimeRef, runtimeSha),
    compatibilityDecisions,
    usedProofRoots: verificationReceipt.usedProofRoots,
    verificationReceipt,
    receiptRoot: verificationReceipt.receiptRoot,
  };
}

function shown(value, fallback = "(unknown)") {
  return value ? value : fallback;
}

function renderCompatibilityDecision(decision) {
  const lines = [
    `- Surface \`${decision.surfaceId}\`: ${decision.status}`,
    `  - Relation: \`${shown(decision.sourceBreakingDigest, "(missing)")}\` -> \`${shown(decision.targetBreakingDigest, "(missing)")}\``,
    `  - Reason: \`${shown(decision.reason, "proof-backed-compatible-relation")}\``,
  ];
  if (!decision.proofRoot) return lines.join("\n");
  lines.push(
    `  - Proof root: \`${decision.proofRoot}\``,
    `  - Direction / operation: \`${decision.direction}\` / \`${decision.operation}\``,
    `  - Scope root: \`${decision.scopeRoot}\``,
    `  - Evidence: ${shown(decision.evidence && decision.evidence.pullRequest)} (\`${decision.evidenceRoot}\`)`,
    `  - Authority: \`${shown(decision.authority && decision.authority.repository)}@${shown(decision.authority && decision.authority.protectedBase)}\` (\`${decision.authorityRoot}\`)`,
    `  - Cut: \`${shown(decision.cut && decision.cut.commit)}\` (\`${decision.cutRoot}\`)`,
  );
  return lines.join("\n");
}

function renderCompatibilityDecisions(decisions) {
  if (decisions.length === 0) return "- No breaking-digest relation required proof resolution.";
  return decisions.map(renderCompatibilityDecision).join("\n");
}

export function renderBuildchainContractDriftIssueBody({ repository = "", workflow = "", runUrl = "", lockPath = "", evaluation } = {}) {
  const accepted = evaluation.accepted || {};
  const current = evaluation.current || {};
  const decisions = evaluation.compatibilityDecisions || [];
  const renderedDecisions = renderCompatibilityDecisions(decisions);
  return [
    "# Buildchain contract drift", "", "## Summary", "",
    `Buildchain detected ${evaluation.compatible ? "compatible" : "breaking"} contract drift for a floating runtime ref before expensive Buildchain work continued.`,
    "", "## Consumer", "", `- Repository: ${shown(repository)}`, `- Workflow: ${shown(workflow)}`, `- Run: ${shown(runUrl)}`, `- Lock path: ${shown(lockPath)}`,
    "", "## Accepted Buildchain contract", "", `- Ref: ${shown(accepted.ref)}`, `- SHA: ${shown(accepted.resolvedSha)}`, `- Contract digest: ${shown(accepted.contractDigest)}`, `- Compatibility digest: ${shown(accepted.compatibilityDigest)}`, `- Compatibility proof registry: ${shown(accepted.compatibilityProofRegistryRoot, "(legacy lock without proof registry)")}`, `- Policy: ${shown(evaluation.policy || accepted.compatibilityPolicy)}`,
    "", "## Current Buildchain contract", "", `- Ref: ${shown(current.ref)}`, `- SHA: ${shown(current.resolvedSha)}`, `- Contract digest: ${shown(current.contractDigest)}`, `- Compatibility digest: ${shown(current.compatibilityDigest)}`, `- Compatibility proof registry: ${shown(current.compatibilityProofRegistryRoot)}`, `- Major line: ${shown(current.majorLine)}`,
    "", "## Compatibility", "", `- Status: ${shown(evaluation.status)}`, `- Compatible: ${evaluation.compatible ? "yes" : "no"}`, evaluation.reasons && evaluation.reasons.length ? evaluation.reasons.map((reason) => `- ${reason}`).join("\n") : "- No breaking drift detected.",
    "", "## Proof-backed decisions", "", renderedDecisions, `- Verification receipt: \`${shown(evaluation.receiptRoot, "(not produced)")}\``,
    "", "## Suggested next action", "", evaluation.compatible
      ? "Review the Buildchain release notes, then update the consumer contract lock to the current SHA and contract digest."
      : "Failing before heavy build is intentional. Review the Buildchain contract change, update the consumer workflow/configuration, or pin the previous Buildchain SHA.",
  ].join("\n");
}

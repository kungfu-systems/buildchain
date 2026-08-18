import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  NATIVE_EXECUTION_BINDING_SCHEMA,
  NATIVE_EXECUTION_RECEIPT_SCHEMA,
  NATIVE_COMMAND_CONTRACT_SCHEMA,
  createNativeCommandContract,
  createNativeExecutionBinding,
  createNativeExecutionReceipt,
  normalizeNativeCommandContract,
  verifyNativeExecutionReceipt,
} from "./dev-delivery-native-execution.js";
export {
  NATIVE_EXECUTION_BINDING_SCHEMA,
  NATIVE_EXECUTION_RECEIPT_SCHEMA,
  NATIVE_COMMAND_CONTRACT_SCHEMA,
  createNativeCommandContract,
  createNativeExecutionBinding,
  createNativeExecutionReceipt,
  normalizeNativeCommandContract,
  verifyNativeExecutionReceipt,
};
export const NATIVE_QUALIFICATION_PROOF_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v4";
const LEGACY_NATIVE_QUALIFICATION_PROOF_V3_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v3";
const LEGACY_NATIVE_QUALIFICATION_PROOF_V2_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v2";
const LEGACY_NATIVE_QUALIFICATION_PROOF_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v1";
export const NATIVE_PROOF_REUSE_DECISION_SCHEMA =
  "kungfu.buildchain.native-proof-reuse-decision/v1";
export const DEV_DELIVERY_QUALIFICATION_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-qualification-receipt/v1";
export const NATIVE_PROOF_BASE_DELTA_SCHEMA =
  "kungfu.buildchain.native-proof-base-delta/v1";
const NATIVE_QUALIFICATION_ROOT_SEMANTICS = "semantic-native-identity-v1";

function normalizeQualifiedWarrant(warrant, candidate, allowLegacyV3Readback) {
  const qualifiedV3Readback =
    allowLegacyV3Readback &&
    !warrant.nativeCommandContract &&
    !candidate.nativeCommandContract &&
    !warrant.nativeExecutionReceiptRoot &&
    !warrant.qualificationReceiptRoot;
  warrant.nativeProofRoot = exactRoot(
    warrant.nativeProofRoot,
    "Warrant nativeProofRoot",
  );
  warrant.nativeProofReuseRoot = exactRoot(
    warrant.nativeProofReuseRoot,
    "Warrant nativeProofReuseRoot",
  );
  if (!qualifiedV3Readback) {
    warrant.nativeExecutionReceiptRoot = exactRoot(
      warrant.nativeExecutionReceiptRoot,
      "Warrant nativeExecutionReceiptRoot",
    );
    warrant.qualificationReceiptRoot = exactRoot(
      warrant.qualificationReceiptRoot,
      "Warrant qualificationReceiptRoot",
    );
  }
  warrant.qualifiedAt = timestamp(warrant.qualifiedAt, "Warrant qualifiedAt");
}

export function validateActiveDevDeliveryWarrant(
  queue,
  { allowLegacyV3Readback = false } = {},
) {
  const warrant = queue.activeWarrant;
  if (warrant.schema !== "kungfu.buildchain.dev-delivery-warrant/v1")
    throw new Error("active Warrant schema is unsupported");
  warrant.candidateId = exactRoot(warrant.candidateId, "Warrant candidateId");
  warrant.fencingToken = exactRoot(
    warrant.fencingToken,
    "Warrant fencingToken",
  );
  warrant.expectedOldStateRoot = exactRoot(
    warrant.expectedOldStateRoot,
    "Warrant expectedOldStateRoot",
  );
  if (
    !Number.isInteger(Number(warrant.generation)) ||
    Number(warrant.generation) < 1
  )
    throw new Error("Warrant generation must be a positive integer");
  warrant.generation = Number(warrant.generation);
  warrant.issuedAt = timestamp(warrant.issuedAt, "Warrant issuedAt");
  warrant.expiresAt = timestamp(warrant.expiresAt, "Warrant expiresAt");
  const historicalPhaseLess = !Object.hasOwn(warrant, "phase");
  const phase = historicalPhaseLess ? "legacy-active" : warrant.phase;
  if (!["legacy-active", "provisional", "qualified"].includes(phase))
    throw new Error("active Warrant phase is unsupported");
  const active = queue.candidates.filter((candidate) =>
    ["selected", "proving", "waiting", "blocked", "qualified"].includes(
      candidate.status,
    ),
  );
  if (active.length !== 1 || active[0].candidateId !== warrant.candidateId)
    throw new Error(
      "exactly one active candidate must match the active Warrant",
    );
  if (warrant.phase === "qualified") {
    normalizeQualifiedWarrant(warrant, active[0], allowLegacyV3Readback);
  } else if (
    warrant.phase === "provisional" &&
    (warrant.nativeProofRoot ||
      warrant.nativeProofReuseRoot ||
      warrant.nativeExecutionReceiptRoot ||
      warrant.qualificationReceiptRoot ||
      warrant.qualifiedAt)
  ) {
    throw new Error(
      "provisional Warrant cannot carry qualified native evidence",
    );
  }
  if (
    historicalPhaseLess &&
    (active[0].environmentRoot ||
      warrant.nativeProofRoot ||
      warrant.nativeProofReuseRoot ||
      warrant.qualifiedAt)
  ) {
    throw new Error(
      "phase-less active Warrant must use the historical non-native contract",
    );
  }
  if (phase === "provisional" && active[0].status === "qualified")
    throw new Error("provisional Warrant cannot bind a qualified candidate");
  if (warrant.phase === "qualified" && active[0].status !== "qualified")
    throw new Error("qualified Warrant must bind a qualified candidate");
  if (
    warrant.releaseBlockerPriority?.claimRoot !==
    active[0].releaseBlockerPriority?.claimRoot
  )
    throw new Error("active Warrant release-blocker priority drift");
  if (
    warrant.nativeCommandContract?.commandRoot !==
    active[0].nativeCommandContract?.commandRoot
  )
    throw new Error("active Warrant native command contract drift");
  if (
    JSON.stringify(warrant.shardEvidenceRoots || []) !==
    JSON.stringify(active[0].shardEvidenceRoots || [])
  )
    throw new Error("active Warrant shard evidence roots drift");
}
export function createDevDeliveryWarrantToken(input) {
  return devDeliveryContentRoot({
    schema: "kungfu.buildchain.dev-delivery-warrant/v1",
    repository: input.repository,
    protectedBase: input.protectedBase,
    candidateId: input.candidateId,
    phase: input.phase,
    generation: input.generation,
    expectedOldStateRoot: input.expectedOldStateRoot,
    issuedAt: input.issuedAt,
  });
}
function exactRoots(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must contain at least one content root`);
  }
  return [...new Set(values.map((value) => exactRoot(value, label)))].sort();
}
function normalizedPaths(values) {
  if (!Array.isArray(values)) throw new Error("paths must be a JSON array");
  return [
    ...new Set(
      values
        .map(text)
        .map((entry) => entry.replace(/^\.\//u, "").replace(/\/+$/u, ""))
        .filter(Boolean),
    ),
  ].sort();
}
function normalizedRenames(values) {
  if (!Array.isArray(values)) throw new Error("renames must be a JSON array");
  return values
    .map((entry) => ({
      from: normalizedPaths([entry?.from])[0] || "",
      to: normalizedPaths([entry?.to])[0] || "",
    }))
    .filter((entry) => entry.from && entry.to)
    .sort(
      (left, right) =>
        left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
    );
}
export function createNativeProofBaseDelta(input = {}) {
  const body = {
    schema: NATIVE_PROOF_BASE_DELTA_SCHEMA,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    qualifiedBase: exactSha(input.qualifiedBase, "qualifiedBase"),
    currentBase: exactSha(input.currentBase, "currentBase"),
    graphKnown: input.graphKnown === true,
    attributionComplete: input.attributionComplete === true,
    changedPaths: normalizedPaths(input.changedPaths || []),
    renames: normalizedRenames(input.renames || []),
  };
  return { ...body, deltaRoot: devDeliveryContentRoot(body) };
}
function proofIdentity(body) {
  const identity = clone(body);
  delete identity.qualifiedAt;
  delete identity.observationRoot;
  return identity;
}
function proofObservation(body) {
  return { qualifiedAt: body.qualifiedAt };
}
function rooted(body) {
  return { ...body, decisionRoot: devDeliveryContentRoot(body) };
}
export function createNativeQualificationProof(input = {}) {
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const qualifiedBase = exactSha(input.qualifiedBase, "qualifiedBase");
  const toolchainRoot = exactRoot(input.toolchainRoot, "toolchainRoot");
  const environmentRoot = exactRoot(input.environmentRoot, "environmentRoot");
  const nativeCommandRoot = exactRoot(
    input.nativeCommandRoot,
    "nativeCommandRoot",
  );
  const executionReceipt = verifyNativeExecutionReceipt(
    input.nativeExecutionReceipt,
    {
      repository: repository(input.repository),
      protectedBase: protectedBase(input.protectedBase),
      sourceHead,
      qualifiedBase,
      nativeCommandRoot,
      toolchainRoot,
      environmentRoot,
    },
  );
  if (!executionReceipt.ok) {
    throw new Error(
      `native execution receipt rejected: ${executionReceipt.reason}`,
    );
  }
  const body = {
    schema: NATIVE_QUALIFICATION_PROOF_SCHEMA,
    rootSemantics: NATIVE_QUALIFICATION_ROOT_SEMANTICS,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceIdentityRoot: exactRoot(
      input.sourceIdentityRoot,
      "sourceIdentityRoot",
    ),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot,
    environmentRoot,
    sourceHead,
    qualifiedBase,
    nativeCommandRoot,
    nativeExecutionBindingRoot: executionReceipt.executionBindingRoot,
    nativeExecutionReceiptRoot: executionReceipt.receiptRoot,
    nativeExecutionReceipt: executionReceipt.receipt,
    affectedPaths: normalizedPaths(input.affectedPaths || []),
    shardEvidenceRoots: exactRoots(
      [...(input.shardEvidenceRoots || []), executionReceipt.receiptRoot],
      "shardEvidenceRoots",
    ),
    qualifiedAt: timestamp(input.qualifiedAt, "qualifiedAt"),
  };
  body.observationRoot = devDeliveryContentRoot(proofObservation(body));
  return {
    ...body,
    proofRoot: devDeliveryContentRoot(proofIdentity(body)),
  };
}
export function verifyNativeQualificationProof(proofInput, expected = {}) {
  try {
    const proof = clone(proofInput || {});
    if (
      ![
        NATIVE_QUALIFICATION_PROOF_SCHEMA,
        LEGACY_NATIVE_QUALIFICATION_PROOF_V3_SCHEMA,
        LEGACY_NATIVE_QUALIFICATION_PROOF_V2_SCHEMA,
        LEGACY_NATIVE_QUALIFICATION_PROOF_SCHEMA,
      ].includes(proof.schema)
    ) {
      return { ok: false, reason: "unsupported-schema" };
    }
    const proofRoot = proof.proofRoot;
    delete proof.proofRoot;
    if (proof.rootSemantics !== NATIVE_QUALIFICATION_ROOT_SEMANTICS) {
      return { ok: false, reason: "unsupported-root-semantics" };
    }
    if (devDeliveryContentRoot(proofIdentity(proof)) !== proofRoot) {
      return { ok: false, reason: "proof-root-drift" };
    }
    if (
      devDeliveryContentRoot(proofObservation(proof)) !== proof.observationRoot
    ) {
      return { ok: false, reason: "observation-root-drift" };
    }
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && proof[field] !== value) {
        return { ok: false, reason: `${field}-mismatch` };
      }
    }
    if (proof.schema === NATIVE_QUALIFICATION_PROOF_SCHEMA) {
      repository(proof.repository);
      protectedBase(proof.protectedBase);
      exactSha(proof.sourceHead, "sourceHead");
      exactSha(proof.qualifiedBase, "qualifiedBase");
      for (const field of [
        "sourceIdentityRoot",
        "sourcePatchRoot",
        "planRoot",
        "closureRoot",
        "dependencyRoot",
        "toolchainRoot",
        "environmentRoot",
        "nativeCommandRoot",
        "nativeExecutionBindingRoot",
        "nativeExecutionReceiptRoot",
      ]) {
        exactRoot(proof[field], field);
      }
      const expectedBindingRoot = devDeliveryContentRoot(
        createNativeExecutionBinding(proof),
      );
      if (proof.nativeExecutionBindingRoot !== expectedBindingRoot) {
        return { ok: false, reason: "native-execution-binding-root-drift" };
      }
      const shardEvidenceRoots = exactRoots(
        proof.shardEvidenceRoots,
        "shardEvidenceRoots",
      );
      if (!shardEvidenceRoots.includes(proof.nativeExecutionReceiptRoot)) {
        return { ok: false, reason: "native-execution-receipt-unbound" };
      }
      if (!proof.nativeExecutionReceipt) {
        return {
          ok: false,
          reason: "native-execution-receipt-bytes-missing",
        };
      }
      const executionReceipt = verifyNativeExecutionReceipt(
        proof.nativeExecutionReceipt,
        {
          repository: proof.repository,
          protectedBase: proof.protectedBase,
          sourceHead: proof.sourceHead,
          qualifiedBase: proof.qualifiedBase,
          nativeCommandRoot: proof.nativeCommandRoot,
          toolchainRoot: proof.toolchainRoot,
          environmentRoot: proof.environmentRoot,
        },
      );
      if (!executionReceipt.ok) {
        return {
          ok: false,
          reason: `native-execution-${executionReceipt.reason}`,
        };
      }
      if (
        executionReceipt.receiptRoot !== proof.nativeExecutionReceiptRoot ||
        executionReceipt.executionBindingRoot !==
          proof.nativeExecutionBindingRoot
      ) {
        return { ok: false, reason: "native-execution-receipt-root-drift" };
      }
      if (
        Date.parse(proof.qualifiedAt) <
        Date.parse(executionReceipt.receipt.completedAt)
      ) {
        return {
          ok: false,
          reason: "native-execution-qualified-before-completion",
        };
      }
      normalizedPaths(proof.affectedPaths || []);
      timestamp(proof.qualifiedAt, "qualifiedAt");
    } else {
      repository(proof.repository);
      protectedBase(proof.protectedBase);
      exactSha(proof.qualifiedBase, "qualifiedBase");
      for (const field of [
        "sourceIdentityRoot",
        "sourcePatchRoot",
        "planRoot",
        "closureRoot",
        "dependencyRoot",
        "toolchainRoot",
      ]) {
        exactRoot(proof[field], field);
      }
      normalizedPaths(proof.affectedPaths || []);
      exactRoots(proof.shardEvidenceRoots, "shardEvidenceRoots");
      timestamp(proof.qualifiedAt, "qualifiedAt");
    }
    return { ok: true, reason: "exact-native-proof", proofRoot };
  } catch (error) {
    return { ok: false, reason: "invalid-proof", error: error.message };
  }
}
function pathsOverlap(changedPath, affectedPath) {
  if (affectedPath === "*" || affectedPath === "**") return true;
  return (
    changedPath === affectedPath ||
    changedPath.startsWith(`${affectedPath}/`) ||
    affectedPath.startsWith(`${changedPath}/`)
  );
}
function nativeReuseBody(proof, current) {
  const verification = verifyNativeQualificationProof(proof);
  const currentBase = current.currentBase
    ? exactSha(current.currentBase, "currentBase")
    : null;
  const changedPaths = normalizedPaths(current.changedPaths || []);
  const base = {
    schema: NATIVE_PROOF_REUSE_DECISION_SCHEMA,
    proofRoot: verification.ok ? proof.proofRoot : null,
    repository: verification.ok ? proof.repository : null,
    protectedBase: verification.ok ? proof.protectedBase : null,
    qualifiedBase: verification.ok ? proof.qualifiedBase : null,
    currentBase,
    graphKnown: current.graphKnown === true,
    attributionComplete: current.attributionComplete === true,
    changedPaths,
    renames: normalizedRenames(current.renames || []),
    baseDeltaRoot: null,
    overlappingPaths: [],
    reusable: false,
    action: "rerun-full-native-qualification",
    reason: verification.reason,
    requiredValidation: "full-native",
  };
  if (!verification.ok) return base;
  if (proof.schema !== NATIVE_QUALIFICATION_PROOF_SCHEMA) {
    return {
      ...base,
      reason: "native-execution-evidence-unbound",
    };
  }
  const semanticFields = [
    "sourceHead",
    "sourceIdentityRoot",
    "sourcePatchRoot",
    "planRoot",
    "closureRoot",
    "dependencyRoot",
    "toolchainRoot",
    "environmentRoot",
    "nativeCommandRoot",
  ];
  for (const field of semanticFields) {
    if (!current[field] || current[field] !== proof[field]) {
      return {
        ...base,
        reason: `${field}-changed-or-unknown`,
      };
    }
  }
  if (!currentBase) {
    return { ...base, reason: "current-base-unknown" };
  }
  const delta = createNativeProofBaseDelta({
    repository: proof.repository,
    protectedBase: proof.protectedBase,
    qualifiedBase: proof.qualifiedBase,
    currentBase,
    graphKnown: current.graphKnown,
    attributionComplete: current.attributionComplete,
    changedPaths,
    renames: current.renames || [],
  });
  base.baseDeltaRoot = delta.deltaRoot;
  base.renames = delta.renames;
  if (currentBase === proof.qualifiedBase) {
    return {
      ...base,
      reusable: true,
      action: "accept-fresh-native-proof",
      reason: "exact-qualified-base",
      requiredValidation: "exact-merge-group",
    };
  }
  if (
    current.graphKnown !== true ||
    current.attributionComplete !== true ||
    !Array.isArray(current.changedPaths) ||
    !Array.isArray(current.renames)
  ) {
    return { ...base, reason: "base-delta-attribution-unknown" };
  }
  if (proof.affectedPaths.length === 0) {
    return { ...base, reason: "affected-closure-paths-unknown" };
  }
  const attributedPaths = [
    ...changedPaths,
    ...base.renames.flatMap((rename) => [rename.from, rename.to]),
  ];
  const overlap = [...new Set(attributedPaths)].filter((changedPath) =>
    proof.affectedPaths.some((affectedPath) =>
      pathsOverlap(changedPath, affectedPath),
    ),
  );
  if (overlap.length > 0) {
    return {
      ...base,
      action: "rerun-affected-native-shards",
      reason: "base-delta-overlaps-affected-closure",
      requiredValidation: "incremental-or-full-native",
      overlappingPaths: overlap,
    };
  }
  return {
    ...base,
    reusable: true,
    action: "reuse-native-proof",
    reason: "semantic-source-stable-and-base-delta-disjoint",
    requiredValidation: "exact-merge-group",
  };
}
export function createNativeProofReuseDecision({ proof, current = {} } = {}) {
  return rooted(nativeReuseBody(proof, current));
}
export function verifyNativeProofReuseDecision(
  decisionInput,
  { proof, current = {} } = {},
) {
  try {
    const decision = clone(decisionInput || {});
    if (decision.schema !== NATIVE_PROOF_REUSE_DECISION_SCHEMA) {
      return { ok: false, reason: "unsupported-schema" };
    }
    const decisionRoot = decision.decisionRoot;
    delete decision.decisionRoot;
    if (devDeliveryContentRoot(decision) !== decisionRoot) {
      return { ok: false, reason: "decision-root-drift" };
    }
    const recomputed = nativeReuseBody(proof, current);
    if (JSON.stringify(decision) !== JSON.stringify(recomputed)) {
      return { ok: false, reason: "decision-input-drift" };
    }
    return {
      ok: decision.reusable === true,
      reason: decision.reason,
      decisionRoot,
      action: decision.action,
    };
  } catch (error) {
    return { ok: false, reason: "invalid-decision", error: error.message };
  }
}

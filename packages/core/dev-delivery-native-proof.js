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

export const NATIVE_QUALIFICATION_PROOF_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v3";
const LEGACY_NATIVE_QUALIFICATION_PROOF_V2_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v2";
const LEGACY_NATIVE_QUALIFICATION_PROOF_SCHEMA =
  "kungfu.buildchain.native-qualification-proof/v1";
export const NATIVE_EXECUTION_BINDING_SCHEMA =
  "kungfu.buildchain.native-execution-binding/v1";
export const NATIVE_EXECUTION_RECEIPT_SCHEMA =
  "kungfu.buildchain.native-heartbeat-run-receipt/v2";
export const NATIVE_PROOF_REUSE_DECISION_SCHEMA =
  "kungfu.buildchain.native-proof-reuse-decision/v1";
export const DEV_DELIVERY_QUALIFICATION_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-qualification-receipt/v1";
export const NATIVE_PROOF_BASE_DELTA_SCHEMA =
  "kungfu.buildchain.native-proof-base-delta/v1";

const NATIVE_QUALIFICATION_ROOT_SEMANTICS = "semantic-native-identity-v1";

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

export function createNativeExecutionBinding(input = {}) {
  return {
    schema: NATIVE_EXECUTION_BINDING_SCHEMA,
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    qualifiedBase: exactSha(input.qualifiedBase, "qualifiedBase"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    environmentRoot: exactRoot(input.environmentRoot, "environmentRoot"),
  };
}

export function createNativeExecutionReceipt(input = {}) {
  const executionBinding = createNativeExecutionBinding(input.executionBinding);
  const receipt = {
    schema: NATIVE_EXECUTION_RECEIPT_SCHEMA,
    outcome: input.outcome === "succeeded" ? "succeeded" : text(input.outcome),
    commandRoot: exactRoot(input.commandRoot, "commandRoot"),
    executionBinding,
    executionBindingRoot: devDeliveryContentRoot(executionBinding),
    startedAt: timestamp(input.startedAt, "startedAt"),
    completedAt: timestamp(input.completedAt, "completedAt"),
    heartbeatCount: Number(input.heartbeatCount),
  };
  if (receipt.outcome !== "succeeded") {
    throw new Error("native execution receipt must record succeeded outcome");
  }
  if (!Number.isInteger(receipt.heartbeatCount) || receipt.heartbeatCount < 1) {
    throw new Error("heartbeatCount must be a positive integer");
  }
  return { ...receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

export function verifyNativeExecutionReceipt(receiptInput, expected = {}) {
  try {
    const receipt = clone(receiptInput || {});
    if (receipt.schema !== NATIVE_EXECUTION_RECEIPT_SCHEMA) {
      return { ok: false, reason: "unsupported-schema" };
    }
    const receiptRoot = receipt.receiptRoot;
    delete receipt.receiptRoot;
    if (devDeliveryContentRoot(receipt) !== receiptRoot) {
      return { ok: false, reason: "receipt-root-drift" };
    }
    const normalized = createNativeExecutionReceipt({
      ...receipt,
      executionBinding: receipt.executionBinding,
    });
    if (normalized.receiptRoot !== receiptRoot) {
      return { ok: false, reason: "receipt-input-drift" };
    }
    for (const [field, value] of Object.entries(expected)) {
      if (value !== undefined && receipt.executionBinding?.[field] !== value) {
        return { ok: false, reason: `${field}-mismatch` };
      }
    }
    return {
      ok: true,
      reason: "exact-native-execution-receipt",
      receiptRoot,
      executionBindingRoot: receipt.executionBindingRoot,
    };
  } catch (error) {
    return { ok: false, reason: "invalid-receipt", error: error.message };
  }
}

export function createNativeQualificationProof(input = {}) {
  const sourceHead = exactSha(input.sourceHead, "sourceHead");
  const qualifiedBase = exactSha(input.qualifiedBase, "qualifiedBase");
  const toolchainRoot = exactRoot(input.toolchainRoot, "toolchainRoot");
  const environmentRoot = exactRoot(input.environmentRoot, "environmentRoot");
  const executionReceipt = verifyNativeExecutionReceipt(
    input.nativeExecutionReceipt,
    {
      repository: repository(input.repository),
      protectedBase: protectedBase(input.protectedBase),
      sourceHead,
      qualifiedBase,
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
    nativeExecutionBindingRoot: executionReceipt.executionBindingRoot,
    nativeExecutionReceiptRoot: executionReceipt.receiptRoot,
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

export function createDevDeliveryWarrantQualifier({
  transition,
  assertWarrantMutation,
} = {}) {
  return function qualifyDevDeliveryWarrant(
    queueInput,
    warrant,
    {
      nativeProof,
      reuseDecision,
      current = {},
      now = new Date().toISOString(),
    } = {},
  ) {
    const currentTime = timestamp(now, "now");
    const transaction = transition(
      queueInput,
      (queue, before) => {
        assertWarrantMutation(before, warrant, currentTime);
        if (before.activeWarrant.phase !== "provisional") {
          throw new Error(
            "only a provisional Delivery Warrant can be qualified",
          );
        }
        const active = before.activeWarrant;
        const proofVerification = verifyNativeQualificationProof(nativeProof, {
          repository: before.repository,
          protectedBase: before.protectedBase,
          sourceHead: active.sourceHead,
          sourceIdentityRoot: active.sourceIdentityRoot,
          sourcePatchRoot: active.sourcePatchRoot,
          planRoot: active.planRoot,
          closureRoot: active.closureRoot,
          dependencyRoot: active.dependencyRoot,
          toolchainRoot: active.toolchainRoot,
          environmentRoot: active.environmentRoot,
        });
        if (!proofVerification.ok) {
          throw new Error(`native proof rejected: ${proofVerification.reason}`);
        }
        const reuseVerification = verifyNativeProofReuseDecision(
          reuseDecision,
          {
            proof: nativeProof,
            current: {
              ...current,
              sourceHead: active.sourceHead,
              sourceIdentityRoot: active.sourceIdentityRoot,
              sourcePatchRoot: active.sourcePatchRoot,
              planRoot: active.planRoot,
              closureRoot: active.closureRoot,
              dependencyRoot: active.dependencyRoot,
              toolchainRoot: active.toolchainRoot,
              environmentRoot: active.environmentRoot,
            },
          },
        );
        if (!reuseVerification.ok) {
          throw new Error(
            `native proof is not reusable: ${reuseVerification.reason}`,
          );
        }
        queue.activeWarrant.phase = "qualified";
        queue.activeWarrant.nativeProofRoot = proofVerification.proofRoot;
        queue.activeWarrant.nativeProofReuseRoot =
          reuseVerification.decisionRoot;
        queue.activeWarrant.qualifiedAt = currentTime;
        queue.activeWarrant.nextAction =
          "Enter the GitHub merge queue at the exact fenced PR head; merge_group remains final authority.";
        const candidate = queue.candidates.find(
          (entry) => entry.candidateId === queue.activeWarrant.candidateId,
        );
        candidate.status = "qualified";
        candidate.updatedAt = currentTime;
        return { candidate, warrant: queue.activeWarrant };
      },
      currentTime,
    );
    const receipt = {
      schema: DEV_DELIVERY_QUALIFICATION_RECEIPT_SCHEMA,
      action: "qualified-warrant",
      candidateId: transaction.result.candidate.candidateId,
      fencingToken: transaction.result.warrant.fencingToken,
      leaseGeneration: transaction.result.warrant.generation,
      phase: transaction.result.warrant.phase,
      nativeProofRoot: transaction.result.warrant.nativeProofRoot,
      nativeProofReuseRoot: transaction.result.warrant.nativeProofReuseRoot,
      qualifiedAt: transaction.result.warrant.qualifiedAt,
      expectedOldStateRoot: transaction.expectedOldStateRoot,
      nextStateRoot: transaction.after.stateRoot,
      nextAction: transaction.result.warrant.nextAction,
    };
    return {
      queue: transaction.after,
      warrant: transaction.result.warrant,
      receipt,
      receiptRoot: devDeliveryContentRoot(receipt),
    };
  };
}

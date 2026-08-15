import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  DEV_DELIVERY_CANCELLATION_RECEIPT_SCHEMA,
  createCancelQueuedDevDeliveryCandidate,
} from "./dev-delivery-warrant-cancellation.js";
import {
  DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA,
  createDevDeliveryTerminalSettler,
  normalizeProviderFailureAuthorityBinding,
} from "./dev-delivery-warrant-settlement.js";
import {
  normalizeNativeCommandContract,
  validateActiveDevDeliveryWarrant,
} from "./dev-delivery-native-proof.js";
import { createDevDeliveryWarrantQualifier } from "./dev-delivery-warrant-qualification.js";
import {
  DEV_DELIVERY_CLASSES,
  DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
  DEV_DELIVERY_PRIORITIES,
  DEV_DELIVERY_QUEUE_CONTRACT,
  DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA,
  DEV_DELIVERY_SUBMISSION_RECEIPT_SCHEMA,
  DEV_DELIVERY_WARRANT_SCHEMA,
  TERMINAL_STATES,
  createDevDeliveryQueue,
  issueDevDeliveryWarrant,
  normalizeDevDeliveryQueue,
  rankDevDeliveryCandidates,
  submitDevDeliveryCandidate,
  transitionDevDeliveryQueue as transition,
} from "./dev-delivery-warrant-state.js";

export { devDeliveryContentRoot } from "./dev-delivery-common.js";
export {
  RELEASE_BLOCKER_PRIORITY_CLAIM_SCHEMA,
  createReleaseBlockerPriorityClaim,
} from "./release-blocker-priority.js";
export {
  SOURCE_QUALIFICATION_PROOF_SCHEMA,
  SOURCE_QUALIFICATION_PROOF_V2_SCHEMA,
  PROJECT_CUT_REPLAY_PROOF_SCHEMA,
  INTEGRATION_DELIVERY_PROOF_SCHEMA,
  classifyDevDeliveryDelta,
  createIntegrationDeliveryProof,
  createProjectCutReplayPlan,
  createProjectCutReplayProof,
  createSourceQualificationProof,
  createSourceQualificationProofV2,
  verifyIntegrationDeliveryProof,
  verifyProjectCutReplayProof,
  verifySourceQualificationProof,
} from "./dev-delivery-proof.js";
export {
  DEV_DELIVERY_QUALIFICATION_RECEIPT_SCHEMA,
  NATIVE_COMMAND_CONTRACT_SCHEMA,
  NATIVE_EXECUTION_BINDING_SCHEMA,
  NATIVE_EXECUTION_RECEIPT_SCHEMA,
  NATIVE_PROOF_BASE_DELTA_SCHEMA,
  NATIVE_PROOF_REUSE_DECISION_SCHEMA,
  NATIVE_QUALIFICATION_PROOF_SCHEMA,
  createNativeCommandContract,
  createNativeExecutionBinding,
  createNativeExecutionReceipt,
  createNativeProofBaseDelta,
  createNativeProofReuseDecision,
  createNativeQualificationProof,
  normalizeNativeCommandContract,
  verifyNativeExecutionReceipt,
  verifyNativeProofReuseDecision,
  verifyNativeQualificationProof,
} from "./dev-delivery-native-proof.js";
export {
  DEV_DELIVERY_CLASSES,
  DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
  DEV_DELIVERY_PRIORITIES,
  DEV_DELIVERY_QUEUE_CONTRACT,
  DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA,
  DEV_DELIVERY_SUBMISSION_RECEIPT_SCHEMA,
  DEV_DELIVERY_WARRANT_SCHEMA,
  createDevDeliveryQueue,
  normalizeDevDeliveryQueue,
  rankDevDeliveryCandidates,
  submitDevDeliveryCandidate,
};
export { DEV_DELIVERY_CANCELLATION_RECEIPT_SCHEMA };
export { DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA };

export function selectDevDeliveryWarrant(
  queueInput,
  { now = new Date().toISOString(), leaseSeconds } = {},
) {
  const currentTime = timestamp(now, "now");
  let queue = normalizeDevDeliveryQueue(queueInput);
  let recoveryReceipt = null;
  if (
    queue.activeWarrant &&
    Date.parse(queue.activeWarrant.expiresAt) <= Date.parse(currentTime)
  ) {
    const recovered = recoverExpiredDevDeliveryWarrant(queue, {
      now: currentTime,
    });
    queue = recovered.queue;
    recoveryReceipt = recovered.receipt;
  }
  if (queue.activeWarrant) {
    const stopRequired =
      recoveryReceipt?.action === "expired-lease-fenced-stop-required";
    const receipt = {
      schema: DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA,
      selected: !stopRequired,
      reason: stopRequired
        ? "expired-provisional-warrant-stop-required"
        : "non-preemptive-active-warrant",
      candidateId: queue.activeWarrant.candidateId,
      fencingToken: queue.activeWarrant.fencingToken,
      leaseGeneration: queue.activeWarrant.generation,
      expectedOldStateRoot: queue.stateRoot,
      nextStateRoot: queue.stateRoot,
      nextAction: stopRequired
        ? recoveryReceipt.nextAction
        : "Continue the active delivery attempt; later candidates remain visibly queued.",
    };
    return {
      queue,
      warrant: queue.activeWarrant,
      receipt,
      receiptRoot: devDeliveryContentRoot(receipt),
      recoveryReceipt,
    };
  }
  const ranked = rankDevDeliveryCandidates(queue, { now: currentTime });
  if (ranked.length === 0) {
    const receipt = {
      schema: DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA,
      selected: false,
      reason: "no-qualified-candidates",
      expectedOldStateRoot: queue.stateRoot,
      nextStateRoot: queue.stateRoot,
      nextAction: "Submit a qualified candidate.",
    };
    return {
      queue,
      warrant: null,
      receipt,
      receiptRoot: devDeliveryContentRoot(receipt),
      recoveryReceipt,
    };
  }
  const selected = ranked[0];
  const transaction = transition(
    queue,
    (next, before) => {
      const candidate = next.candidates.find(
        (entry) => entry.candidateId === selected.candidate.candidateId,
      );
      const warrant = issueDevDeliveryWarrant(
        next,
        before,
        candidate,
        currentTime,
        leaseSeconds,
      );
      next.activeWarrant = warrant;
      candidate.status = "selected";
      candidate.updatedAt = currentTime;
      return { candidate, warrant };
    },
    currentTime,
  );
  const receipt = {
    schema: DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA,
    selected: true,
    reason: selected.priority.releaseBlocker
      ? "release-blocker-bounded-priority"
      : selected.priority.agingBoost > 0
        ? "fifo-aging-bounded-priority"
        : "fifo-bounded-priority",
    repository: transaction.after.repository,
    protectedBase: transaction.after.protectedBase,
    candidateId: transaction.result.candidate.candidateId,
    pullRequestNumber: transaction.result.candidate.pullRequestNumber,
    sourceHead: transaction.result.candidate.sourceHead,
    assignmentRoot: transaction.result.candidate.assignmentRoot,
    initiativeRoot: transaction.result.candidate.initiativeRoot,
    sourceIdentityRoot: transaction.result.candidate.sourceIdentityRoot,
    sourcePatchRoot: transaction.result.candidate.sourcePatchRoot,
    sourceProofRoot: transaction.result.candidate.sourceProofRoot,
    planRoot: transaction.result.candidate.planRoot,
    closureRoot: transaction.result.candidate.closureRoot,
    dependencyRoot: transaction.result.candidate.dependencyRoot,
    toolchainRoot: transaction.result.candidate.toolchainRoot,
    sourceWorkflowRunId: transaction.result.candidate.sourceWorkflowRunId,
    ...(transaction.result.candidate.nativeCommandContract
      ? {
          nativeCommandContract:
            transaction.result.candidate.nativeCommandContract,
        }
      : {}),
    ...(transaction.result.candidate.shardEvidenceRoots
      ? {
          shardEvidenceRoots: transaction.result.candidate.shardEvidenceRoots,
        }
      : {}),
    ...(Object.hasOwn(transaction.result.candidate, "releaseBlockerPriority")
      ? {
          releaseBlockerPriority:
            transaction.result.candidate.releaseBlockerPriority,
        }
      : {}),
    deliveryClass: transaction.result.candidate.deliveryClass,
    queueAgeSeconds: selected.priority.ageSeconds,
    basePriority: selected.priority.basePriority,
    agingBoost: selected.priority.agingBoost,
    effectivePriority: selected.priority.score,
    fencingToken: transaction.result.warrant.fencingToken,
    leaseGeneration: transaction.result.warrant.generation,
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
    nextAction: transaction.result.warrant.nextAction,
  };
  return {
    queue: transaction.after,
    warrant: transaction.result.warrant,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
    recoveryReceipt,
  };
}
function assertWarrantMutation(
  queue,
  warrant,
  now,
  { allowExpired = false } = {},
) {
  if (!queue.activeWarrant) throw new Error("no active Delivery Warrant");
  if (text(warrant?.fencingToken) !== queue.activeWarrant.fencingToken)
    throw new Error("stale fencing token");
  if (Number(warrant?.generation) !== queue.activeWarrant.generation)
    throw new Error("stale lease generation");
  if (text(warrant?.candidateId) !== queue.activeWarrant.candidateId)
    throw new Error("Warrant candidate mismatch");
  if (
    !allowExpired &&
    Date.parse(queue.activeWarrant.expiresAt) <= Date.parse(now)
  )
    throw new Error("Delivery Warrant lease expired");
}
export function heartbeatDevDeliveryWarrant(
  queueInput,
  warrant,
  { now = new Date().toISOString(), leaseSeconds } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    queueInput,
    (queue, before) => {
      assertWarrantMutation(before, warrant, currentTime);
      const effectiveLeaseSeconds = positiveInteger(
        leaseSeconds,
        "leaseSeconds",
        queue.policy.leaseSeconds,
      );
      queue.activeWarrant.expiresAt = new Date(
        Date.parse(currentTime) + effectiveLeaseSeconds * 1000,
      ).toISOString();
      const candidate = queue.candidates.find(
        (entry) => entry.candidateId === queue.activeWarrant.candidateId,
      );
      candidate.status =
        queue.activeWarrant.phase === "qualified" ? "qualified" : "proving";
      candidate.updatedAt = currentTime;
      return { candidate, warrant: queue.activeWarrant };
    },
    currentTime,
  );
  const receipt = {
    schema: DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
    action: "heartbeat",
    candidateId: transaction.result.candidate.candidateId,
    fencingToken: transaction.result.warrant.fencingToken,
    leaseGeneration: transaction.result.warrant.generation,
    expiresAt: transaction.result.warrant.expiresAt,
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
    nextAction: "Continue the exact fenced delivery attempt.",
  };
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}
export function recoverExpiredDevDeliveryWarrant(
  queueInput,
  { now = new Date().toISOString() } = {},
) {
  const currentTime = timestamp(now, "now");
  const before = normalizeDevDeliveryQueue(queueInput);
  if (
    !before.activeWarrant ||
    Date.parse(before.activeWarrant.expiresAt) > Date.parse(currentTime)
  ) {
    const receipt = {
      schema: DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
      action: "recovery-noop",
      reason: before.activeWarrant ? "lease-active" : "no-active-warrant",
      expectedOldStateRoot: before.stateRoot,
      nextStateRoot: before.stateRoot,
      nextAction: before.activeWarrant
        ? "Continue the active delivery attempt."
        : "Select the next queued candidate.",
    };
    return {
      queue: before,
      receipt,
      receiptRoot: devDeliveryContentRoot(receipt),
    };
  }
  if (before.activeWarrant.phase === "provisional") {
    const receipt = {
      schema: DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
      action: "expired-lease-fenced-stop-required",
      reason: "provisional-native-worker-stop-unproven",
      candidateId: before.activeWarrant.candidateId,
      rejectedFencingToken: before.activeWarrant.fencingToken,
      expiredLeaseGeneration: before.activeWarrant.generation,
      expectedOldStateRoot: before.stateRoot,
      nextStateRoot: before.stateRoot,
      nextAction:
        "Prove the fenced native worker stopped, then close this exact generation with rooted terminal evidence.",
    };
    return {
      queue: before,
      receipt,
      receiptRoot: devDeliveryContentRoot(receipt),
    };
  }
  const transaction = transition(
    before,
    (queue) => {
      const expired = clone(queue.activeWarrant);
      const candidate = queue.candidates.find(
        (entry) => entry.candidateId === expired.candidateId,
      );
      candidate.status = "queued";
      candidate.recoveries += 1;
      candidate.attempts += 1;
      candidate.updatedAt = currentTime;
      queue.activeWarrant = null;
      return { candidate, expired };
    },
    currentTime,
  );
  const receipt = {
    schema: DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
    action: "recovered-expired-lease",
    candidateId: transaction.result.candidate.candidateId,
    rejectedFencingToken: transaction.result.expired.fencingToken,
    expiredLeaseGeneration: transaction.result.expired.generation,
    retainedEnqueuedAt: transaction.result.candidate.enqueuedAt,
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
    nextAction:
      "Re-select through the queue to mint a new lease generation and fencing token.",
  };
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}
export const qualifyDevDeliveryWarrant = createDevDeliveryWarrantQualifier({
  transition,
  assertWarrantMutation,
});
export function closeDevDeliveryWarrant(
  queueInput,
  warrant,
  {
    outcome,
    evidenceRoot,
    reason = "",
    providerFailureAuthority = null,
    now = new Date().toISOString(),
  } = {},
) {
  const currentTime = timestamp(now, "now");
  const normalizedOutcome = text(outcome);
  if (!TERMINAL_STATES.has(normalizedOutcome)) {
    throw new Error(
      `outcome must be one of ${[...TERMINAL_STATES].join(", ")}`,
    );
  }
  const failureAuthority = normalizeProviderFailureAuthorityBinding(
    providerFailureAuthority || {},
  );
  if (failureAuthority && normalizedOutcome !== "terminal-failure") {
    throw new Error(
      "provider failure authority is valid only for terminal-failure",
    );
  }
  const transaction = transition(
    queueInput,
    (queue, before) => {
      assertWarrantMutation(before, warrant, currentTime, {
        allowExpired: true,
      });
      if (
        (before.activeWarrant.phase || "qualified") !== "qualified" &&
        normalizedOutcome === "merged"
      ) {
        throw new Error(
          "provisional Warrant cannot settle as merged before native qualification",
        );
      }
      const active = clone(queue.activeWarrant);
      const candidate = queue.candidates.find(
        (entry) => entry.candidateId === active.candidateId,
      );
      candidate.status = normalizedOutcome;
      candidate.updatedAt = currentTime;
      candidate.terminal = {
        outcome: normalizedOutcome,
        reason: text(reason),
        evidenceRoot: exactRoot(evidenceRoot, "evidenceRoot"),
        closedAt: currentTime,
        fencingToken: active.fencingToken,
        leaseGeneration: active.generation,
        ...(failureAuthority || {}),
      };
      queue.activeWarrant = null;
      return { candidate, active };
    },
    currentTime,
  );
  const receipt = {
    schema: DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
    action: "terminal-closeout",
    outcome: normalizedOutcome,
    reason: text(reason),
    candidateId: transaction.result.candidate.candidateId,
    fencingToken: transaction.result.active.fencingToken,
    leaseGeneration: transaction.result.active.generation,
    evidenceRoot: transaction.result.candidate.terminal.evidenceRoot,
    ...(failureAuthority || {}),
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
    successorWake: createDevDeliverySuccessorWake(
      transaction.after,
      currentTime,
    ),
    nextAction: "Select the next queued candidate, if any.",
  };
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}
function createDevDeliverySuccessorWake(queue, now) {
  const next = rankDevDeliveryCandidates(queue, { now })[0]?.candidate;
  if (!next) return null;
  return {
    schema: "kungfu.buildchain.dev-delivery-wake/v1",
    targetBranch: queue.protectedBase,
    ...Object.fromEntries(
      [
        "candidateId",
        "pullRequestNumber",
        "sourceHead",
        "assignmentRoot",
        "initiativeRoot",
        "sourceIdentityRoot",
        "sourcePatchRoot",
        "sourceProofRoot",
        "planRoot",
        "closureRoot",
        "dependencyRoot",
        "toolchainRoot",
        "deliveryClass",
        "priority",
        "nativeCommandContract",
        "shardEvidenceRoots",
      ]
        .filter((field) => next[field] !== undefined)
        .map((field) => [field, next[field]]),
    ),
    ...(next.environmentRoot ? { environmentRoot: next.environmentRoot } : {}),
    ...(next.affectedPaths ? { affectedPaths: next.affectedPaths } : {}),
    ...(Object.hasOwn(next, "sourceWorkflowRunId")
      ? { sourceWorkflowRunId: next.sourceWorkflowRunId }
      : {}),
    ...(next.releaseBlockerPriority
      ? { releaseBlockerPriority: next.releaseBlockerPriority }
      : {}),
  };
}
const cancelQueuedDevDeliveryCandidateTransition =
  createCancelQueuedDevDeliveryCandidate(normalizeDevDeliveryQueue);
export function cancelQueuedDevDeliveryCandidate(queueInput, input, options) {
  return cancelQueuedDevDeliveryCandidateTransition(queueInput, input, options);
}
export const settleDevDeliveryTerminalEvent = createDevDeliveryTerminalSettler({
  normalizeQueue: normalizeDevDeliveryQueue,
  closeWarrant: closeDevDeliveryWarrant,
  cancelQueued: cancelQueuedDevDeliveryCandidate,
  terminalStates: TERMINAL_STATES,
});
export function observeDevDeliveryQueue(
  queueInput,
  { now = new Date().toISOString() } = {},
) {
  const queue = normalizeDevDeliveryQueue(queueInput);
  const currentTime = timestamp(now, "now");
  const states = {};
  for (const candidate of queue.candidates)
    states[candidate.status] = (states[candidate.status] || 0) + 1;
  const queued = rankDevDeliveryCandidates(queue, { now: currentTime });
  return {
    schema: "kungfu.buildchain.dev-delivery-queue-observation/v1",
    repository: queue.repository,
    protectedBase: queue.protectedBase,
    stateRoot: queue.stateRoot,
    generation: queue.generation,
    activeWarrant: queue.activeWarrant,
    activeCandidate: queue.activeWarrant
      ? queue.candidates.find(
          (candidate) =>
            candidate.candidateId === queue.activeWarrant.candidateId,
        ) || null
      : null,
    states,
    queued: queued.map((entry, index) => ({
      position: index + 1,
      candidateId: entry.candidate.candidateId,
      pullRequestNumber: entry.candidate.pullRequestNumber,
      sourceHead: entry.candidate.sourceHead,
      priority: entry.candidate.priority,
      effectivePriority: entry.priority.score,
      queueAgeSeconds: entry.priority.ageSeconds,
      attempts: entry.candidate.attempts,
      recoveries: entry.candidate.recoveries,
      nextAction:
        index === 0 && !queue.activeWarrant
          ? "eligible-for-selection"
          : "wait-for-active-warrant",
    })),
    observedAt: currentTime,
  };
}

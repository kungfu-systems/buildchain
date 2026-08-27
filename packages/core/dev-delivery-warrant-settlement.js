import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { verifyIntegrationDeliveryProof } from "./dev-delivery-proof.js";

export const DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-settlement-receipt/v1";
export const DEV_DELIVERY_TERMINAL_EVIDENCE_CORRECTION_SCHEMA =
  "kungfu.buildchain.dev-delivery-terminal-evidence-correction/v1";

const PROVIDER_FAILURE_FIELDS = [
  "transferRoot",
  "finalizerBoundaryRoot",
  "nativeJobId",
  "sealJobId",
];

function correctionBody(input) {
  const body = clone(input || {});
  delete body.correctionRoot;
  return body;
}

export function normalizeTerminalEvidenceCorrection(
  input,
  { candidate, repository, protectedBase } = {},
) {
  const correction = correctionBody(input);
  if (correction.schema !== DEV_DELIVERY_TERMINAL_EVIDENCE_CORRECTION_SCHEMA) {
    throw new Error("unsupported terminal evidence correction schema");
  }
  correction.candidateId = exactRoot(
    correction.candidateId,
    "terminal evidence correction candidateId",
  );
  correction.pullRequestNumber = positiveInteger(
    correction.pullRequestNumber,
    "terminal evidence correction pullRequestNumber",
  );
  correction.sourceHead = exactSha(
    correction.sourceHead,
    "terminal evidence correction sourceHead",
  );
  correction.outcome = text(correction.outcome);
  correction.priorEvidenceRoot = exactRoot(
    correction.priorEvidenceRoot,
    "terminal evidence correction priorEvidenceRoot",
  );
  correction.correctedAt = timestamp(
    correction.correctedAt,
    "terminal evidence correction correctedAt",
  );
  correction.reason = text(correction.reason);
  if (!correction.reason) {
    throw new Error("terminal evidence correction reason is required");
  }
  const verification = verifyIntegrationDeliveryProof(
    correction.integrationProof,
  );
  if (!verification.ok) {
    throw new Error(
      `terminal evidence correction requires an exact integration proof: ${verification.reason}`,
    );
  }
  if (
    correction.integrationProof.currentBase !==
      correction.integrationProof.mergeGroupHead ||
    correction.integrationProof.replayTree !==
      correction.integrationProof.mergeGroupTree
  ) {
    throw new Error(
      "terminal evidence correction requires exact merge-group commit and tree continuity",
    );
  }
  if (candidate) {
    const checks = {
      candidateId: correction.candidateId === candidate.candidateId,
      pullRequestNumber:
        correction.pullRequestNumber === candidate.pullRequestNumber,
      sourceHead: correction.sourceHead === candidate.sourceHead,
      outcome:
        correction.outcome === candidate.status &&
        correction.outcome === candidate.terminal?.outcome,
      priorEvidenceRoot:
        correction.priorEvidenceRoot === candidate.terminal?.evidenceRoot,
      repository: correction.integrationProof.repository === repository,
      protectedBase:
        correction.integrationProof.protectedBase === protectedBase,
      sourceProofRoot:
        correction.integrationProof.sourceProofRoot ===
        candidate.sourceProofRoot,
      warrantCandidateId:
        correction.integrationProof.warrantCandidateId ===
        candidate.candidateId,
      warrantFencingToken:
        correction.integrationProof.warrantFencingToken ===
        candidate.terminal?.fencingToken,
      warrantGeneration:
        correction.integrationProof.warrantGeneration ===
        candidate.terminal?.leaseGeneration,
    };
    const failed = Object.entries(checks)
      .filter(([, matches]) => !matches)
      .map(([field]) => field);
    if (failed.length > 0) {
      throw new Error(
        `terminal evidence correction identity drift: ${failed.join(", ")}`,
      );
    }
  }
  const correctionRoot = devDeliveryContentRoot(correction);
  if (input?.correctionRoot && input.correctionRoot !== correctionRoot) {
    throw new Error("terminal evidence correction root drift");
  }
  return { ...correction, correctionRoot };
}

export function effectiveTerminalEvidenceRoot(candidate) {
  return (
    candidate?.terminal?.integrationEvidenceCorrection?.integrationProof
      ?.proofRoot ||
    candidate?.terminal?.evidenceRoot ||
    ""
  );
}

export function createTerminalEvidenceCorrection(
  candidate,
  input,
  { repository, protectedBase, now } = {},
) {
  return normalizeTerminalEvidenceCorrection(
    {
      schema: DEV_DELIVERY_TERMINAL_EVIDENCE_CORRECTION_SCHEMA,
      candidateId: candidate?.candidateId,
      pullRequestNumber: candidate?.pullRequestNumber,
      sourceHead: candidate?.sourceHead,
      outcome: candidate?.status,
      priorEvidenceRoot: input?.expectedPriorEvidenceRoot,
      integrationProof: input?.integrationProof,
      correctedAt: now,
      reason: input?.reason,
    },
    { candidate, repository, protectedBase },
  );
}

export function createDevDeliveryTerminalEvidenceReconciler({
  normalizeQueue,
  transition,
}) {
  return function reconcileDevDeliveryTerminalEvidence(
    queueInput,
    input,
    { now = new Date().toISOString() } = {},
  ) {
    const before = normalizeQueue(queueInput);
    const candidate = before.candidates.find(
      (entry) =>
        entry.candidateId === exactRoot(input?.candidateId, "candidateId"),
    );
    if (!candidate)
      throw new Error("terminal evidence candidate does not exist");
    if (candidate.status !== "merged") {
      throw new Error(
        "integration evidence correction requires a merged candidate",
      );
    }
    const existing = candidate.terminal?.integrationEvidenceCorrection;
    const correction = createTerminalEvidenceCorrection(candidate, input, {
      repository: before.repository,
      protectedBase: before.protectedBase,
      now: existing?.correctedAt || timestamp(now, "now"),
    });
    if (existing) {
      if (existing.correctionRoot !== correction.correctionRoot) {
        throw new Error(
          "terminal evidence correction already exists with different evidence",
        );
      }
      const receipt = {
        schema: DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA,
        action: "duplicate-terminal-evidence-correction-noop",
        applicable: true,
        repository: before.repository,
        protectedBase: before.protectedBase,
        candidateId: candidate.candidateId,
        pullRequestNumber: candidate.pullRequestNumber,
        sourceHead: candidate.sourceHead,
        outcome: candidate.status,
        priorEvidenceRoot: candidate.terminal.evidenceRoot,
        evidenceRoot: correction.integrationProof.proofRoot,
        correctionRoot: correction.correctionRoot,
        expectedOldStateRoot: before.stateRoot,
        nextStateRoot: before.stateRoot,
        nextAction:
          "Retain the exact verified integration evidence correction.",
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
        const mutable = queue.candidates.find(
          (entry) => entry.candidateId === candidate.candidateId,
        );
        mutable.terminal = {
          ...mutable.terminal,
          integrationEvidenceCorrection: correction,
        };
        return { candidate: mutable };
      },
      correction.correctedAt,
    );
    const receipt = {
      schema: DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA,
      action: "terminal-evidence-corrected",
      applicable: true,
      repository: transaction.after.repository,
      protectedBase: transaction.after.protectedBase,
      candidateId: candidate.candidateId,
      pullRequestNumber: candidate.pullRequestNumber,
      sourceHead: candidate.sourceHead,
      outcome: candidate.status,
      priorEvidenceRoot: candidate.terminal.evidenceRoot,
      evidenceRoot: correction.integrationProof.proofRoot,
      correctionRoot: correction.correctionRoot,
      expectedOldStateRoot: transaction.expectedOldStateRoot,
      nextStateRoot: transaction.after.stateRoot,
      nextAction:
        "Read back the corrected terminal candidate and repeat settlement idempotently.",
    };
    return {
      queue: transaction.after,
      receipt,
      receiptRoot: devDeliveryContentRoot(receipt),
    };
  };
}

export function normalizeProviderFailureAuthorityBinding(
  input = {},
  { required = false } = {},
) {
  const present = PROVIDER_FAILURE_FIELDS.filter(
    (field) => input?.[field] !== undefined && input[field] !== "",
  );
  if (present.length === 0 && !required) return null;
  if (present.length !== PROVIDER_FAILURE_FIELDS.length) {
    throw new Error(
      "provider failure authority binding requires transfer root, boundary root, native job id, and seal job id",
    );
  }
  const binding = {
    transferRoot: exactRoot(input.transferRoot, "transferRoot"),
    finalizerBoundaryRoot: exactRoot(
      input.finalizerBoundaryRoot,
      "finalizerBoundaryRoot",
    ),
    nativeJobId: positiveInteger(input.nativeJobId, "nativeJobId"),
    sealJobId: positiveInteger(input.sealJobId, "sealJobId"),
  };
  if (binding.nativeJobId === binding.sealJobId) {
    throw new Error("native and seal job ids must be distinct");
  }
  return binding;
}

function noopReceipt(queue, identity, candidate, action, details = {}) {
  return {
    schema: DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA,
    action,
    applicable: action !== "terminal-event-not-applicable",
    repository: queue.repository,
    protectedBase: queue.protectedBase,
    pullRequestNumber: identity.pullRequestNumber,
    sourceHead: identity.sourceHead,
    outcome: identity.outcome,
    candidateId: candidate?.candidateId || null,
    evidenceRoot:
      effectiveTerminalEvidenceRoot(candidate) || identity.evidenceRoot || null,
    expectedOldStateRoot: queue.stateRoot,
    nextStateRoot: queue.stateRoot,
    nextAction: "No fenced delivery state remains for this terminal event.",
    ...details,
  };
}

function settleTerminalCandidate(queue, identity, candidate) {
  if (candidate.status !== identity.outcome) {
    if (identity.outcome !== "dequeued")
      throw new Error(
        "terminal candidate outcome does not match the terminal event",
      );
    const receipt = noopReceipt(
      queue,
      identity,
      candidate,
      "stale-transient-dequeue-noop",
      {
        terminalClass: "transient-dequeue",
        authoritativeOutcome: candidate.status,
        nextAction:
          "Retain the authoritative terminal settlement; the stale dequeue cannot rewrite it.",
      },
    );
    return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
  }
  const existingBinding = normalizeProviderFailureAuthorityBinding(
    candidate.terminal || {},
  );
  const repeatedBinding = normalizeProviderFailureAuthorityBinding(identity, {
    required: Boolean(existingBinding),
  });
  if (JSON.stringify(existingBinding) !== JSON.stringify(repeatedBinding)) {
    throw new Error(
      "duplicate terminal event provider failure authority drift",
    );
  }
  if (effectiveTerminalEvidenceRoot(candidate) !== identity.evidenceRoot) {
    throw new Error("duplicate terminal event evidenceRoot drift");
  }
  const receipt = noopReceipt(
    queue,
    identity,
    candidate,
    "duplicate-terminal-event-noop",
  );
  return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

function retainDequeuedWarrant(
  queue,
  identity,
  candidate,
  fencingToken,
  leaseGeneration,
  now,
) {
  const leaseFresh =
    Date.parse(queue.activeWarrant.expiresAt) > Date.parse(now);
  const receipt = noopReceipt(
    queue,
    identity,
    candidate,
    leaseFresh
      ? "transient-dequeue-retained-active-warrant"
      : "expired-active-warrant-awaits-fenced-settlement",
    {
      terminalClass: "transient-dequeue",
      fencingToken,
      leaseGeneration,
      warrantExpiresAt: queue.activeWarrant.expiresAt,
      nextAction: leaseFresh
        ? "Continue the exact active native execution and heartbeat; later candidates remain queued."
        : "Prove the stale native worker stopped, then close this exact fenced generation before selecting a successor.",
    },
  );
  return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

export function createDevDeliveryTerminalSettler({
  normalizeQueue,
  closeWarrant,
  cancelQueued,
  terminalStates,
}) {
  return function settleDevDeliveryTerminalEvent(
    queueInput,
    input,
    { now = new Date().toISOString() } = {},
  ) {
    const queue = normalizeQueue(queueInput);
    const identity = {
      pullRequestNumber: positiveInteger(
        input?.pullRequestNumber,
        "pullRequestNumber",
      ),
      sourceHead: exactSha(input?.sourceHead, "sourceHead"),
      outcome: text(input?.outcome),
      evidenceRoot: input?.evidenceRoot
        ? exactRoot(input.evidenceRoot, "evidenceRoot")
        : "",
      reason: text(input?.reason),
      eventAction: text(input?.eventAction).toLowerCase(),
      ...normalizeProviderFailureAuthorityBinding(input || {}),
    };
    if (!terminalStates.has(identity.outcome))
      throw new Error(
        `outcome must be one of ${[...terminalStates].join(", ")}`,
      );
    const samePullRequest = queue.candidates.filter(
      (entry) => entry.pullRequestNumber === identity.pullRequestNumber,
    );
    const matchingHead = samePullRequest.filter(
      (entry) => entry.sourceHead === identity.sourceHead,
    );
    const activeCandidate = queue.activeWarrant
      ? matchingHead.find(
          (entry) => entry.candidateId === queue.activeWarrant.candidateId,
        )
      : null;
    const candidate = activeCandidate || matchingHead.at(-1) || null;
    if (!candidate && samePullRequest.length > 0)
      throw new Error(
        "terminal event sourceHead does not match the recorded candidate",
      );

    if (candidate && terminalStates.has(candidate.status)) {
      return settleTerminalCandidate(queue, identity, candidate);
    }

    if (queue.activeWarrant) {
      if (
        !candidate ||
        queue.activeWarrant.candidateId !== candidate.candidateId
      )
        throw new Error(
          "terminal event does not match the active Delivery Warrant",
        );
      if (!identity.evidenceRoot)
        throw new Error("active terminal settlement requires evidenceRoot");
      const fencingToken = exactRoot(input?.fencingToken, "fencingToken");
      const leaseGeneration = positiveInteger(
        input?.leaseGeneration,
        "leaseGeneration",
      );
      if (fencingToken !== queue.activeWarrant.fencingToken)
        throw new Error("stale fencing token");
      if (leaseGeneration !== queue.activeWarrant.generation)
        throw new Error("stale lease generation");
      const terminalKey = identity.outcome + queue.activeWarrant.phase;
      if (terminalKey === "dequeuedprovisional")
        return retainDequeuedWarrant(
          queue,
          identity,
          candidate,
          fencingToken,
          leaseGeneration,
          now,
        );
      return closeWarrant(
        queue,
        {
          candidateId: candidate.candidateId,
          fencingToken,
          generation: leaseGeneration,
        },
        {
          outcome: identity.outcome,
          evidenceRoot: identity.evidenceRoot,
          reason: identity.reason,
          providerFailureAuthority:
            normalizeProviderFailureAuthorityBinding(identity),
          now,
        },
      );
    }

    if (!candidate) {
      const receipt = noopReceipt(
        queue,
        identity,
        null,
        "terminal-event-not-applicable",
      );
      return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
    }
    if (candidate.status !== "queued")
      throw new Error(
        `candidate status ${candidate.status} requires an active Delivery Warrant`,
      );
    if (!["cancelled", "dequeued"].includes(identity.outcome))
      throw new Error(
        "queued candidate cannot settle as merged or terminal-failure",
      );
    if (!identity.evidenceRoot)
      throw new Error("queued terminal settlement requires evidenceRoot");
    return cancelQueued(
      queue,
      {
        candidateId: candidate.candidateId,
        pullRequestNumber: identity.pullRequestNumber,
        expectedSourceHead: identity.sourceHead,
        observedSourceHead: identity.sourceHead,
        eventAction:
          identity.eventAction ||
          (identity.outcome === "dequeued" ? "dequeued" : "closed"),
        outcome: identity.outcome,
        evidenceRoot: identity.evidenceRoot,
        reason: identity.reason,
      },
      { now },
    );
  };
}

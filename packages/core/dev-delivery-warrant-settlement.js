import { devDeliveryContentRoot, devDeliveryExactRoot as exactRoot, devDeliveryExactSha as exactSha, devDeliveryPositiveInteger as positiveInteger, devDeliveryText as text } from "./dev-delivery-common.js";

export const DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA = "kungfu.buildchain.dev-delivery-settlement-receipt/v1";

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
    evidenceRoot: candidate?.terminal?.evidenceRoot || identity.evidenceRoot || null,
    expectedOldStateRoot: queue.stateRoot,
    nextStateRoot: queue.stateRoot,
    nextAction: "No fenced delivery state remains for this terminal event.",
    ...details,
  };
}

function settleTerminalCandidate(queue, identity, candidate) {
  if (candidate.status !== identity.outcome) {
    if (identity.outcome !== "dequeued") throw new Error("terminal candidate outcome does not match the terminal event");
    const receipt = noopReceipt(queue, identity, candidate, "stale-transient-dequeue-noop", {
      terminalClass: "transient-dequeue",
      authoritativeOutcome: candidate.status,
      nextAction: "Retain the authoritative terminal settlement; the stale dequeue cannot rewrite it.",
    });
    return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
  }
  const receipt = noopReceipt(queue, identity, candidate, "duplicate-terminal-event-noop");
  return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

function retainDequeuedWarrant(queue, identity, candidate, fencingToken, leaseGeneration, now) {
  const leaseFresh = Date.parse(queue.activeWarrant.expiresAt) > Date.parse(now);
  const receipt = noopReceipt(queue, identity, candidate, leaseFresh ? "transient-dequeue-retained-active-warrant" : "expired-active-warrant-awaits-fenced-settlement", {
    terminalClass: "transient-dequeue",
    fencingToken,
    leaseGeneration,
    warrantExpiresAt: queue.activeWarrant.expiresAt,
    nextAction: leaseFresh ? "Continue the exact active native execution and heartbeat; later candidates remain queued." : "Prove the stale native worker stopped, then close this exact fenced generation before selecting a successor.",
  });
  return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

export function createDevDeliveryTerminalSettler({ normalizeQueue, closeWarrant, cancelQueued, terminalStates }) {
  return function settleDevDeliveryTerminalEvent(queueInput, input, { now = new Date().toISOString() } = {}) {
    const queue = normalizeQueue(queueInput);
    const identity = {
      pullRequestNumber: positiveInteger(input?.pullRequestNumber, "pullRequestNumber"),
      sourceHead: exactSha(input?.sourceHead, "sourceHead"),
      outcome: text(input?.outcome),
      evidenceRoot: input?.evidenceRoot ? exactRoot(input.evidenceRoot, "evidenceRoot") : "",
      reason: text(input?.reason),
      eventAction: text(input?.eventAction).toLowerCase(),
    };
    if (!terminalStates.has(identity.outcome)) throw new Error(`outcome must be one of ${[...terminalStates].join(", ")}`);
    const samePullRequest = queue.candidates.filter((entry) => entry.pullRequestNumber === identity.pullRequestNumber);
    const matchingHead = samePullRequest.filter((entry) => entry.sourceHead === identity.sourceHead);
    const activeCandidate = queue.activeWarrant ? matchingHead.find((entry) => entry.candidateId === queue.activeWarrant.candidateId) : null;
    const candidate = activeCandidate || matchingHead.at(-1) || null;
    if (!candidate && samePullRequest.length > 0) throw new Error("terminal event sourceHead does not match the recorded candidate");

    if (candidate && terminalStates.has(candidate.status)) {
      return settleTerminalCandidate(queue, identity, candidate);
    }

    if (queue.activeWarrant) {
      if (!candidate || queue.activeWarrant.candidateId !== candidate.candidateId) throw new Error("terminal event does not match the active Delivery Warrant");
      if (!identity.evidenceRoot) throw new Error("active terminal settlement requires evidenceRoot");
      const fencingToken = exactRoot(input?.fencingToken, "fencingToken");
      const leaseGeneration = positiveInteger(input?.leaseGeneration, "leaseGeneration");
      if (fencingToken !== queue.activeWarrant.fencingToken) throw new Error("stale fencing token");
      if (leaseGeneration !== queue.activeWarrant.generation) throw new Error("stale lease generation");
      if (identity.outcome === "dequeued") {
        return retainDequeuedWarrant(queue, identity, candidate, fencingToken, leaseGeneration, now);
      }
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
          now,
        },
      );
    }

    if (!candidate) {
      const receipt = noopReceipt(queue, identity, null, "terminal-event-not-applicable");
      return { queue, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
    }
    if (candidate.status !== "queued") throw new Error(`candidate status ${candidate.status} requires an active Delivery Warrant`);
    if (!["cancelled", "dequeued"].includes(identity.outcome)) throw new Error("queued candidate cannot settle as merged or terminal-failure");
    if (!identity.evidenceRoot) throw new Error("queued terminal settlement requires evidenceRoot");
    return cancelQueued(
      queue,
      {
        candidateId: candidate.candidateId,
        pullRequestNumber: identity.pullRequestNumber,
        expectedSourceHead: identity.sourceHead,
        observedSourceHead: identity.sourceHead,
        eventAction: identity.eventAction || (identity.outcome === "dequeued" ? "dequeued" : "closed"),
        outcome: identity.outcome,
        evidenceRoot: identity.evidenceRoot,
        reason: identity.reason,
      },
      { now },
    );
  };
}

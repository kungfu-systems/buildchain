import { devDeliveryClone as clone, devDeliveryContentRoot, devDeliveryExactRoot as exactRoot, devDeliveryExactSha as exactSha, devDeliveryPositiveInteger as positiveInteger, devDeliveryText as text, devDeliveryTimestamp as timestamp } from "./dev-delivery-common.js";

export const DEV_DELIVERY_CANCELLATION_RECEIPT_SCHEMA = "kungfu.buildchain.dev-delivery-cancellation-receipt/v1";

const TERMINAL_STATES = new Set(["merged", "terminal-failure", "dequeued", "cancelled"]);
const QUEUED_CANCELLATION_EVENTS = new Map([
  ["closed", "cancelled"],
  ["cancelled", "cancelled"],
  ["dequeued", "dequeued"],
]);

function cancellationReceipt(queue, candidate, identity, action, expectedOldStateRoot) {
  return {
    schema: DEV_DELIVERY_CANCELLATION_RECEIPT_SCHEMA,
    action,
    repository: queue.repository,
    protectedBase: queue.protectedBase,
    candidateId: candidate.candidateId,
    pullRequestNumber: candidate.pullRequestNumber,
    expectedSourceHead: identity.expectedSourceHead,
    observedSourceHead: identity.observedSourceHead,
    eventAction: identity.eventAction,
    outcome: identity.outcome,
    evidenceRoot: identity.evidenceRoot,
    expectedOldStateRoot,
    nextStateRoot: queue.stateRoot,
    nextAction: "Select the next queued candidate, if any.",
  };
}

function normalizeCancellation(input) {
  const identity = {
    candidateId: exactRoot(input?.candidateId, "candidateId"),
    pullRequestNumber: positiveInteger(input?.pullRequestNumber, "pullRequestNumber"),
    expectedSourceHead: exactSha(input?.expectedSourceHead, "expectedSourceHead"),
    observedSourceHead: exactSha(input?.observedSourceHead, "observedSourceHead"),
    eventAction: text(input?.eventAction).toLowerCase(),
    outcome: text(input?.outcome).toLowerCase(),
    evidenceRoot: exactRoot(input?.evidenceRoot, "evidenceRoot"),
    reason: text(input?.reason),
  };
  const requiredOutcome = QUEUED_CANCELLATION_EVENTS.get(identity.eventAction);
  if (!requiredOutcome) throw new Error(`eventAction must be one of ${[...QUEUED_CANCELLATION_EVENTS.keys()].join(", ")}`);
  if (identity.outcome !== requiredOutcome) throw new Error(`eventAction ${identity.eventAction} requires outcome ${requiredOutcome}`);
  return identity;
}

function terminalBinding(identity) {
  return {
    outcome: identity.outcome,
    reason: identity.reason,
    evidenceRoot: identity.evidenceRoot,
    authority: "queued-candidate-cancellation",
    expectedSourceHead: identity.expectedSourceHead,
    observedSourceHead: identity.observedSourceHead,
    eventAction: identity.eventAction,
  };
}

export function createCancelQueuedDevDeliveryCandidate(normalizeDevDeliveryQueue) {
  return function cancelQueuedDevDeliveryCandidate(queueInput, input, { now = new Date().toISOString() } = {}) {
    const currentTime = timestamp(now, "now");
    const identity = normalizeCancellation(input);
    const before = normalizeDevDeliveryQueue(queueInput);
    const candidate = before.candidates.find((entry) => entry.candidateId === identity.candidateId);
    if (!candidate) throw new Error(`queued candidate ${identity.candidateId} does not exist`);
    if (candidate.pullRequestNumber !== identity.pullRequestNumber) throw new Error("queued candidate PR mismatch");
    if (candidate.sourceHead !== identity.expectedSourceHead) throw new Error("queued candidate recorded sourceHead mismatch");
    if (before.activeWarrant?.candidateId === identity.candidateId) throw new Error("active candidate requires fenced Warrant closeout");

    const terminal = terminalBinding(identity);
    if (TERMINAL_STATES.has(candidate.status)) {
      if (!Object.entries(terminal).every(([field, value]) => candidate.terminal?.[field] === value)) {
        throw new Error("terminal candidate does not match the exact queued cancellation evidence");
      }
      const receipt = cancellationReceipt(before, candidate, identity, "duplicate-cancellation-noop", before.stateRoot);
      return { queue: before, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
    }
    if (candidate.status !== "queued") throw new Error(`candidate status ${candidate.status} requires fenced Warrant closeout`);

    const queue = clone(before);
    delete queue.stateRoot;
    const queued = queue.candidates.find((entry) => entry.candidateId === identity.candidateId);
    queued.status = identity.outcome;
    queued.updatedAt = currentTime;
    queued.terminal = { ...terminal, closedAt: currentTime };
    queue.generation += 1;
    queue.updatedAt = currentTime;
    queue.stateRoot = devDeliveryContentRoot(queue);
    const after = normalizeDevDeliveryQueue(queue);
    const receipt = cancellationReceipt(after, queued, identity, "queued-candidate-cancelled", before.stateRoot);
    return { queue: after, receipt, receiptRoot: devDeliveryContentRoot(receipt) };
  };
}

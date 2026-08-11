import { devDeliveryClone as clone, devDeliveryContentRoot, devDeliveryExactRoot as exactRoot, devDeliveryExactSha as exactSha, devDeliveryPositiveInteger as positiveInteger, devDeliveryProtectedBase as protectedBase, devDeliveryRepository as repository, devDeliveryText as text, devDeliveryTimestamp as timestamp } from "./dev-delivery-common.js";
import { chainedDevDeliveryAttemptInput, createDevDeliveryCandidateIdentity, validateDevDeliveryCandidateChain } from "./dev-delivery-candidate-identity.js";
import { DEV_DELIVERY_CANCELLATION_RECEIPT_SCHEMA, createCancelQueuedDevDeliveryCandidate } from "./dev-delivery-warrant-cancellation.js";
import { DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA, createDevDeliveryTerminalSettler } from "./dev-delivery-warrant-settlement.js";
import { compareReleaseBlockerPriority, normalizeReleaseBlockerPriorityClaim } from "./release-blocker-priority.js";
export { devDeliveryContentRoot } from "./dev-delivery-common.js";
export { RELEASE_BLOCKER_PRIORITY_CLAIM_SCHEMA, createReleaseBlockerPriorityClaim } from "./release-blocker-priority.js";
export { SOURCE_QUALIFICATION_PROOF_SCHEMA, PROJECT_CUT_REPLAY_PROOF_SCHEMA, INTEGRATION_DELIVERY_PROOF_SCHEMA, classifyDevDeliveryDelta, createIntegrationDeliveryProof, createProjectCutReplayPlan, createProjectCutReplayProof, createSourceQualificationProof, verifyIntegrationDeliveryProof, verifyProjectCutReplayProof, verifySourceQualificationProof } from "./dev-delivery-proof.js";
export { DEV_DELIVERY_CANCELLATION_RECEIPT_SCHEMA };
export const DEV_DELIVERY_QUEUE_CONTRACT = "kungfu-buildchain-dev-delivery-warrant-queue";
export const DEV_DELIVERY_WARRANT_SCHEMA = "kungfu.buildchain.dev-delivery-warrant/v1";
export const DEV_DELIVERY_SUBMISSION_RECEIPT_SCHEMA = "kungfu.buildchain.dev-delivery-submission-receipt/v1";
export const DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA = "kungfu.buildchain.dev-delivery-selection-receipt/v1";
export const DEV_DELIVERY_LEASE_RECEIPT_SCHEMA = "kungfu.buildchain.dev-delivery-lease-receipt/v1";
export { DEV_DELIVERY_SETTLEMENT_RECEIPT_SCHEMA };
export const DEV_DELIVERY_PRIORITIES = Object.freeze({
  ordinary: 0,
  expedited: 1,
  emergency: 2,
});

export const DEV_DELIVERY_CLASSES = Object.freeze(["non-native-fast", "native-proof-required", "cross-platform", "release"]);

const TERMINAL_STATES = new Set(["merged", "terminal-failure", "dequeued", "cancelled"]);
function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function priority(value = "ordinary") {
  const normalized = text(value || "ordinary").toLowerCase();
  if (!(normalized in DEV_DELIVERY_PRIORITIES)) {
    throw new Error(`priority must be one of ${Object.keys(DEV_DELIVERY_PRIORITIES).join(", ")}`);
  }
  return normalized;
}

function deliveryClass(value) {
  const normalized = text(value);
  if (!DEV_DELIVERY_CLASSES.includes(normalized)) {
    throw new Error(`deliveryClass must be one of ${DEV_DELIVERY_CLASSES.join(", ")}`);
  }
  return normalized;
}

function normalizePolicy(policy = {}) {
  return {
    agingSeconds: positiveInteger(policy.agingSeconds, "policy agingSeconds", 900),
    maxPriority: positiveInteger(policy.maxPriority, "policy maxPriority", 2),
    leaseSeconds: positiveInteger(policy.leaseSeconds, "policy leaseSeconds", 3600),
    emergencyPolicy: text(policy.emergencyPolicy || "reviewed-explicit-only"),
  };
}

function normalizeCandidate(input, expected) {
  const identity = createDevDeliveryCandidateIdentity(input, expected, deliveryClass);
  if (input.candidateId && input.candidateId !== identity.candidateId) {
    throw new Error(`candidateId mismatch for PR #${identity.pullRequestNumber}`);
  }
  const status = text(input.status || "queued");
  if (!["queued", "selected", "proving", "waiting", "blocked", ...TERMINAL_STATES].includes(status)) {
    throw new Error(`unsupported candidate status ${status || "<empty>"}`);
  }
  const candidate = {
    ...identity,
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    sourceProofRoot: exactRoot(input.sourceProofRoot, "sourceProofRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    ...(Object.hasOwn(input, "sourceWorkflowRunId") ? { sourceWorkflowRunId: nonNegativeInteger(input.sourceWorkflowRunId, "candidate sourceWorkflowRunId", 0) } : {}),
    priority: priority(input.priority),
    enqueuedAt: timestamp(input.enqueuedAt, "candidate enqueuedAt"),
    updatedAt: timestamp(input.updatedAt || input.enqueuedAt, "candidate updatedAt"),
    attempts: positiveInteger(input.attempts, "candidate attempts", 1),
    recoveries: nonNegativeInteger(input.recoveries, "candidate recoveries", 0),
    status,
    terminal: input.terminal || null,
  };
  if (Object.hasOwn(input, "releaseBlockerPriority")) candidate.releaseBlockerPriority = normalizeReleaseBlockerPriorityClaim(input.releaseBlockerPriority, candidate, expected);
  return candidate;
}

function queueBody(queue) {
  const body = clone(queue);
  delete body.stateRoot;
  return body;
}

function withQueueRoot(queue) {
  return {
    ...queueBody(queue),
    stateRoot: devDeliveryContentRoot(queueBody(queue)),
  };
}

export function createDevDeliveryQueue({ repository: repositoryInput, protectedBase: protectedBaseInput, policy = {}, now = new Date().toISOString() } = {}) {
  return withQueueRoot({
    schemaVersion: 1,
    contract: DEV_DELIVERY_QUEUE_CONTRACT,
    repository: repository(repositoryInput),
    protectedBase: protectedBase(protectedBaseInput),
    generation: 0,
    fencingCounter: 0,
    policy: normalizePolicy(policy),
    activeWarrant: null,
    candidates: [],
    updatedAt: timestamp(now, "now"),
  });
}

export function normalizeDevDeliveryQueue(input, expected = {}) {
  const queue = clone(input || {});
  if (queue.contract !== DEV_DELIVERY_QUEUE_CONTRACT || Number(queue.schemaVersion) !== 1) {
    throw new Error(`dev delivery queue must use ${DEV_DELIVERY_QUEUE_CONTRACT} schemaVersion 1`);
  }
  queue.repository = repository(queue.repository);
  queue.protectedBase = protectedBase(queue.protectedBase);
  if (expected.repository && queue.repository !== expected.repository) {
    throw new Error(`dev delivery queue repository mismatch: ${queue.repository} != ${expected.repository}`);
  }
  if (expected.protectedBase && queue.protectedBase !== expected.protectedBase) {
    throw new Error(`dev delivery queue protectedBase mismatch: ${queue.protectedBase} != ${expected.protectedBase}`);
  }
  queue.generation = nonNegativeInteger(queue.generation, "queue generation");
  queue.fencingCounter = nonNegativeInteger(queue.fencingCounter, "queue fencingCounter");
  queue.policy = normalizePolicy(queue.policy);
  queue.candidates = (queue.candidates || []).map((candidate) => normalizeCandidate(candidate, queue));
  validateDevDeliveryCandidateChain(queue.candidates, TERMINAL_STATES);
  queue.updatedAt = timestamp(queue.updatedAt, "queue updatedAt");
  if (queue.activeWarrant) {
    const warrant = queue.activeWarrant;
    if (warrant.schema !== DEV_DELIVERY_WARRANT_SCHEMA) throw new Error("active Warrant schema is unsupported");
    warrant.candidateId = exactRoot(warrant.candidateId, "Warrant candidateId");
    warrant.fencingToken = exactRoot(warrant.fencingToken, "Warrant fencingToken");
    warrant.expectedOldStateRoot = exactRoot(warrant.expectedOldStateRoot, "Warrant expectedOldStateRoot");
    warrant.generation = positiveInteger(warrant.generation, "Warrant generation");
    warrant.issuedAt = timestamp(warrant.issuedAt, "Warrant issuedAt");
    warrant.expiresAt = timestamp(warrant.expiresAt, "Warrant expiresAt");
    const activeCandidates = queue.candidates.filter((candidate) => ["selected", "proving", "waiting", "blocked"].includes(candidate.status));
    if (activeCandidates.length !== 1 || activeCandidates[0].candidateId !== warrant.candidateId) {
      throw new Error("exactly one active candidate must match the active Warrant");
    }
    if (warrant.releaseBlockerPriority?.claimRoot !== activeCandidates[0].releaseBlockerPriority?.claimRoot) throw new Error("active Warrant release-blocker priority drift");
  } else if (queue.candidates.some((candidate) => ["selected", "proving", "waiting", "blocked"].includes(candidate.status))) {
    throw new Error("active candidate exists without an active Warrant");
  }
  const rooted = withQueueRoot(queue);
  if (input.stateRoot && input.stateRoot !== rooted.stateRoot) throw new Error("dev delivery queue stateRoot drift");
  return rooted;
}

function transition(queueInput, mutate, nowInput) {
  const before = normalizeDevDeliveryQueue(queueInput);
  const expectedOldStateRoot = before.stateRoot;
  const queue = clone(before);
  delete queue.stateRoot;
  const now = timestamp(nowInput, "now");
  const result = mutate(queue, before, now);
  queue.generation += 1;
  queue.updatedAt = now;
  const after = withQueueRoot(queue);
  return { before, after, expectedOldStateRoot, result };
}

function submissionReceipt({ before, after, candidate, action, now }) {
  const queueAgeSeconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(candidate.enqueuedAt)) / 1000));
  return {
    schema: DEV_DELIVERY_SUBMISSION_RECEIPT_SCHEMA,
    repository: after.repository,
    protectedBase: after.protectedBase,
    candidateId: candidate.candidateId,
    pullRequestNumber: candidate.pullRequestNumber,
    sourceHead: candidate.sourceHead,
    assignmentRoot: candidate.assignmentRoot,
    initiativeRoot: candidate.initiativeRoot,
    sourceIdentityRoot: candidate.sourceIdentityRoot,
    sourcePatchRoot: candidate.sourcePatchRoot,
    sourceProofRoot: candidate.sourceProofRoot,
    planRoot: candidate.planRoot,
    closureRoot: candidate.closureRoot,
    dependencyRoot: candidate.dependencyRoot,
    toolchainRoot: candidate.toolchainRoot,
    sourceWorkflowRunId: candidate.sourceWorkflowRunId,
    ...(Object.hasOwn(candidate, "releaseBlockerPriority") ? { releaseBlockerPriority: candidate.releaseBlockerPriority } : {}),
    deliveryClass: candidate.deliveryClass,
    priority: candidate.priority,
    retainedEnqueuedAt: candidate.enqueuedAt,
    queueAgeSeconds,
    attempts: candidate.attempts,
    action,
    expectedOldStateRoot: before.stateRoot,
    nextStateRoot: after.stateRoot,
    nextAction: "Wait for deterministic Warrant selection or observe the active predecessor.",
  };
}

export function submitDevDeliveryCandidate(queueInput, input, { now = new Date().toISOString() } = {}) {
  const transaction = transition(
    queueInput,
    (queue, before, currentTime) => {
      const candidate = normalizeCandidate(
        {
          ...input,
          enqueuedAt: input.enqueuedAt || currentTime,
          updatedAt: currentTime,
          attempts: input.attempts || 1,
          recoveries: input.recoveries || 0,
          status: "queued",
        },
        queue,
      );
      const chainedInput = chainedDevDeliveryAttemptInput({ queue, candidate, input, currentTime, terminalStates: TERMINAL_STATES });
      const attemptedCandidate = chainedInput ? normalizeCandidate(chainedInput, queue) : candidate;
      const conflicting = queue.candidates.find((entry) => entry.pullRequestNumber === attemptedCandidate.pullRequestNumber && entry.candidateId !== attemptedCandidate.candidateId && !TERMINAL_STATES.has(entry.status));
      if (conflicting) throw new Error(`PR #${candidate.pullRequestNumber} already has a different active semantic source`);
      const existing = queue.candidates.find((entry) => entry.candidateId === attemptedCandidate.candidateId);
      let action = "submitted";
      let selected = attemptedCandidate;
      if (existing) {
        if (TERMINAL_STATES.has(existing.status)) {
          throw new Error(`candidate ${attemptedCandidate.candidateId} is terminal and cannot be resubmitted`);
        }
        const exactProofFields = ["sourcePatchRoot", "sourceProofRoot", "planRoot", "closureRoot", "dependencyRoot", "toolchainRoot"];
        const exactProofMatches = exactProofFields.every((field) => existing[field] === attemptedCandidate[field]) && existing.releaseBlockerPriority?.claimRoot === attemptedCandidate.releaseBlockerPriority?.claimRoot;
        if (existing.sourceHead === attemptedCandidate.sourceHead && exactProofMatches) {
          action = "duplicate-noop";
          selected = existing;
        } else {
          if (before.activeWarrant?.candidateId === existing.candidateId) {
            if (existing.sourceHead !== attemptedCandidate.sourceHead) {
              throw new Error("selected candidate sourceHead cannot change before terminal Warrant closeout");
            }
            action = "active-warrant-retained-noop";
            selected = existing;
            return { candidate: selected, action };
          }
          const headChanged = existing.sourceHead !== attemptedCandidate.sourceHead;
          existing.sourceHead = attemptedCandidate.sourceHead;
          for (const field of exactProofFields) existing[field] = attemptedCandidate[field];
          if (Object.hasOwn(attemptedCandidate, "releaseBlockerPriority")) existing.releaseBlockerPriority = attemptedCandidate.releaseBlockerPriority;
          else delete existing.releaseBlockerPriority;
          existing.updatedAt = currentTime;
          existing.attempts += 1;
          existing.status = "queued";
          action = headChanged ? "safe-head-repair-retained-age" : "safe-proof-refresh-retained-age";
          selected = existing;
        }
      } else {
        queue.candidates.push(attemptedCandidate);
      }
      return { candidate: selected, action };
    },
    now,
  );
  const receipt = submissionReceipt({
    before: transaction.before,
    after: transaction.after,
    candidate: transaction.result.candidate,
    action: transaction.result.action,
    now: timestamp(now, "now"),
  });
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}

function effectivePriority(candidate, policy, now) {
  const ageSeconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(candidate.enqueuedAt)) / 1000));
  const agingBoost = Math.floor(ageSeconds / policy.agingSeconds);
  return {
    ageSeconds,
    basePriority: DEV_DELIVERY_PRIORITIES[candidate.priority],
    agingBoost,
    score: Math.min(policy.maxPriority, DEV_DELIVERY_PRIORITIES[candidate.priority] + agingBoost),
    releaseBlocker: Boolean(candidate.releaseBlockerPriority),
  };
}

export function rankDevDeliveryCandidates(queueInput, { now = new Date().toISOString() } = {}) {
  const queue = normalizeDevDeliveryQueue(queueInput);
  const currentTime = timestamp(now, "now");
  return queue.candidates
    .filter((candidate) => candidate.status === "queued")
    .map((candidate) => ({
      candidate,
      priority: effectivePriority(candidate, queue.policy, currentTime),
    }))
    .sort((left, right) => compareReleaseBlockerPriority(left, right) || right.priority.score - left.priority.score || left.candidate.enqueuedAt.localeCompare(right.candidate.enqueuedAt) || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
}

function warrantToken(input) {
  return devDeliveryContentRoot({
    schema: DEV_DELIVERY_WARRANT_SCHEMA,
    repository: input.repository,
    protectedBase: input.protectedBase,
    candidateId: input.candidateId,
    generation: input.generation,
    expectedOldStateRoot: input.expectedOldStateRoot,
    issuedAt: input.issuedAt,
  });
}

export function selectDevDeliveryWarrant(queueInput, { now = new Date().toISOString(), leaseSeconds } = {}) {
  const currentTime = timestamp(now, "now");
  let queue = normalizeDevDeliveryQueue(queueInput);
  let recoveryReceipt = null;
  if (queue.activeWarrant && Date.parse(queue.activeWarrant.expiresAt) <= Date.parse(currentTime)) {
    const recovered = recoverExpiredDevDeliveryWarrant(queue, {
      now: currentTime,
    });
    queue = recovered.queue;
    recoveryReceipt = recovered.receipt;
  }
  if (queue.activeWarrant) {
    const receipt = {
      schema: DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA,
      selected: true,
      reason: "non-preemptive-active-warrant",
      candidateId: queue.activeWarrant.candidateId,
      fencingToken: queue.activeWarrant.fencingToken,
      leaseGeneration: queue.activeWarrant.generation,
      expectedOldStateRoot: recoveryReceipt?.expectedOldStateRoot || queue.stateRoot,
      nextStateRoot: queue.stateRoot,
      nextAction: "Continue the active delivery attempt; later candidates remain visibly queued.",
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
      const candidate = next.candidates.find((entry) => entry.candidateId === selected.candidate.candidateId);
      next.fencingCounter += 1;
      const issuedAt = currentTime;
      const effectiveLeaseSeconds = positiveInteger(leaseSeconds, "leaseSeconds", next.policy.leaseSeconds);
      const warrant = {
        schema: DEV_DELIVERY_WARRANT_SCHEMA,
        repository: next.repository,
        protectedBase: next.protectedBase,
        candidateId: candidate.candidateId,
        pullRequestNumber: candidate.pullRequestNumber,
        sourceHead: candidate.sourceHead,
        assignmentRoot: candidate.assignmentRoot,
        initiativeRoot: candidate.initiativeRoot,
        sourceIdentityRoot: candidate.sourceIdentityRoot,
        sourcePatchRoot: candidate.sourcePatchRoot,
        sourceProofRoot: candidate.sourceProofRoot,
        planRoot: candidate.planRoot,
        closureRoot: candidate.closureRoot,
        dependencyRoot: candidate.dependencyRoot,
        toolchainRoot: candidate.toolchainRoot,
        sourceWorkflowRunId: candidate.sourceWorkflowRunId,
        ...(Object.hasOwn(candidate, "releaseBlockerPriority") ? { releaseBlockerPriority: candidate.releaseBlockerPriority } : {}),
        deliveryClass: candidate.deliveryClass,
        generation: next.fencingCounter,
        expectedOldStateRoot: before.stateRoot,
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + effectiveLeaseSeconds * 1000).toISOString(),
        fencingToken: "",
        nextAction: "Replay on the exact current dev base, prove required checks, then enqueue the unchanged PR head.",
      };
      warrant.fencingToken = warrantToken(warrant);
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
    reason: selected.priority.releaseBlocker ? "release-blocker-bounded-priority" : selected.priority.agingBoost > 0 ? "fifo-aging-bounded-priority" : "fifo-bounded-priority",
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
    ...(Object.hasOwn(transaction.result.candidate, "releaseBlockerPriority") ? { releaseBlockerPriority: transaction.result.candidate.releaseBlockerPriority } : {}),
    deliveryClass: transaction.result.candidate.deliveryClass,
    queueAgeSeconds: selected.priority.ageSeconds,
    basePriority: selected.priority.basePriority,
    agingBoost: selected.priority.agingBoost,
    effectivePriority: selected.priority.score,
    fencingToken: transaction.result.warrant.fencingToken,
    leaseGeneration: transaction.result.warrant.generation,
    expectedOldStateRoot: recoveryReceipt?.expectedOldStateRoot || transaction.expectedOldStateRoot,
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

function assertWarrantMutation(queue, warrant, now, { allowExpired = false } = {}) {
  if (!queue.activeWarrant) throw new Error("no active Delivery Warrant");
  if (text(warrant?.fencingToken) !== queue.activeWarrant.fencingToken) throw new Error("stale fencing token");
  if (Number(warrant?.generation) !== queue.activeWarrant.generation) throw new Error("stale lease generation");
  if (text(warrant?.candidateId) !== queue.activeWarrant.candidateId) throw new Error("Warrant candidate mismatch");
  if (!allowExpired && Date.parse(queue.activeWarrant.expiresAt) <= Date.parse(now)) throw new Error("Delivery Warrant lease expired");
}

export function heartbeatDevDeliveryWarrant(queueInput, warrant, { now = new Date().toISOString(), leaseSeconds } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    queueInput,
    (queue, before) => {
      assertWarrantMutation(before, warrant, currentTime);
      const effectiveLeaseSeconds = positiveInteger(leaseSeconds, "leaseSeconds", queue.policy.leaseSeconds);
      queue.activeWarrant.expiresAt = new Date(Date.parse(currentTime) + effectiveLeaseSeconds * 1000).toISOString();
      const candidate = queue.candidates.find((entry) => entry.candidateId === queue.activeWarrant.candidateId);
      candidate.status = "proving";
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

export function recoverExpiredDevDeliveryWarrant(queueInput, { now = new Date().toISOString() } = {}) {
  const currentTime = timestamp(now, "now");
  const before = normalizeDevDeliveryQueue(queueInput);
  if (!before.activeWarrant || Date.parse(before.activeWarrant.expiresAt) > Date.parse(currentTime)) {
    const receipt = {
      schema: DEV_DELIVERY_LEASE_RECEIPT_SCHEMA,
      action: "recovery-noop",
      reason: before.activeWarrant ? "lease-active" : "no-active-warrant",
      expectedOldStateRoot: before.stateRoot,
      nextStateRoot: before.stateRoot,
      nextAction: before.activeWarrant ? "Continue the active delivery attempt." : "Select the next queued candidate.",
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
      const candidate = queue.candidates.find((entry) => entry.candidateId === expired.candidateId);
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
    nextAction: "Re-select through the queue to mint a new lease generation and fencing token.",
  };
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}

export function closeDevDeliveryWarrant(queueInput, warrant, { outcome, evidenceRoot, reason = "", now = new Date().toISOString() } = {}) {
  const currentTime = timestamp(now, "now");
  const normalizedOutcome = text(outcome);
  if (!TERMINAL_STATES.has(normalizedOutcome)) {
    throw new Error(`outcome must be one of ${[...TERMINAL_STATES].join(", ")}`);
  }
  const transaction = transition(
    queueInput,
    (queue, before) => {
      assertWarrantMutation(before, warrant, currentTime, { allowExpired: true });
      const active = clone(queue.activeWarrant);
      const candidate = queue.candidates.find((entry) => entry.candidateId === active.candidateId);
      candidate.status = normalizedOutcome;
      candidate.updatedAt = currentTime;
      candidate.terminal = {
        outcome: normalizedOutcome,
        reason: text(reason),
        evidenceRoot: exactRoot(evidenceRoot, "evidenceRoot"),
        closedAt: currentTime,
        fencingToken: active.fencingToken,
        leaseGeneration: active.generation,
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
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
    nextAction: "Select the next queued candidate, if any.",
  };
  return {
    queue: transaction.after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}

const cancelQueuedDevDeliveryCandidateTransition = createCancelQueuedDevDeliveryCandidate(normalizeDevDeliveryQueue);
export function cancelQueuedDevDeliveryCandidate(queueInput, input, options) { return cancelQueuedDevDeliveryCandidateTransition(queueInput, input, options); }
export const settleDevDeliveryTerminalEvent = createDevDeliveryTerminalSettler({ normalizeQueue: normalizeDevDeliveryQueue, closeWarrant: closeDevDeliveryWarrant, cancelQueued: cancelQueuedDevDeliveryCandidate, terminalStates: TERMINAL_STATES });

export function observeDevDeliveryQueue(queueInput, { now = new Date().toISOString() } = {}) {
  const queue = normalizeDevDeliveryQueue(queueInput);
  const currentTime = timestamp(now, "now");
  const states = {};
  for (const candidate of queue.candidates) states[candidate.status] = (states[candidate.status] || 0) + 1;
  const queued = rankDevDeliveryCandidates(queue, { now: currentTime });
  return {
    schema: "kungfu.buildchain.dev-delivery-queue-observation/v1",
    repository: queue.repository,
    protectedBase: queue.protectedBase,
    stateRoot: queue.stateRoot,
    generation: queue.generation,
    activeWarrant: queue.activeWarrant,
    activeCandidate: queue.activeWarrant ? queue.candidates.find((candidate) => candidate.candidateId === queue.activeWarrant.candidateId) || null : null,
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
      nextAction: index === 0 && !queue.activeWarrant ? "eligible-for-selection" : "wait-for-active-warrant",
    })),
    observedAt: currentTime,
  };
}

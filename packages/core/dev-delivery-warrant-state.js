import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  chainedDevDeliveryAttemptInput,
  createDevDeliveryCandidateIdentity,
  EXACT_DEV_DELIVERY_PROOF_FIELDS,
  matchesExactDevDeliveryCandidate,
  validateDevDeliveryCandidateChain,
} from "./dev-delivery-candidate-identity.js";
import {
  createDevDeliveryWarrantToken,
  normalizeNativeCommandContract,
  validateActiveDevDeliveryWarrant,
} from "./dev-delivery-native-proof.js";
import {
  normalizeProviderFailureAuthorityBinding,
  normalizeTerminalEvidenceCorrection,
} from "./dev-delivery-warrant-settlement.js";
import {
  compareReleaseBlockerPriority,
  normalizeReleaseBlockerPriorityClaim,
} from "./release-blocker-priority.js";

export const DEV_DELIVERY_QUEUE_CONTRACT =
  "kungfu-buildchain-dev-delivery-warrant-queue";
export const DEV_DELIVERY_WARRANT_SCHEMA =
  "kungfu.buildchain.dev-delivery-warrant/v1";
export const DEV_DELIVERY_SUBMISSION_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-submission-receipt/v1";
export const DEV_DELIVERY_SELECTION_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-selection-receipt/v1";
export const DEV_DELIVERY_LEASE_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-lease-receipt/v1";
export const DEV_DELIVERY_PRIORITIES = Object.freeze({
  ordinary: 0,
  expedited: 1,
  emergency: 2,
});
export const DEV_DELIVERY_CLASSES = Object.freeze([
  "non-native-fast",
  "native-proof-required",
  "cross-platform",
  "release",
]);
export const TERMINAL_STATES = new Set([
  "merged",
  "terminal-failure",
  "dequeued",
  "cancelled",
  "superseded",
]);
export function issueDevDeliveryWarrant(
  queue,
  before,
  candidate,
  currentTime,
  leaseSeconds,
) {
  queue.fencingCounter += 1;
  const effectiveLeaseSeconds = positiveInteger(
    leaseSeconds,
    "leaseSeconds",
    queue.policy.leaseSeconds,
  );
  const requiresNativeQualification = Boolean(candidate.environmentRoot);
  const warrant = {
    schema: DEV_DELIVERY_WARRANT_SCHEMA,
    ...(requiresNativeQualification ? { phase: "provisional" } : {}),
    repository: queue.repository,
    protectedBase: queue.protectedBase,
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
    ...(candidate.environmentRoot
      ? { environmentRoot: candidate.environmentRoot }
      : {}),
    ...(candidate.nativeCommandContract
      ? { nativeCommandContract: candidate.nativeCommandContract }
      : {}),
    ...(candidate.affectedPaths
      ? { affectedPaths: candidate.affectedPaths }
      : {}),
    ...(candidate.shardEvidenceRoots
      ? { shardEvidenceRoots: candidate.shardEvidenceRoots }
      : {}),
    sourceWorkflowRunId: candidate.sourceWorkflowRunId,
    ...(Object.hasOwn(candidate, "releaseBlockerPriority")
      ? { releaseBlockerPriority: candidate.releaseBlockerPriority }
      : {}),
    deliveryClass: candidate.deliveryClass,
    priority: candidate.priority,
    generation: queue.fencingCounter,
    expectedOldStateRoot: before.stateRoot,
    issuedAt: currentTime,
    expiresAt: new Date(
      Date.parse(currentTime) + effectiveLeaseSeconds * 1000,
    ).toISOString(),
    fencingToken: "",
    nextAction: requiresNativeQualification
      ? "Run or reuse exact native proof under this fence, then atomically qualify before merge admission."
      : "Replay on the exact current dev base, prove required checks, then enqueue the unchanged PR head.",
  };
  warrant.fencingToken = createDevDeliveryWarrantToken(warrant);
  return warrant;
}
function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}
function priority(value = "ordinary") {
  const normalized = text(value || "ordinary").toLowerCase();
  if (!(normalized in DEV_DELIVERY_PRIORITIES))
    throw new Error(
      `priority must be one of ${Object.keys(DEV_DELIVERY_PRIORITIES).join(", ")}`,
    );
  return normalized;
}
function deliveryClass(value) {
  const normalized = text(value);
  if (!DEV_DELIVERY_CLASSES.includes(normalized))
    throw new Error(
      `deliveryClass must be one of ${DEV_DELIVERY_CLASSES.join(", ")}`,
    );
  return normalized;
}
function exactRoots(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return [...new Set(values.map((value) => exactRoot(value, label)))].sort();
}
function normalizePolicy(policy = {}) {
  return {
    agingSeconds: positiveInteger(
      policy.agingSeconds,
      "policy agingSeconds",
      900,
    ),
    maxPriority: positiveInteger(policy.maxPriority, "policy maxPriority", 2),
    leaseSeconds: positiveInteger(
      policy.leaseSeconds,
      "policy leaseSeconds",
      3600,
    ),
    emergencyPolicy: text(policy.emergencyPolicy || "reviewed-explicit-only"),
  };
}

function lacksLiveNativeProof(candidate, status, allowLegacyV3Readback) {
  const { environmentRoot, nativeCommandContract } = candidate;
  const native =
    candidate.deliveryClass !== "non-native-fast" ||
    environmentRoot ||
    nativeCommandContract;
  return (
    native &&
    (!environmentRoot ||
      (!nativeCommandContract && allowLegacyV3Readback !== true)) &&
    !TERMINAL_STATES.has(status)
  );
}

function normalizeCandidate(input, expected) {
  const identity = createDevDeliveryCandidateIdentity(
    input,
    expected,
    deliveryClass,
  );
  if (input.candidateId && input.candidateId !== identity.candidateId)
    throw new Error(
      `candidateId mismatch for PR #${identity.pullRequestNumber}`,
    );
  const status = text(input.status || "queued");
  if (
    ![
      "queued",
      "selected",
      "proving",
      "waiting",
      "blocked",
      "qualified",
      ...TERMINAL_STATES,
    ].includes(status)
  )
    throw new Error(`unsupported candidate status ${status || "<empty>"}`);
  const candidate = {
    ...identity,
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    sourceProofRoot: exactRoot(input.sourceProofRoot, "sourceProofRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    ...(input.environmentRoot
      ? { environmentRoot: exactRoot(input.environmentRoot, "environmentRoot") }
      : {}),
    ...(input.nativeCommandContract
      ? {
          nativeCommandContract: normalizeNativeCommandContract(
            input.nativeCommandContract,
          ),
        }
      : {}),
    ...(Object.hasOwn(input, "sourceWorkflowRunId")
      ? {
          sourceWorkflowRunId: nonNegativeInteger(
            input.sourceWorkflowRunId,
            "candidate sourceWorkflowRunId",
            0,
          ),
        }
      : {}),
    priority: priority(input.priority),
    enqueuedAt: timestamp(input.enqueuedAt, "candidate enqueuedAt"),
    updatedAt: timestamp(
      input.updatedAt || input.enqueuedAt,
      "candidate updatedAt",
    ),
    attempts: positiveInteger(input.attempts, "candidate attempts", 1),
    recoveries: nonNegativeInteger(input.recoveries, "candidate recoveries", 0),
    status,
    terminal: input.terminal || null,
  };
  if (candidate.terminal) {
    const failureAuthority = normalizeProviderFailureAuthorityBinding(
      candidate.terminal,
    );
    if (failureAuthority && status !== "terminal-failure") {
      throw new Error(
        "provider failure authority can exist only on terminal-failure state",
      );
    }
    if (failureAuthority)
      candidate.terminal = { ...candidate.terminal, ...failureAuthority };
    if (candidate.terminal.integrationEvidenceCorrection) {
      candidate.terminal.integrationEvidenceCorrection =
        normalizeTerminalEvidenceCorrection(
          candidate.terminal.integrationEvidenceCorrection,
          {
            candidate,
            repository: expected.repository,
            protectedBase: expected.protectedBase,
          },
        );
    }
  }
  if (Object.hasOwn(input, "affectedPaths")) {
    if (!Array.isArray(input.affectedPaths))
      throw new Error("candidate affectedPaths must be an array");
    candidate.affectedPaths = [
      ...new Set(input.affectedPaths.map(text).filter(Boolean)),
    ].sort();
  }
  if (Object.hasOwn(input, "shardEvidenceRoots")) {
    candidate.shardEvidenceRoots = exactRoots(
      input.shardEvidenceRoots,
      "candidate shardEvidenceRoots",
    );
  }
  if (lacksLiveNativeProof(candidate, status, expected.allowLegacyV3Readback))
    throw new Error("live native candidate requires exact native proof");
  if (Object.hasOwn(input, "releaseBlockerPriority"))
    candidate.releaseBlockerPriority = normalizeReleaseBlockerPriorityClaim(
      input.releaseBlockerPriority,
      candidate,
      expected,
    );
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
export function createDevDeliveryQueue({
  repository: repositoryInput,
  protectedBase: protectedBaseInput,
  policy = {},
  now = new Date().toISOString(),
} = {}) {
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
  if (
    queue.contract !== DEV_DELIVERY_QUEUE_CONTRACT ||
    Number(queue.schemaVersion) !== 1
  ) {
    throw new Error(
      `dev delivery queue must use ${DEV_DELIVERY_QUEUE_CONTRACT} schemaVersion 1`,
    );
  }
  queue.repository = repository(queue.repository);
  queue.protectedBase = protectedBase(queue.protectedBase);
  if (expected.repository && queue.repository !== expected.repository)
    throw new Error(
      `dev delivery queue repository mismatch: ${queue.repository} != ${expected.repository}`,
    );
  if (
    expected.protectedBase &&
    queue.protectedBase !== expected.protectedBase
  ) {
    throw new Error(
      `dev delivery queue protectedBase mismatch: ${queue.protectedBase} != ${expected.protectedBase}`,
    );
  }
  queue.generation = nonNegativeInteger(queue.generation, "queue generation");
  queue.fencingCounter = nonNegativeInteger(
    queue.fencingCounter,
    "queue fencingCounter",
  );
  queue.policy = normalizePolicy(queue.policy);
  const allowLegacyV3Readback =
    expected.allowMixedLegacyRecovery === true ||
    (expected.allowLegacyV3Readback === true &&
      !(queue.candidates || []).some(
        (candidate) => candidate?.nativeCommandContract,
      ) &&
      !queue.activeWarrant?.nativeCommandContract &&
      !queue.activeWarrant?.nativeExecutionReceiptRoot &&
      !queue.activeWarrant?.qualificationReceiptRoot);
  queue.candidates = (queue.candidates || []).map((candidate) =>
    normalizeCandidate(candidate, { ...queue, allowLegacyV3Readback }),
  );
  validateDevDeliveryCandidateChain(queue.candidates, TERMINAL_STATES);
  queue.updatedAt = timestamp(queue.updatedAt, "queue updatedAt");
  if (queue.activeWarrant) {
    validateActiveDevDeliveryWarrant(queue, { allowLegacyV3Readback });
  } else if (
    queue.candidates.some((candidate) =>
      ["selected", "proving", "waiting", "blocked", "qualified"].includes(
        candidate.status,
      ),
    )
  ) {
    throw new Error("active candidate exists without an active Warrant");
  }
  const rooted = withQueueRoot(queue);
  if (input.stateRoot && input.stateRoot !== rooted.stateRoot)
    throw new Error("dev delivery queue stateRoot drift");
  return rooted;
}
export function transitionDevDeliveryQueue(queueInput, mutate, nowInput) {
  const before = normalizeDevDeliveryQueue(queueInput);
  const expectedOldStateRoot = before.stateRoot;
  const queue = clone(before);
  delete queue.stateRoot;
  const now = timestamp(nowInput, "now");
  const result = mutate(queue, before, now);
  if (result.preserveState)
    return { before, after: before, expectedOldStateRoot, result };
  queue.generation += 1;
  queue.updatedAt = now;
  const after = withQueueRoot(queue);
  return { before, after, expectedOldStateRoot, result };
}
function submissionReceipt({ before, after, candidate, action, now }) {
  const queueAgeSeconds = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(candidate.enqueuedAt)) / 1000),
  );
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
    ...(candidate.nativeCommandContract
      ? { nativeCommandContract: candidate.nativeCommandContract }
      : {}),
    ...(candidate.shardEvidenceRoots
      ? { shardEvidenceRoots: candidate.shardEvidenceRoots }
      : {}),
    ...(Object.hasOwn(candidate, "releaseBlockerPriority")
      ? { releaseBlockerPriority: candidate.releaseBlockerPriority }
      : {}),
    deliveryClass: candidate.deliveryClass,
    priority: candidate.priority,
    retainedEnqueuedAt: candidate.enqueuedAt,
    queueAgeSeconds,
    attempts: candidate.attempts,
    action,
    expectedOldStateRoot: before.stateRoot,
    nextStateRoot: after.stateRoot,
    nextAction:
      "Wait for deterministic Warrant selection or observe the active predecessor.",
  };
}
export function submitDevDeliveryCandidate(
  queueInput,
  input,
  { now = new Date().toISOString() } = {},
) {
  const transaction = transitionDevDeliveryQueue(
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
      const chainedInput = chainedDevDeliveryAttemptInput({
        queue,
        candidate,
        input,
        currentTime,
        terminalStates: TERMINAL_STATES,
      });
      const attemptedCandidate = chainedInput
        ? normalizeCandidate(chainedInput, queue)
        : candidate;
      const conflicting = queue.candidates.find(
        (entry) =>
          entry.pullRequestNumber === attemptedCandidate.pullRequestNumber &&
          entry.candidateId !== attemptedCandidate.candidateId &&
          !TERMINAL_STATES.has(entry.status),
      );
      if (conflicting)
        throw new Error(
          `PR #${candidate.pullRequestNumber} already has a different active semantic source`,
        );
      const existing = queue.candidates.find(
        (entry) => entry.candidateId === attemptedCandidate.candidateId,
      );
      let action = "submitted";
      let selected = attemptedCandidate;
      if (existing) {
        if (TERMINAL_STATES.has(existing.status)) {
          throw new Error(
            `candidate ${attemptedCandidate.candidateId} is terminal and cannot be resubmitted`,
          );
        }
        if (matchesExactDevDeliveryCandidate(existing, attemptedCandidate)) {
          action =
            before.activeWarrant?.candidateId === existing.candidateId
              ? "active-warrant-noop"
              : "duplicate-noop";
          selected = existing;
          if (action === "active-warrant-noop")
            return { candidate: selected, action, preserveState: true };
        } else {
          if (before.activeWarrant?.candidateId === existing.candidateId) {
            throw new Error(
              "selected candidate sourceHead cannot change before terminal Warrant closeout",
            );
          }
          const headChanged =
            existing.sourceHead !== attemptedCandidate.sourceHead;
          existing.sourceHead = attemptedCandidate.sourceHead;
          for (const field of EXACT_DEV_DELIVERY_PROOF_FIELDS)
            existing[field] = attemptedCandidate[field];
          if (attemptedCandidate.nativeCommandContract)
            existing.nativeCommandContract =
              attemptedCandidate.nativeCommandContract;
          else delete existing.nativeCommandContract;
          if (attemptedCandidate.shardEvidenceRoots)
            existing.shardEvidenceRoots = attemptedCandidate.shardEvidenceRoots;
          else delete existing.shardEvidenceRoots;
          if (Object.hasOwn(attemptedCandidate, "affectedPaths"))
            existing.affectedPaths = attemptedCandidate.affectedPaths;
          else delete existing.affectedPaths;
          if (Object.hasOwn(attemptedCandidate, "releaseBlockerPriority"))
            existing.releaseBlockerPriority =
              attemptedCandidate.releaseBlockerPriority;
          else delete existing.releaseBlockerPriority;
          existing.updatedAt = currentTime;
          existing.attempts += 1;
          existing.status = "queued";
          action = headChanged
            ? "safe-head-repair-retained-age"
            : "safe-proof-refresh-retained-age";
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
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(candidate.enqueuedAt)) / 1000),
  );
  const agingBoost = Math.floor(ageSeconds / policy.agingSeconds);
  return {
    ageSeconds,
    basePriority: DEV_DELIVERY_PRIORITIES[candidate.priority],
    agingBoost,
    score: Math.min(
      policy.maxPriority,
      DEV_DELIVERY_PRIORITIES[candidate.priority] + agingBoost,
    ),
    releaseBlocker: Boolean(candidate.releaseBlockerPriority),
  };
}
export function rankDevDeliveryCandidates(
  queueInput,
  { now = new Date().toISOString(), allowLegacyV3Readback = false } = {},
) {
  const queue = normalizeDevDeliveryQueue(queueInput, {
    allowLegacyV3Readback,
  });
  const currentTime = timestamp(now, "now");
  return queue.candidates
    .filter((candidate) => candidate.status === "queued")
    .map((candidate) => ({
      candidate,
      priority: effectivePriority(candidate, queue.policy, currentTime),
    }))
    .sort(
      (left, right) =>
        compareReleaseBlockerPriority(left, right) ||
        right.priority.score - left.priority.score ||
        left.candidate.enqueuedAt.localeCompare(right.candidate.enqueuedAt) ||
        left.candidate.candidateId.localeCompare(right.candidate.candidateId),
    );
}

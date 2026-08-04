#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import {
  ACTIVE_STATES,
  ALLOWED_TRANSITIONS,
  DEV_DELIVERY_RECEIPT_SCHEMA,
  TERMINAL_STATES,
  assertDevDeliveryQueue,
  assertExpectedOld,
  candidateAgeSeconds,
  candidateIdentity,
  contentRoot,
  emergencyPriorityEvidence,
  exactSha,
  positiveInteger,
  priorityName,
  rankQueuedCandidates,
  requiredText,
  timestamp,
  withQueueRevision,
} from "./dev-delivery-warrant-contract.mjs";
import { verifySourceQualificationProof } from "./dev-delivery-proof.mjs";
import {
  applyIntegrationProofToQueue,
  applySourceReplayProofToQueue,
} from "./dev-delivery-proof-queue.mjs";

export {
  DEV_DELIVERY_POLICY_VERSION,
  DEV_DELIVERY_QUEUE_SCHEMA,
  contentRoot,
  createDevDeliveryQueue,
  queueRevision,
  rankQueuedCandidates,
} from "./dev-delivery-warrant-contract.mjs";
function warrantFor(state, candidate, command, now) {
  const generation = state.fenceGeneration + 1;
  const ttlSeconds = positiveInteger(
    command.ttlSeconds || state.policy.warrantTtlSeconds,
    "Warrant TTL seconds",
  );
  const expiresAt = new Date(now.epoch + ttlSeconds * 1000).toISOString();
  const basis = {
    repository: state.repository,
    protectedBase: state.protectedBase,
    submissionId: candidate.submissionId,
    generation,
    issuedAt: now.value,
    expiresAt,
    controllerId: requiredText(command.controllerId, "controller id"),
  };
  return {
    ...basis,
    warrantId: contentRoot({ type: "delivery-warrant", ...basis }),
    fencingToken: contentRoot({ type: "fencing-token", ...basis }),
    heartbeatAt: now.value,
  };
}

function requireWarrant(state, command, now, { allowExpired = false } = {}) {
  const warrant = state.activeWarrant;
  if (!warrant) throw new Error("no active Delivery Warrant");
  if (requiredText(command.warrantId, "Warrant id") !== warrant.warrantId) {
    const error = new Error("stale Warrant id");
    error.code = "STALE_FENCE";
    throw error;
  }
  if (
    requiredText(command.fencingToken, "fencing token") !== warrant.fencingToken
  ) {
    const error = new Error("stale fencing token");
    error.code = "STALE_FENCE";
    throw error;
  }
  if (!allowExpired && now.epoch >= Date.parse(warrant.expiresAt)) {
    const error = new Error("Delivery Warrant lease expired");
    error.code = "EXPIRED_WARRANT";
    throw error;
  }
  return warrant;
}

function event(command, now, fields = {}) {
  return {
    action: command.action,
    at: now.value,
    controllerId: requiredText(command.controllerId, "controller id"),
    ...fields,
  };
}

function transitionResult(before, next, command, now, details = {}) {
  const after = withQueueRevision({
    ...next,
    updatedAt: now.value,
    history: [
      ...next.history,
      event(command, now, {
        expectedOldRevision: before.revision,
        ...details,
      }),
    ],
  });
  const receipt = {
    schema: DEV_DELIVERY_RECEIPT_SCHEMA,
    action: command.action,
    repository: after.repository,
    protectedBase: after.protectedBase,
    controllerId: requiredText(command.controllerId, "controller id"),
    at: now.value,
    expectedOldRevision: before.revision,
    newRevision: after.revision,
    ...details,
  };
  return {
    state: after,
    receipt: { ...receipt, receiptRoot: contentRoot(receipt) },
  };
}

function noOpResult(state, command, now, details = {}) {
  const receipt = {
    schema: DEV_DELIVERY_RECEIPT_SCHEMA,
    action: command.action,
    repository: state.repository,
    protectedBase: state.protectedBase,
    controllerId: requiredText(command.controllerId, "controller id"),
    at: now.value,
    expectedOldRevision: state.revision,
    newRevision: state.revision,
    ...details,
  };
  return {
    state,
    receipt: { ...receipt, receiptRoot: contentRoot(receipt) },
  };
}

function submit(state, command, now) {
  const candidateInput = command.candidate || {};
  const sourceProof = verifySourceQualificationProof(
    candidateInput.sourceProof,
    {
      repository: state.repository,
      protectedBase: state.protectedBase,
      pullRequestNumber: candidateInput.pullRequestNumber,
      sourceHeadSha: candidateInput.sourceHeadSha,
      semanticSourceRoot: candidateInput.semanticSourceRoot,
    },
  );
  const submissionIdentity = candidateIdentity(
    { ...candidateInput, sourceProofRoot: sourceProof.sourceProofRoot },
    state,
  );
  const existing = state.candidates.find(
    (candidate) => candidate.submissionId === submissionIdentity.submissionId,
  );
  if (existing) {
    return noOpResult(state, command, now, {
      outcome: "duplicate-no-op",
      submissionId: existing.submissionId,
      retainedEnqueuedAt: existing.retainedEnqueuedAt,
    });
  }
  const nextSequence = state.sequence + 1;
  const candidatePriority = priorityName(command.candidate?.priority);
  const candidate = {
    ...submissionIdentity,
    priority: candidatePriority,
    priorityEvidence: emergencyPriorityEvidence(
      candidatePriority,
      command.candidate,
    ),
    enqueuedAt: now.value,
    retainedEnqueuedAt: now.value,
    sequence: nextSequence,
    attempt: 0,
    state: "queued",
    stateReason: "submitted",
    selectedAt: null,
    terminalAt: null,
    warrantId: null,
    proofs: {
      sourceQualificationRoot: sourceProof.sourceProofRoot,
      classificationRoot: null,
      replayReceiptRoot: null,
      integrationDeliveryRoot: null,
    },
    sourceProof,
    candidateTreeSha: null,
    integrationTreeSha: null,
    mergedHeadSha: null,
  };
  return transitionResult(
    state,
    {
      ...state,
      sequence: nextSequence,
      candidates: [...state.candidates, candidate],
    },
    command,
    now,
    {
      outcome: "submitted",
      submissionId: candidate.submissionId,
      retainedEnqueuedAt: candidate.retainedEnqueuedAt,
      priority: candidate.priority,
    },
  );
}

function select(state, command, now) {
  if (state.activeWarrant)
    throw new Error("an active Delivery Warrant already exists");
  const ranked = rankQueuedCandidates(state, now.value);
  if (ranked.length === 0) throw new Error("no queued delivery candidate");
  const selected = ranked[0];
  const warrant = warrantFor(state, selected.candidate, command, now);
  const candidates = state.candidates.map((candidate) =>
    candidate.submissionId === selected.candidate.submissionId
      ? {
          ...candidate,
          state: "warrant-issued",
          stateReason: "fifo-aging-selection",
          selectedAt: now.value,
          attempt: candidate.attempt + 1,
          warrantId: warrant.warrantId,
        }
      : candidate,
  );
  return transitionResult(
    state,
    {
      ...state,
      fenceGeneration: warrant.generation,
      activeWarrant: warrant,
      candidates,
      metrics: { ...state.metrics, selections: state.metrics.selections + 1 },
    },
    command,
    now,
    {
      outcome: "selected",
      submissionId: selected.candidate.submissionId,
      retainedEnqueuedAt: selected.candidate.retainedEnqueuedAt,
      queueAgeSeconds: selected.ageSeconds,
      effectivePriority: selected.effectivePriority,
      selectionReason: "highest-effective-priority-then-oldest-retained-age",
      warrant,
    },
  );
}

function heartbeat(state, command, now) {
  const warrant = requireWarrant(state, command, now);
  const ttlSeconds = positiveInteger(
    command.ttlSeconds || state.policy.warrantTtlSeconds,
    "Warrant TTL seconds",
  );
  const renewed = {
    ...warrant,
    heartbeatAt: now.value,
    expiresAt: new Date(now.epoch + ttlSeconds * 1000).toISOString(),
  };
  return transitionResult(
    state,
    { ...state, activeWarrant: renewed },
    command,
    now,
    {
      outcome: "renewed",
      submissionId: warrant.submissionId,
      warrant: renewed,
    },
  );
}

function setCandidateState(state, command, now) {
  const warrant = requireWarrant(state, command, now);
  const nextState = requiredText(command.state, "candidate state");
  if (!ACTIVE_STATES.has(nextState) && !TERMINAL_STATES.has(nextState)) {
    throw new Error("candidate state is not a delivery lifecycle state");
  }
  if (nextState === "warrant-issued") {
    throw new Error("warrant-issued is created only by selection");
  }
  const candidate = state.candidates.find(
    (entry) => entry.submissionId === warrant.submissionId,
  );
  if (!ALLOWED_TRANSITIONS[candidate.state]?.has(nextState)) {
    throw new Error(
      `invalid delivery transition ${candidate.state} -> ${nextState}`,
    );
  }
  const reason = requiredText(command.reason, "state reason");
  const terminal = TERMINAL_STATES.has(nextState);
  if (nextState === "merge-queued" && !candidate.proofs?.replayReceiptRoot) {
    throw new Error("merge-queued requires an exact source replay receipt");
  }
  let mergedHeadSha = candidate.mergedHeadSha || null;
  if (nextState === "merged") {
    if (!candidate.proofs?.integrationDeliveryRoot) {
      throw new Error("merged requires an exact Integration Delivery Proof");
    }
    mergedHeadSha = exactSha(command.mergedHeadSha, "merged head SHA");
    if (mergedHeadSha !== candidate.integrationTreeSha) {
      throw new Error(
        "merged head does not match the qualified integration tree",
      );
    }
  }
  const candidates = state.candidates.map((candidate) =>
    candidate.submissionId === warrant.submissionId
      ? {
          ...candidate,
          state: nextState,
          stateReason: reason,
          terminalAt: terminal ? now.value : null,
          warrantId: terminal ? null : warrant.warrantId,
          mergedHeadSha,
        }
      : candidate,
  );
  return transitionResult(
    state,
    { ...state, candidates, activeWarrant: terminal ? null : warrant },
    command,
    now,
    {
      outcome: terminal ? "terminal" : "advanced",
      submissionId: warrant.submissionId,
      state: nextState,
      reason,
      fencingToken: warrant.fencingToken,
    },
  );
}

function recover(state, command, now) {
  const warrant = state.activeWarrant;
  if (!warrant) throw new Error("no active Delivery Warrant to recover");
  if (now.epoch < Date.parse(warrant.expiresAt)) {
    throw new Error("active Delivery Warrant has not expired");
  }
  const candidates = state.candidates.map((candidate) =>
    candidate.submissionId === warrant.submissionId
      ? {
          ...candidate,
          state: "queued",
          stateReason: "expired-warrant-recovered",
          selectedAt: null,
          warrantId: null,
        }
      : candidate,
  );
  return transitionResult(
    state,
    {
      ...state,
      activeWarrant: null,
      candidates,
      metrics: {
        ...state.metrics,
        recoveredWarrants: state.metrics.recoveredWarrants + 1,
      },
    },
    command,
    now,
    {
      outcome: "requeued",
      submissionId: warrant.submissionId,
      expiredWarrantId: warrant.warrantId,
      expiredFencingToken: warrant.fencingToken,
      retainedEnqueuedAt: candidates.find(
        (candidate) => candidate.submissionId === warrant.submissionId,
      ).retainedEnqueuedAt,
    },
  );
}

function repair(state, command, now) {
  const currentId = requiredText(command.submissionId, "submission id");
  const candidate = state.candidates.find(
    (entry) => entry.submissionId === currentId,
  );
  if (!candidate) throw new Error("repair candidate is not in the queue");
  if (candidate.state !== "queued") {
    throw new Error(
      "selected or terminal candidates must be settled before repair",
    );
  }
  const sourceProof = verifySourceQualificationProof(command.sourceProof, {
    repository: state.repository,
    protectedBase: state.protectedBase,
    pullRequestNumber: candidate.pullRequestNumber,
    sourceHeadSha: command.sourceHeadSha,
    semanticSourceRoot: command.semanticSourceRoot,
  });
  const repairedIdentity = candidateIdentity(
    {
      ...candidate,
      sourceHeadSha: command.sourceHeadSha,
      semanticSourceRoot: command.semanticSourceRoot,
      sourceProofRoot: sourceProof.sourceProofRoot,
    },
    state,
  );
  if (repairedIdentity.semanticSourceRoot !== candidate.semanticSourceRoot) {
    throw new Error(
      "changed semantic source must be submitted as a new candidate",
    );
  }
  const candidates = state.candidates.map((entry) =>
    entry.submissionId === currentId
      ? {
          ...entry,
          ...repairedIdentity,
          stateReason: "explicit-source-head-repair",
          proofs: {
            sourceQualificationRoot: sourceProof.sourceProofRoot,
            classificationRoot: null,
            replayReceiptRoot: null,
            integrationDeliveryRoot: null,
          },
          sourceProof,
          candidateTreeSha: null,
          integrationTreeSha: null,
          mergedHeadSha: null,
        }
      : entry,
  );
  return transitionResult(
    state,
    {
      ...state,
      candidates,
      metrics: {
        ...state.metrics,
        sourceHeadRepairs: (state.metrics.sourceHeadRepairs || 0) + 1,
      },
    },
    command,
    now,
    {
      outcome: "repaired",
      previousSubmissionId: currentId,
      submissionId: repairedIdentity.submissionId,
      retainedEnqueuedAt: candidate.retainedEnqueuedAt,
      semanticSourceRoot: candidate.semanticSourceRoot,
      sourceProofRoot: sourceProof.sourceProofRoot,
    },
  );
}

function recordProof(state, command, now, applyMutation) {
  const warrant = requireWarrant(state, command, now);
  const mutation = applyMutation(state, command, warrant);
  return transitionResult(
    state,
    { ...state, candidates: mutation.candidates },
    command,
    now,
    mutation.details,
  );
}

function reprioritize(state, command, now) {
  const submissionId = requiredText(command.submissionId, "submission id");
  const candidate = state.candidates.find(
    (entry) => entry.submissionId === submissionId,
  );
  if (!candidate) throw new Error("candidate is not in the queue");
  if (candidate.state !== "queued") {
    throw new Error("priority cannot change after Warrant selection");
  }
  const nextPriority = priorityName(command.priority);
  const nextEvidence = emergencyPriorityEvidence(nextPriority, command);
  const candidates = state.candidates.map((entry) =>
    entry.submissionId === submissionId
      ? {
          ...entry,
          priority: nextPriority,
          priorityEvidence: nextEvidence,
          stateReason: "reviewed-priority-update",
        }
      : entry,
  );
  return transitionResult(state, { ...state, candidates }, command, now, {
    outcome: "reprioritized",
    submissionId,
    previousPriority: candidate.priority,
    priority: nextPriority,
    priorityEvidence: nextEvidence,
    retainedEnqueuedAt: candidate.retainedEnqueuedAt,
  });
}

export function applyDevDeliveryCommand(state, command = {}) {
  assertDevDeliveryQueue(state);
  assertExpectedOld(state, command);
  const now = timestamp(command.now, "now");
  switch (command.action) {
    case "submit":
      return submit(state, command, now);
    case "select":
      return select(state, command, now);
    case "heartbeat":
      return heartbeat(state, command, now);
    case "transition":
      return setCandidateState(state, command, now);
    case "recover":
      return recover(state, command, now);
    case "repair":
      return repair(state, command, now);
    case "record-replay":
      return recordProof(state, command, now, applySourceReplayProofToQueue);
    case "record-integration-proof":
      return recordProof(state, command, now, applyIntegrationProofToQueue);
    case "enqueue-github":
      return setCandidateState(
        state,
        {
          ...command,
          state: "merge-queued",
          reason: command.reason || "github-enqueued-exact-source-head",
        },
        now,
      );
    case "enqueue-rejected":
      return setCandidateState(
        state,
        {
          ...command,
          state: "failed",
          reason: command.reason || "github-enqueue-rejected",
        },
        now,
      );
    case "observe-merged":
      return setCandidateState(
        state,
        {
          ...command,
          state: "merged",
          reason: command.reason || "exact-merged-head-observed",
        },
        now,
      );
    case "reprioritize":
      return reprioritize(state, command, now);
    default:
      throw new Error(`unsupported queue action '${command.action || ""}'`);
  }
}

export function projectDevDeliveryQueue(state, now) {
  assertDevDeliveryQueue(state);
  const observed = timestamp(now, "now");
  const ranked = rankQueuedCandidates(state, observed.value);
  return {
    schema: "kungfu-buildchain-dev-delivery-warrant-view/v1",
    repository: state.repository,
    protectedBase: state.protectedBase,
    revision: state.revision,
    observedAt: observed.value,
    activeWarrant: state.activeWarrant,
    candidates: state.candidates.map((candidate) => {
      const rank = ranked.findIndex(
        (entry) => entry.candidate.submissionId === candidate.submissionId,
      );
      return {
        submissionId: candidate.submissionId,
        pullRequestNumber: candidate.pullRequestNumber,
        sourceHeadSha: candidate.sourceHeadSha,
        sourceProofRoot: candidate.sourceProofRoot,
        state: candidate.state,
        reason: candidate.stateReason,
        priority: candidate.priority,
        retainedEnqueuedAt: candidate.retainedEnqueuedAt,
        queueAgeSeconds: candidateAgeSeconds(candidate, observed.epoch),
        queuePosition: rank < 0 ? null : rank + 1,
        nextAction:
          candidate.state === "queued"
            ? rank === 0 && !state.activeWarrant
              ? "select-and-issue-warrant"
              : "wait-for-active-warrant"
            : ACTIVE_STATES.has(candidate.state)
              ? "continue-exact-warrant-attempt"
              : "inspect-terminal-receipt",
        proofs: candidate.proofs,
        candidateTreeSha: candidate.candidateTreeSha,
        integrationTreeSha: candidate.integrationTreeSha,
        mergedHeadSha: candidate.mergedHeadSha,
      };
    }),
    metrics: state.metrics,
  };
}

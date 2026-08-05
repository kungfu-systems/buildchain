import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
} from "./dev-delivery-common.js";

export const CHAINED_ATTEMPT_IDENTITY = "chained-attempt-v2";

export function createDevDeliveryCandidateIdentity(
  input,
  expected,
  deliveryClass,
) {
  const identity = {
    repository: expected.repository,
    protectedBase: expected.protectedBase,
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "pullRequestNumber",
    ),
    assignmentRoot: exactRoot(input.assignmentRoot, "assignmentRoot"),
    initiativeRoot: exactRoot(input.initiativeRoot, "initiativeRoot"),
    sourceIdentityRoot: exactRoot(
      input.sourceIdentityRoot,
      "sourceIdentityRoot",
    ),
    deliveryClass: deliveryClass(input.deliveryClass),
  };
  if (input.identitySemantics) {
    if (text(input.identitySemantics) !== CHAINED_ATTEMPT_IDENTITY) {
      throw new Error(
        `unsupported candidate identity semantics ${input.identitySemantics}`,
      );
    }
    identity.identitySemantics = CHAINED_ATTEMPT_IDENTITY;
    identity.predecessorCandidateId = exactRoot(
      input.predecessorCandidateId,
      "predecessorCandidateId",
    );
  }
  return { ...identity, candidateId: devDeliveryContentRoot(identity) };
}

export function validateDevDeliveryCandidateChain(candidates, terminalStates) {
  const precedingCandidates = new Map();
  for (const candidate of candidates) {
    if (candidate.identitySemantics === CHAINED_ATTEMPT_IDENTITY) {
      const predecessor = precedingCandidates.get(
        candidate.predecessorCandidateId,
      );
      if (!predecessor)
        throw new Error(
          "chained candidate predecessor must appear earlier in the queue",
        );
      if (predecessor.pullRequestNumber !== candidate.pullRequestNumber) {
        throw new Error(
          "chained candidate predecessor must belong to the same pull request",
        );
      }
      if (!terminalStates.has(predecessor.status)) {
        throw new Error("chained candidate predecessor must be terminal");
      }
    }
    precedingCandidates.set(candidate.candidateId, candidate);
  }
}

export function chainedDevDeliveryAttemptInput({
  queue,
  candidate,
  input,
  currentTime,
  terminalStates,
}) {
  const predecessor = [...queue.candidates]
    .reverse()
    .find(
      (entry) =>
        entry.pullRequestNumber === candidate.pullRequestNumber &&
        terminalStates.has(entry.status),
    );
  if (!predecessor) return null;
  return {
    ...input,
    identitySemantics: CHAINED_ATTEMPT_IDENTITY,
    predecessorCandidateId: predecessor.candidateId,
    enqueuedAt: input.enqueuedAt || currentTime,
    updatedAt: currentTime,
    attempts: input.attempts || 1,
    recoveries: input.recoveries || 0,
    status: "queued",
  };
}

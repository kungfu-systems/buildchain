import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
} from "./dev-delivery-common.js";
export const CHAINED_ATTEMPT_IDENTITY = "chained-attempt-v2";
const terminalBeforeChainCutover = (candidate, terminalStates) =>
  terminalStates.has(candidate.status) &&
  candidate.enqueuedAt < "2026-08-05T14:42:34.000Z";
const UNCHAINED_SUCCESSOR =
  "same-PR successor must chain the latest durable predecessor";
export const EXACT_DEV_DELIVERY_PROOF_FIELDS = Object.freeze([
  "sourcePatchRoot",
  "sourceProofRoot",
  "planRoot",
  "closureRoot",
  "dependencyRoot",
  "toolchainRoot",
  "environmentRoot",
  "sourceWorkflowRunId",
]);

export function matchesExactDevDeliveryCandidate(existing, attempted) {
  return (
    existing.sourceHead === attempted.sourceHead &&
    EXACT_DEV_DELIVERY_PROOF_FIELDS.every(
      (field) => existing[field] === attempted[field],
    ) &&
    JSON.stringify(existing.affectedPaths || []) ===
      JSON.stringify(attempted.affectedPaths || []) &&
    JSON.stringify(existing.shardEvidenceRoots || []) ===
      JSON.stringify(attempted.shardEvidenceRoots || []) &&
    existing.nativeCommandContract?.commandRoot ===
      attempted.nativeCommandContract?.commandRoot &&
    existing.releaseBlockerPriority?.claimRoot ===
      attempted.releaseBlockerPriority?.claimRoot
  );
}

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
  const latestByPullRequest = new Map();
  for (const candidate of candidates) {
    const latest = latestByPullRequest.get(candidate.pullRequestNumber);
    if (
      latest &&
      candidate.identitySemantics !== CHAINED_ATTEMPT_IDENTITY &&
      (!terminalBeforeChainCutover(latest, terminalStates) ||
        !terminalBeforeChainCutover(candidate, terminalStates))
    ) {
      throw new Error(UNCHAINED_SUCCESSOR);
    }
    if (candidate.identitySemantics === CHAINED_ATTEMPT_IDENTITY) {
      const predecessor = precedingCandidates.get(
        candidate.predecessorCandidateId,
      );
      // prettier-ignore
      if (!predecessor) throw new Error("chained candidate predecessor must appear earlier in the queue");
      // prettier-ignore
      if (predecessor.pullRequestNumber !== candidate.pullRequestNumber) throw new Error("chained candidate predecessor must belong to the same pull request");
      // prettier-ignore
      if (!terminalStates.has(predecessor.status)) throw new Error("chained candidate predecessor must be terminal");
      if (latest?.candidateId !== predecessor.candidateId) {
        throw new Error(
          "chained candidate must bind the latest durable predecessor",
        );
      }
    }
    precedingCandidates.set(candidate.candidateId, candidate);
    latestByPullRequest.set(candidate.pullRequestNumber, candidate);
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

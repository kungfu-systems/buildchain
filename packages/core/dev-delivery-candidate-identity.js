import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
} from "./dev-delivery-common.js";

export const CHAINED_ATTEMPT_IDENTITY = "chained-attempt-v2";

function exactRoots(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return [...new Set(values.map((value) => exactRoot(value, label)))].sort();
}

function nativeCommandContract(input = {}) {
  const contract = { schema: "kungfu.buildchain.native-command-contract/v1", runner: "bash-lc", command: text(input.command) };
  if (!contract.command) throw new Error("native command is required");
  if (input.schema && input.schema !== contract.schema) throw new Error("native command contract schema is unsupported");
  if (input.runner && input.runner !== contract.runner) throw new Error("native command contract runner is unsupported");
  const commandRoot = devDeliveryContentRoot(contract);
  if (input.commandRoot && input.commandRoot !== commandRoot) throw new Error("native command contract root drift");
  return { ...contract, commandRoot };
}

export function normalizeDevDeliveryCandidateMetadata(input = {}, label = "candidate") {
  return {
    ...(input.nativeCommandContract ? { nativeCommandContract: nativeCommandContract(input.nativeCommandContract) } : {}),
    ...(Object.hasOwn(input, "shardEvidenceRoots") ? { shardEvidenceRoots: exactRoots(input.shardEvidenceRoots, `${label} shardEvidenceRoots`) } : {}),
  };
}

export function devDeliveryCandidateMetadataMatches(left, right) {
  return left.nativeCommandContract?.commandRoot === right.nativeCommandContract?.commandRoot && JSON.stringify(left.shardEvidenceRoots || []) === JSON.stringify(right.shardEvidenceRoots || []);
}

export function assertDevDeliveryCandidateMetadataMatch(left, right) {
  if (left.nativeCommandContract?.commandRoot !== right.nativeCommandContract?.commandRoot) throw new Error("active Warrant native command contract drift");
  if (JSON.stringify(left.shardEvidenceRoots || []) !== JSON.stringify(right.shardEvidenceRoots || [])) throw new Error("active Warrant shard evidence roots drift");
}

export function replaceDevDeliveryCandidateMetadata(target, source) {
  for (const field of ["nativeCommandContract", "shardEvidenceRoots"]) {
    if (Object.hasOwn(source, field)) target[field] = source[field];
    else delete target[field];
  }
}

export function createDevDeliveryCandidateIdentity(input, expected, deliveryClass) {
  const identity = {
    repository: expected.repository,
    protectedBase: expected.protectedBase,
    pullRequestNumber: positiveInteger(input.pullRequestNumber, "pullRequestNumber"),
    assignmentRoot: exactRoot(input.assignmentRoot, "assignmentRoot"),
    initiativeRoot: exactRoot(input.initiativeRoot, "initiativeRoot"),
    sourceIdentityRoot: exactRoot(input.sourceIdentityRoot, "sourceIdentityRoot"),
    deliveryClass: deliveryClass(input.deliveryClass),
  };
  if (input.identitySemantics) {
    if (text(input.identitySemantics) !== CHAINED_ATTEMPT_IDENTITY) throw new Error(`unsupported candidate identity semantics ${input.identitySemantics}`);
    identity.identitySemantics = CHAINED_ATTEMPT_IDENTITY;
    identity.predecessorCandidateId = exactRoot(input.predecessorCandidateId, "predecessorCandidateId");
  }
  return { ...identity, candidateId: devDeliveryContentRoot(identity) };
}

export function validateDevDeliveryCandidateChain(candidates, terminalStates) {
  const precedingCandidates = new Map();
  for (const candidate of candidates) {
    if (candidate.identitySemantics === CHAINED_ATTEMPT_IDENTITY) {
      const predecessor = precedingCandidates.get(candidate.predecessorCandidateId);
      if (!predecessor) throw new Error("chained candidate predecessor must appear earlier in the queue");
      if (predecessor.pullRequestNumber !== candidate.pullRequestNumber) throw new Error("chained candidate predecessor must belong to the same pull request");
      if (!terminalStates.has(predecessor.status)) throw new Error("chained candidate predecessor must be terminal");
    }
    precedingCandidates.set(candidate.candidateId, candidate);
  }
}

export function chainedDevDeliveryAttemptInput({ queue, candidate, input, currentTime, terminalStates }) {
  const predecessor = [...queue.candidates].reverse().find((entry) => entry.pullRequestNumber === candidate.pullRequestNumber && terminalStates.has(entry.status));
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

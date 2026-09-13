import { pipelineCandidate, terminalPipelineCandidate } from "./reconcile.js";
import {
  pipelineDeliveryStore,
  observePipelineWorker,
} from "./delivery-observation.js";

export function recoveryDelivery(session, host) {
  return host.delivery
    ? host.delivery(session)
    : pipelineDeliveryStore(session, host);
}

export function recoveryOwnerSession(session, owner) {
  return {
    ...session,
    observed: {
      ...session.observed,
      attempt: owner.identity.id,
      generation: owner.generation.id,
      history: [owner],
    },
  };
}

export function recoveryOwnedCandidate(session, queue) {
  if (
    queue.repository !== session.intent.repository ||
    queue.protectedBase !== session.intent.source.targetBranch
  )
    throw new Error(
      "Recovery ownership crossed its protected repository or branch",
    );
  const matches = [...session.observed.history]
    .reverse()
    .filter((owner) => owner.generation.id === session.observed.generation)
    .map((owner) => ({
      owner,
      candidate: pipelineCandidate(queue, { ...owner, intent: session.intent }),
    }))
    .filter((item) => item.candidate);
  if (
    matches.filter((item) => !terminalPipelineCandidate(item.candidate))
      .length > 1
  )
    throw new Error(
      "Recovery found conflicting live native owners in predecessor history",
    );
  return (
    matches.find(
      (item) => item.candidate.candidateId === queue.activeWarrant?.candidateId,
    ) ||
    matches[0] ||
    null
  );
}

export async function observeRecoveryOwnership(session, executions, host) {
  if (
    !executions.terminal ||
    executions.predecessor !== session.observed.attempt
  )
    throw new Error(
      "Recovery ownership requires exact terminal predecessor runs",
    );
  return readRecoveryOwnership(session, host);
}

export async function readRecoveryOwnership(session, host) {
  if (!session.intent.expectedNodes.includes("warrant")) return null;
  const queue = await recoveryDelivery(session, host).read();
  const selected = recoveryOwnedCandidate(session, queue);
  if (!selected)
    return { queue, ownerAttempt: null, candidate: null, worker: null };
  const { owner, candidate } = selected;
  const active = queue.activeWarrant?.candidateId === candidate.candidateId;
  const worker = active
    ? await observePipelineWorker(
        recoveryOwnerSession(session, owner),
        { ...owner, intent: session.intent },
        queue,
        host,
      )
    : null;
  if (active && worker?.status !== "completed")
    throw new Error(
      "Recovery cannot transfer an active Warrant without exact terminal native worker evidence",
    );
  // Read-only admission: the successor retains cleanup intent before settling
  // original ownership and before starting any new execution.
  return { queue, ownerAttempt: owner.identity.id, candidate, worker };
}

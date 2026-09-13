import { recordDigest } from "../../release/discussion/envelope.js";
import {
  readRecoveryOwnership,
  recoveryDelivery,
} from "./recovery-ownership.js";
import { terminalPipelineCandidate } from "./reconcile.js";
import {
  createRecoveryMergeProof,
  retainedRecoveryMergeProof,
} from "./recovery-merge-proof.js";

function cleanupRequest(session, ownership, qualified) {
  const { queue, candidate, worker } = ownership;
  const active = queue.activeWarrant?.candidateId === candidate.candidateId;
  if (!active && candidate.status !== "queued")
    throw new Error("Recovery cannot clean up an unfenced candidate");
  if (active && worker?.status !== "completed")
    throw new Error(
      "Recovery cleanup requires exact terminal native execution",
    );
  const proof = qualified
    ? createRecoveryMergeProof(session, queue, candidate, qualified.integration)
    : null;
  const evidence = {
    schema: "buildchain.pipeline-recovery-ownership/v1",
    attempt: session.observed.attempt,
    ownership,
    proof,
  };
  const request = {
    expectedOldStateRoot: queue.stateRoot,
    pullRequestNumber: candidate.pullRequestNumber,
    expectedSourceHead: candidate.sourceHead,
    eventAction: "cancelled",
    outcome: proof ? "merged" : "cancelled",
    evidenceRoot: proof?.proofRoot || recordDigest(evidence),
    reason: proof
      ? "exact-protected-recovery-integration"
      : "explicit-pipeline-recovery",
    execute: true,
    ...(active
      ? {
          fencingToken: queue.activeWarrant.fencingToken,
          leaseGeneration: queue.activeWarrant.generation,
        }
      : {
          candidateId: candidate.candidateId,
          observedSourceHead: candidate.sourceHead,
        }),
  };
  return { ...evidence, method: active ? "settle" : "cancelQueued", request };
}

async function retainRequest(session, pending, host) {
  const root = recordDigest(pending);
  const material = await host
    .materialStore(session)
    .retain(
      `recovery/ownership-request/${root.slice(7)}`,
      pending,
      "provider-readback",
    );
  session.observed = await session.journal.read();
  await session.progress.progress({
    attempt: session.observed.attempt,
    phase: "admission",
    state: "waiting",
    eventKey: `recovery-ownership:${root}`,
    materials: [material],
    expectedHead: session.observed.head,
  });
  session.observed = await session.journal.read();
}

function verifyTerminal(before, after, request) {
  if (
    !after ||
    after.candidateId !== before.candidateId ||
    after.sourceRoot !== before.sourceRoot ||
    after.status !== request.outcome ||
    after.terminal?.evidenceRoot !== request.evidenceRoot
  )
    throw new Error("Recovery cleanup lacks exact terminal native readback");
}

async function applyRequest(session, pending, host) {
  const current = await session.journal.read();
  if (
    current.attempt !== pending.attempt ||
    current.head !== session.observed.head
  )
    throw new Error(
      "Recovery ownership admission advanced before native cleanup",
    );
  const delivery = recoveryDelivery(session, host);
  let response = null,
    error = null;
  try {
    response = await delivery.service[pending.method](pending.request);
  } catch (cause) {
    error = cause;
  }
  const queue = await delivery.read();
  const candidate = queue.candidates.find(
    (item) => item.candidateId === pending.ownership.candidate.candidateId,
  );
  try {
    verifyTerminal(pending.ownership.candidate, candidate, pending.request);
    if (queue.activeWarrant?.candidateId === candidate.candidateId)
      throw new Error("Recovery cleanup retained its active Warrant");
  } catch (readbackError) {
    throw error || readbackError;
  }
  return {
    queue,
    candidate,
    proof: pending.proof,
    response,
    lostResponse: Boolean(error),
  };
}

export async function settleRecoveryOwnership(session, qualified, host) {
  const ownership = await readRecoveryOwnership(session, host);
  if (!ownership?.candidate) {
    if (qualified && session.intent.expectedNodes.includes("warrant"))
      throw new Error(
        "Merged recovery lost its original native candidate authority",
      );
    return ownership;
  }
  if (terminalPipelineCandidate(ownership.candidate)) {
    if (Boolean(qualified) !== (ownership.candidate.status === "merged"))
      throw new Error(
        "Protected integration conflicts with terminal native ownership",
      );
    const proof = qualified
      ? await retainedRecoveryMergeProof(
          session,
          ownership.candidate,
          qualified.integration,
          host,
        )
      : null;
    return { ...ownership, proof, response: null, lostResponse: false };
  }
  const pending = cleanupRequest(session, ownership, qualified);
  await retainRequest(session, pending, host);
  return applyRequest(session, pending, host);
}

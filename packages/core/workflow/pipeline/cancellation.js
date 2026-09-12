import { recordDigest } from "../../release/discussion/envelope.js";

function cancellationEvent(reason) {
  if (reason === "source-generation-changed") return "synchronize";
  if (reason === "pull-request-dequeued") return "dequeued";
  if (reason === "pull-request-closed") return "closed";
  return "cancelled";
}

function exactCandidate(fresh, id) {
  const candidate = fresh.queue.candidates.find(
    (entry) => entry.candidateId === id,
  );
  if (
    !candidate ||
    candidate.sourceHead !== fresh.current.generation.source.commit ||
    candidate.pullRequestNumber !== fresh.current.intent.source.pullRequest
  )
    throw new Error("Cancellation candidate source identity drift");
  return candidate;
}

async function applyCleanup(fresh, readback, service) {
  const { decision } = readback;
  const candidate = exactCandidate(fresh, readback.candidateId);
  const request = {
    expectedOldStateRoot: fresh.queue.stateRoot,
    pullRequestNumber: candidate.pullRequestNumber,
    expectedSourceHead: candidate.sourceHead,
    eventAction: cancellationEvent(decision.reason),
    evidenceRoot: recordDigest(readback),
    outcome:
      decision.reason === "pull-request-dequeued" ? "dequeued" : "cancelled",
    reason: decision.reason,
    execute: true,
  };
  if (decision.operation === "cancel-queued")
    return service.cancelQueued({
      ...request,
      candidateId: candidate.candidateId,
      observedSourceHead:
        readback.live.observedHead || readback.live.source?.commit,
    });
  if (
    !candidate.terminal &&
    (fresh.queue.activeWarrant?.candidateId !== candidate.candidateId ||
      fresh.worker?.status !== "completed")
  )
    throw new Error(
      "Active cancellation requires exact terminal worker readback",
    );
  const warrant =
    fresh.queue.activeWarrant?.candidateId === candidate.candidateId
      ? fresh.queue.activeWarrant
      : null;
  return service.settle({
    ...request,
    ...(warrant
      ? {
          fencingToken: warrant.fencingToken,
          leaseGeneration: warrant.generation,
        }
      : {}),
  });
}

async function finishCleanup(fresh, result, readbackMaterial, ports) {
  const receipt = await ports.materials.retain(
    `cancellation/receipt-${result.receiptRoot.slice(7)}`,
    result,
  );
  if (
    result.observation.activeWarrant?.candidateId === fresh.decision.candidateId
  )
    return { status: "waiting", reason: "warrant-retained" };
  const prior = fresh.current.phases[fresh.phase];
  if (prior?.payload.state === "cancelled") {
    if (
      prior.payload.reason !== fresh.decision.reason ||
      !prior.payload.materials.some(
        (material) => recordDigest(material) === recordDigest(readbackMaterial),
      )
    )
      throw new Error(
        "Terminal cancellation projection has different evidence",
      );
  } else
    await ports.progress.progress({
      attempt: fresh.attempt,
      phase: fresh.phase,
      state: "cancelled",
      eventKey: `cancelled:${result.receiptRoot}`,
      reason: fresh.decision.reason,
      materials: [readbackMaterial, receipt],
    });
  if (result.receipt.successorWake)
    await ports.wake(result.receipt.successorWake);
  return { status: "cancelled", receiptRoot: result.receiptRoot };
}

// The pending readback is committed to the attempt before the domain mutation.
// Recovery can therefore prove a completed effect even if its response was lost.
export async function cancelPipelineCandidate({ attempt, decision }, ports) {
  const fresh = await ports.observe();
  if (
    fresh.attempt !== attempt ||
    recordDigest(fresh.decision) !== recordDigest(decision)
  )
    throw new Error("Pipeline cancellation changed during admission");
  if (decision.operation === "stop-worker") {
    await ports.progress.requestStop(decision.reason);
    return { status: "waiting", reason: "provider-worker-stop-required" };
  }
  if (!["cancel-queued", "settle-cancelled"].includes(decision.operation))
    throw new Error("Pipeline cancellation requires an exact cleanup decision");
  const candidate = exactCandidate(fresh, decision.candidateId);
  const readback = {
    schema: "buildchain.pipeline-cancellation-readback/v1",
    attempt,
    generation: fresh.current.generation.id,
    decision,
    live: fresh.live,
    worker: fresh.worker || null,
    candidateId: candidate.candidateId,
    stateRoot: fresh.queue.stateRoot,
  };
  const evidenceRoot = recordDigest(readback);
  const reference = await ports.materials.retain(
    `cancellation/readback-${evidenceRoot.slice(7)}`,
    readback,
    "provider-readback",
  );
  await ports.progress.progress({
    attempt,
    phase: fresh.phase,
    state: "waiting",
    eventKey: `cancellation-request:${evidenceRoot}`,
    reason: `pipeline-stop-requested:${decision.reason}`,
    materials: [reference],
  });
  const result = await applyCleanup(fresh, readback, ports.service);
  return finishCleanup(fresh, result, reference, ports);
}

export async function recoverPipelineCancellation(fresh, ports) {
  const candidate = exactCandidate(fresh, fresh.decision.candidateId);
  if (
    !["cancelled", "dequeued"].includes(candidate.status) ||
    !candidate.terminal?.evidenceRoot
  )
    throw new Error(
      "Cancellation recovery requires terminal provider evidence",
    );
  const id = `cancellation/readback-${candidate.terminal.evidenceRoot.slice(7)}`;
  const reference = fresh.current.materials[id];
  if (!reference)
    throw new Error("Cancellation intent was not retained before its effect");
  const readback = await ports.materials.read(reference);
  if (
    recordDigest(readback) !== candidate.terminal.evidenceRoot ||
    readback.attempt !== fresh.attempt ||
    readback.generation !== fresh.current.generation.id ||
    readback.candidateId !== candidate.candidateId
  )
    throw new Error("Cancellation recovery retained evidence drift");
  const recovered = { ...fresh, decision: readback.decision };
  const result = await applyCleanup(recovered, readback, ports.service);
  return finishCleanup(recovered, result, reference, ports);
}

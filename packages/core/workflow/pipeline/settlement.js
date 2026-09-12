import {
  createIntegrationDeliveryProof,
  verifyIntegrationDeliveryProof,
} from "../../dev-delivery/dev-delivery-warrant.js";
import { readBusinessAttempt } from "../attempt/reader.js";
import { pipelineCandidate } from "./reconcile.js";

async function qualifyWarrant(session, current, queue, materials) {
  if (current.phases.warrant?.payload.state === "success") return;
  if (queue.activeWarrant?.phase !== "qualified")
    throw new Error("Merged pipeline has no qualified active Warrant");
  const reference = await materials.retain(
    `warrant/qualified-${queue.stateRoot.slice(7)}`,
    queue,
    "provider-readback",
  );
  await session.progress.progress({
    attempt: current.identity.id,
    phase: "warrant",
    state: "success",
    eventKey: `qualified:${queue.stateRoot}`,
    materials: [reference],
  });
}

async function integrationProof(session, fresh, host, materials) {
  const { queue, current } = fresh;
  const candidate = pipelineCandidate(queue, current);
  if (!candidate)
    throw new Error("Merged pipeline candidate authority is missing");
  if (candidate.status === "merged") {
    const reference =
      current.materials[
        `merge/proof-${candidate.terminal.evidenceRoot.slice(7)}`
      ];
    if (!reference)
      throw new Error(
        "Merged Warrant has no retained pre-effect integration proof",
      );
    const proof = await materials.read(reference);
    if (
      !verifyIntegrationDeliveryProof(proof, {
        sourceProofRoot: candidate.sourceProofRoot,
        warrantCandidateId: candidate.candidateId,
      }).ok
    )
      throw new Error("Retained integration proof is invalid");
    return { candidate, proof, reference };
  }
  if (candidate.candidateId !== queue.activeWarrant?.candidateId)
    throw new Error("Merged candidate is not the active Warrant");
  await qualifyWarrant(session, current, queue, materials);
  const readback = await host.integration.observe(current);
  const proof = createIntegrationDeliveryProof({
    repository: host.repository,
    protectedBase: session.intent.source.targetBranch,
    sourceProofRoot: candidate.sourceProofRoot,
    warrant: queue.activeWarrant,
    currentBase: readback.mergeCommit,
    replayTree: readback.mergeTree,
    mergeGroupHead: readback.mergeCommit,
    mergeGroupTree: readback.mergeTree,
    requiredContextRoots: [readback.build.root, readback.root],
    verifiedAt: new Date().toISOString(),
  });
  const reference = await materials.retain(
    `merge/proof-${proof.proofRoot.slice(7)}`,
    proof,
  );
  const provider = await materials.retain(
    `merge/provider-${readback.root.slice(7)}`,
    readback,
    "provider-readback",
  );
  await session.progress.progress({
    attempt: current.identity.id,
    phase: "merge",
    state: "waiting",
    eventKey: `merge-request:${proof.proofRoot}`,
    materials: [reference, provider],
  });
  return { candidate, proof, reference };
}

export async function settlePipeline(session, fresh, delivery, host) {
  const materials = host.materialStore(session);
  const { candidate, proof, reference } = await integrationProof(
    session,
    fresh,
    host,
    materials,
  );
  const warrant = fresh.queue.activeWarrant;
  const result = await delivery.service.settle({
    expectedOldStateRoot: fresh.queue.stateRoot,
    pullRequestNumber: candidate.pullRequestNumber,
    expectedSourceHead: candidate.sourceHead,
    outcome: "merged",
    reason: "exact-protected-pipeline-integration",
    evidenceRoot: proof.proofRoot,
    execute: true,
    ...(warrant?.candidateId === candidate.candidateId
      ? {
          fencingToken: warrant.fencingToken,
          leaseGeneration: warrant.generation,
        }
      : {}),
  });
  if (result.observation.activeWarrant?.candidateId === candidate.candidateId)
    throw new Error("Merged settlement retained its active Warrant");
  const receipt = await materials.retain(
    `merge/settlement-${result.receiptRoot.slice(7)}`,
    result,
  );
  await session.progress.progress({
    attempt: fresh.attempt,
    phase: "merge",
    state: "success",
    eventKey: `merged:${result.receiptRoot}`,
    materials: [reference, receipt],
  });
  const successor = result.receipt.successorWake;
  if (successor) {
    const next = await host.provider.lookup(
      host.repository,
      successor.pullRequestNumber,
      session.intent.source.targetBranch,
    );
    if (next) await host.wake(readBusinessAttempt(next.snapshot).attempt);
  }
  return {
    operation: "wait",
    reason: "protected-delivery-settled",
    attempt: fresh.attempt,
  };
}

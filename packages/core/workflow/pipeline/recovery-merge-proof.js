import {
  createIntegrationDeliveryProof,
  verifyIntegrationDeliveryProof,
} from "../../dev-delivery/dev-delivery-warrant.js";
import { recoveryOwnerSession } from "./recovery-ownership.js";

export function verifyRecoveryMergeProof(
  proof,
  candidate,
  integration,
  session,
) {
  if (
    !verifyIntegrationDeliveryProof(proof, {
      repository: session.intent.repository,
      protectedBase: session.intent.source.targetBranch,
      sourceProofRoot: candidate.sourceProofRoot,
      warrantCandidateId: candidate.candidateId,
      currentBase: integration.mergeCommit,
      replayTree: integration.mergeTree,
      mergeGroupHead: integration.mergeCommit,
      mergeGroupTree: integration.mergeTree,
    }).ok
  )
    throw new Error(
      "Recovery merged Warrant has no exact original integration proof",
    );
  return proof;
}

export async function retainedRecoveryMergeProof(
  session,
  candidate,
  integration,
  host,
) {
  let count = 0;
  for (const owner of [...session.observed.history].reverse()) {
    const store = host.materialStore(recoveryOwnerSession(session, owner));
    for (const reference of owner.events
      .flatMap((event) => event.payload.materials)
      .filter(
        (item) =>
          item.id ===
            `merge/proof-${candidate.terminal.evidenceRoot.slice(7)}` ||
          item.id.startsWith("recovery/ownership-request/"),
      )) {
      if (++count > 100)
        throw new Error(
          "Recovery integration proof inventory exceeds its bound",
        );
      const value = await store.read(reference);
      const proof = reference.id.startsWith("merge/proof-")
        ? value
        : value.proof;
      if (proof?.proofRoot === candidate.terminal.evidenceRoot)
        return verifyRecoveryMergeProof(proof, candidate, integration, session);
    }
  }
  throw new Error(
    "Merged predecessor lost its retained pre-effect integration proof",
  );
}

export function createRecoveryMergeProof(
  session,
  queue,
  candidate,
  integration,
) {
  if (
    queue.activeWarrant?.candidateId !== candidate.candidateId ||
    queue.activeWarrant.phase !== "qualified"
  )
    throw new Error(
      "Merged recovery requires the original qualified active Warrant",
    );
  return createIntegrationDeliveryProof({
    repository: session.intent.repository,
    protectedBase: session.intent.source.targetBranch,
    sourceProofRoot: candidate.sourceProofRoot,
    warrant: queue.activeWarrant,
    currentBase: integration.mergeCommit,
    replayTree: integration.mergeTree,
    mergeGroupHead: integration.mergeCommit,
    mergeGroupTree: integration.mergeTree,
    requiredContextRoots: [integration.build.root, integration.root],
    verifiedAt: new Date().toISOString(),
  });
}

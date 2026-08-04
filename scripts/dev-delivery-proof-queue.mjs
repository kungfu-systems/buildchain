// SPDX-License-Identifier: Apache-2.0

import {
  verifyDevDeltaClassification,
  verifyGithubEnqueueReceipt,
  verifyIntegrationDeliveryProof,
  verifySourceReplayReceipt,
} from "./dev-delivery-proof.mjs";

function warrantMatches(receiptWarrant, activeWarrant) {
  for (const field of [
    "warrantId",
    "fencingToken",
    "generation",
    "submissionId",
    "issuedAt",
    "expiresAt",
  ]) {
    if (receiptWarrant?.[field] !== activeWarrant[field]) {
      throw new Error(`proof Warrant ${field} mismatch`);
    }
  }
}

export function applySourceReplayProofToQueue(state, command, warrant) {
  const candidate = state.candidates.find(
    (entry) => entry.submissionId === warrant.submissionId,
  );
  const classification = verifyDevDeltaClassification(command.classification, {
    sourceProof: candidate.sourceProof,
  });
  const replay = verifySourceReplayReceipt(command.replayReceipt, {
    repository: state.repository,
    protectedBase: state.protectedBase,
    sourceProof: candidate.sourceProof,
    classification,
    queueRevision: state.revision,
  });
  warrantMatches(replay.warrant, warrant);
  return {
    candidates: state.candidates.map((entry) =>
      entry.submissionId === warrant.submissionId
        ? {
            ...entry,
            state: "proving",
            stateReason: `source-replay:${classification.mode}`,
            proofs: {
              ...entry.proofs,
              classificationRoot: classification.classificationRoot,
              replayReceiptRoot: replay.replayReceiptRoot,
              integrationDeliveryRoot: null,
            },
            candidateTreeSha: replay.candidateTreeSha,
            integrationTreeSha: null,
            mergedHeadSha: null,
          }
        : entry,
    ),
    details: {
      outcome: "source-replay-recorded",
      submissionId: warrant.submissionId,
      sourceProofRoot: candidate.sourceProofRoot,
      classificationRoot: classification.classificationRoot,
      replayReceiptRoot: replay.replayReceiptRoot,
      candidateTreeSha: replay.candidateTreeSha,
      classificationMode: classification.mode,
      affectedShards: classification.affectedShards,
      physicalPrHeadRewritten: false,
      fencingToken: warrant.fencingToken,
    },
  };
}

export function applyIntegrationProofToQueue(state, command, warrant) {
  const candidate = state.candidates.find(
    (entry) => entry.submissionId === warrant.submissionId,
  );
  if (!candidate.proofs?.replayReceiptRoot) {
    throw new Error(
      "Integration Delivery Proof requires a recorded source replay",
    );
  }
  if (candidate.state !== "merge-queued") {
    throw new Error(
      "Integration Delivery Proof requires the active merge-queued candidate",
    );
  }
  const providerReceipt = verifyGithubEnqueueReceipt(command.providerReceipt, {
    repository: state.repository,
    protectedBase: state.protectedBase,
    submissionId: candidate.submissionId,
    sourceHeadSha: candidate.sourceHeadSha,
    warrant,
    queueRevision: state.revision,
  });
  const proof = verifyIntegrationDeliveryProof(command.integrationProof, {
    repository: state.repository,
    protectedBase: state.protectedBase,
    sourceProofRoot: candidate.sourceProofRoot,
    replayReceiptRoot: candidate.proofs.replayReceiptRoot,
    classificationRoot: candidate.proofs.classificationRoot,
    queueRevision: state.revision,
    providerReceipt,
  });
  warrantMatches(proof.warrant, warrant);
  return {
    candidates: state.candidates.map((entry) =>
      entry.submissionId === warrant.submissionId
        ? {
            ...entry,
            state: "merge-queued",
            stateReason: "exact-integration-proof-recorded",
            proofs: {
              ...entry.proofs,
              integrationDeliveryRoot: proof.integrationProofRoot,
            },
            integrationTreeSha: proof.integrationTreeSha,
          }
        : entry,
    ),
    details: {
      outcome: "integration-proof-recorded",
      submissionId: warrant.submissionId,
      integrationProofRoot: proof.integrationProofRoot,
      integrationTreeSha: proof.integrationTreeSha,
      providerReceiptRoot: proof.providerReceiptRoot,
      fencingToken: warrant.fencingToken,
    },
  };
}

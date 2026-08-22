import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  DEV_DELIVERY_QUALIFICATION_RECEIPT_SCHEMA,
  verifyNativeProofReuseDecision,
  verifyNativeQualificationProof,
} from "./dev-delivery-native-proof.js";

function exactRoots(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must contain at least one content root`);
  }
  return [...new Set(values.map((value) => exactRoot(value, label)))].sort();
}

export function createDevDeliveryWarrantQualifier({
  transition,
  assertWarrantMutation,
} = {}) {
  return function qualifyDevDeliveryWarrant(
    queueInput,
    warrant,
    {
      nativeProof,
      reuseDecision,
      current = {},
      now = new Date().toISOString(),
    } = {},
  ) {
    const currentTime = timestamp(now, "now");
    const transaction = transition(
      queueInput,
      (queue, before) => {
        assertWarrantMutation(before, warrant, currentTime);
        if (before.activeWarrant.phase !== "provisional") {
          throw new Error(
            "only a provisional Delivery Warrant can be qualified",
          );
        }
        const active = before.activeWarrant;
        const proofVerification = verifyNativeQualificationProof(nativeProof, {
          repository: before.repository,
          protectedBase: before.protectedBase,
          sourceHead: active.sourceHead,
          sourceIdentityRoot: active.sourceIdentityRoot,
          sourcePatchRoot: active.sourcePatchRoot,
          planRoot: active.planRoot,
          closureRoot: active.closureRoot,
          dependencyRoot: active.dependencyRoot,
          toolchainRoot: active.toolchainRoot,
          environmentRoot: active.environmentRoot,
          nativeCommandRoot: active.nativeCommandContract?.commandRoot,
        });
        if (!proofVerification.ok) {
          throw new Error(`native proof rejected: ${proofVerification.reason}`);
        }
        const expectedShardEvidenceRoots = exactRoots(
          [
            ...(active.shardEvidenceRoots || []),
            nativeProof.nativeExecutionReceiptRoot,
          ],
          "Warrant shardEvidenceRoots",
        );
        if (
          JSON.stringify(nativeProof.shardEvidenceRoots) !==
          JSON.stringify(expectedShardEvidenceRoots)
        ) {
          throw new Error("native proof rejected: shardEvidenceRoots-mismatch");
        }
        const reuseVerification = verifyNativeProofReuseDecision(
          reuseDecision,
          {
            proof: nativeProof,
            current: {
              ...current,
              sourceHead: active.sourceHead,
              sourceIdentityRoot: active.sourceIdentityRoot,
              sourcePatchRoot: active.sourcePatchRoot,
              planRoot: active.planRoot,
              closureRoot: active.closureRoot,
              dependencyRoot: active.dependencyRoot,
              toolchainRoot: active.toolchainRoot,
              environmentRoot: active.environmentRoot,
              nativeCommandRoot: active.nativeCommandContract?.commandRoot,
            },
          },
        );
        if (!reuseVerification.ok) {
          throw new Error(
            `native proof is not reusable: ${reuseVerification.reason}`,
          );
        }
        const qualificationReceipt = {
          schema: DEV_DELIVERY_QUALIFICATION_RECEIPT_SCHEMA,
          action: "qualified-warrant",
          candidateId: active.candidateId,
          fencingToken: active.fencingToken,
          leaseGeneration: active.generation,
          phase: "qualified",
          nativeCommandRoot: active.nativeCommandContract?.commandRoot,
          nativeProofRoot: proofVerification.proofRoot,
          nativeExecutionReceiptRoot: nativeProof.nativeExecutionReceiptRoot,
          nativeProofReuseRoot: reuseVerification.decisionRoot,
          qualifiedAt: currentTime,
          expectedOldStateRoot: before.stateRoot,
          nextAction:
            "Enter the GitHub merge queue at the exact fenced PR head; merge_group remains final authority.",
        };
        const qualificationReceiptRoot =
          devDeliveryContentRoot(qualificationReceipt);
        queue.activeWarrant.phase = "qualified";
        queue.activeWarrant.nativeProofRoot = proofVerification.proofRoot;
        queue.activeWarrant.nativeExecutionReceiptRoot =
          nativeProof.nativeExecutionReceiptRoot;
        queue.activeWarrant.nativeProofReuseRoot =
          reuseVerification.decisionRoot;
        queue.activeWarrant.qualificationReceiptRoot = qualificationReceiptRoot;
        queue.activeWarrant.qualifiedAt = currentTime;
        queue.activeWarrant.nextAction =
          "Enter the GitHub merge queue at the exact fenced PR head; merge_group remains final authority.";
        const candidate = queue.candidates.find(
          (entry) => entry.candidateId === queue.activeWarrant.candidateId,
        );
        candidate.status = "qualified";
        candidate.updatedAt = currentTime;
        return {
          candidate,
          warrant: queue.activeWarrant,
          qualificationReceipt,
          qualificationReceiptRoot,
        };
      },
      currentTime,
    );
    return {
      queue: transaction.after,
      warrant: transaction.result.warrant,
      receipt: transaction.result.qualificationReceipt,
      receiptRoot: transaction.result.qualificationReceiptRoot,
    };
  };
}

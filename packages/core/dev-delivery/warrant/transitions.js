import {
  cancelQueuedDevDeliveryCandidate,
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  createNativeCommandContract,
  fenceDevDeliveryWriterProtocol,
  heartbeatDevDeliveryWarrant,
  observeDevDeliveryQueue,
  qualifyDevDeliveryWarrant,
  reconcileDevDeliveryTerminalEvidence,
  recoverExpiredDevDeliveryWarrant,
  selectDevDeliveryWarrant,
  settleDevDeliveryTerminalEvent,
  submitDevDeliveryCandidate,
} from "../dev-delivery-warrant.js";
import { reuseExactActiveDevDeliverySourceProof } from "../dev-delivery-candidate-identity.js";
import { runDeliveryWarrantReadCandidate } from "../delivery-warrant-read-candidate.js";

import {
  exactSha,
  exactRoot,
  positiveInteger,
  jsonFile,
  jsonList,
  jsonObject,
} from "./values.js";
function terminalSourceHead(options) {
  return exactSha(
    options.expectedSourceHead || options.sourceHead,
    "sourceHead",
  );
}

function reconcileTerminalEvidenceCommand(queue, options) {
  return reconcileDevDeliveryTerminalEvidence(
    queue,
    {
      candidateId: exactRoot(options.candidateId, "candidateId"),
      expectedPriorEvidenceRoot: exactRoot(
        options.expectedPriorEvidenceRoot,
        "expectedPriorEvidenceRoot",
      ),
      integrationProof:
        options.integrationProof ||
        jsonFile(options.integrationProofPath, "integration proof"),
      reason: options.reason,
    },
    { now: options.now },
  );
}

function warrantIdentity(queue, options) {
  const active = queue.activeWarrant;
  if (!active) throw new Error("no active Delivery Warrant");
  const fencingToken = exactRoot(options.fencingToken, "fencingToken");
  const generation = positiveInteger(
    options.leaseGeneration,
    "leaseGeneration",
  );
  return { candidateId: active.candidateId, fencingToken, generation };
}

export function transitionFor(command, queue, options) {
  if (command === "fence-writer-protocol") {
    return fenceDevDeliveryWriterProtocol(queue, { now: options.now });
  }
  if (command === "submit") {
    const nativeCommandContract = options.environmentRoot
      ? createNativeCommandContract(options.nativeCommand)
      : null;
    if (
      options.nativeCommandRoot &&
      nativeCommandContract?.commandRoot !==
        exactRoot(options.nativeCommandRoot, "nativeCommandRoot")
    ) {
      throw new Error(
        "native command contract root does not match native-command",
      );
    }
    const input = {
      pullRequestNumber: positiveInteger(
        options.pullRequestNumber,
        "pullRequestNumber",
      ),
      sourceHead: exactSha(options.sourceHead, "sourceHead"),
      sourceRoot: exactRoot(options.sourceRoot, "sourceRoot"),
      sourceIdentityRoot: exactRoot(
        options.sourceIdentityRoot,
        "sourceIdentityRoot",
      ),
      sourcePatchRoot: exactRoot(options.sourcePatchRoot, "sourcePatchRoot"),
      sourceProofRoot: exactRoot(options.sourceProofRoot, "sourceProofRoot"),
      planRoot: exactRoot(options.planRoot, "planRoot"),
      closureRoot: exactRoot(options.closureRoot, "closureRoot"),
      dependencyRoot: exactRoot(options.dependencyRoot, "dependencyRoot"),
      toolchainRoot: exactRoot(options.toolchainRoot, "toolchainRoot"),
      ...(options.environmentRoot
        ? {
            environmentRoot: exactRoot(
              options.environmentRoot,
              "environmentRoot",
            ),
          }
        : {}),
      ...(nativeCommandContract ? { nativeCommandContract } : {}),
      affectedPaths: jsonList(options.affectedPaths, "affected paths"),
      shardEvidenceRoots: jsonList(
        options.shardEvidenceRoots,
        "shard evidence roots",
      ),
      sourceWorkflowRunId: options.sourceWorkflowRunId
        ? positiveInteger(options.sourceWorkflowRunId, "sourceWorkflowRunId")
        : 0,
      deliveryClass: options.deliveryClass,
      priority: options.priority || "ordinary",
      ...(options.releaseBlockerPriority
        ? {
            releaseBlockerPriority: jsonObject(
              options.releaseBlockerPriority,
              "release blocker priority",
            ),
          }
        : {}),
    };
    return submitDevDeliveryCandidate(
      queue,
      reuseExactActiveDevDeliverySourceProof(queue.activeWarrant, input),
      { now: options.now },
    );
  }
  if (command === "select") {
    return selectDevDeliveryWarrant(queue, {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    });
  }
  if (command === "heartbeat") {
    return heartbeatDevDeliveryWarrant(queue, warrantIdentity(queue, options), {
      now: options.now,
      leaseSeconds: options.leaseSeconds,
    });
  }
  if (command === "qualify") {
    return qualifyDevDeliveryWarrant(queue, warrantIdentity(queue, options), {
      nativeProof: jsonFile(options.nativeProofPath, "native proof"),
      reuseDecision: jsonFile(
        options.nativeReuseDecisionPath,
        "native reuse decision",
      ),
      current: {
        currentBase: options.currentBase,
        graphKnown: options.graphKnown,
        attributionComplete: options.attributionComplete,
        changedPaths: jsonList(options.changedPaths, "changed paths"),
        renames: jsonList(options.renames, "renames"),
      },
      now: options.now,
    });
  }
  if (command === "recover")
    return recoverExpiredDevDeliveryWarrant(queue, { now: options.now });
  if (command === "close") {
    return closeDevDeliveryWarrant(queue, warrantIdentity(queue, options), {
      outcome: options.outcome,
      evidenceRoot: exactRoot(options.evidenceRoot, "evidenceRoot"),
      reason: options.reason,
      now: options.now,
    });
  }
  if (command === "settle") {
    return settleDevDeliveryTerminalEvent(
      queue,
      {
        pullRequestNumber: positiveInteger(
          options.pullRequestNumber,
          "pullRequestNumber",
        ),
        sourceHead: terminalSourceHead(options),
        fencingToken: options.fencingToken,
        leaseGeneration: options.leaseGeneration,
        outcome: options.outcome,
        eventAction: options.eventAction,
        evidenceRoot: options.evidenceRoot,
        reason: options.reason,
        transferRoot: options.transferRoot,
        finalizerBoundaryRoot: options.finalizerBoundaryRoot,
        nativeJobId: options.nativeJobId,
        sealJobId: options.sealJobId,
      },
      { now: options.now },
    );
  }
  if (command === "reconcile-terminal-evidence") {
    return reconcileTerminalEvidenceCommand(queue, options);
  }
  if (command === "cancel-queued") {
    return cancelQueuedDevDeliveryCandidate(
      queue,
      {
        candidateId: exactRoot(options.candidateId, "candidateId"),
        pullRequestNumber: positiveInteger(
          options.pullRequestNumber,
          "pullRequestNumber",
        ),
        expectedSourceHead: exactSha(
          options.expectedSourceHead,
          "expectedSourceHead",
        ),
        observedSourceHead: exactSha(
          options.observedSourceHead,
          "observedSourceHead",
        ),
        eventAction: options.eventAction,
        outcome: options.outcome,
        evidenceRoot: exactRoot(options.evidenceRoot, "evidenceRoot"),
        reason: options.reason,
      },
      { now: options.now },
    );
  }
  throw new Error(`unsupported dev delivery command ${command || "<empty>"}`);
}

import path from "node:path";
import { devDeliveryContentRoot } from "../dev-delivery-warrant.js";
import { writeJson } from "./files.js";
export async function releaseFailedAttempt({
  error,
  options,
  warrant,
  warrantStateRoot,
  nativeAttempts,
  evidenceDirectory,
  runCommand,
  client,
}) {
  const failure = {
    schema: "kungfu.buildchain.two-phase-delivery-failure/v1",
    pullRequestNumber: options.pullRequestNumber,
    expectedHead: options.expectedHead,
    fencingToken: warrant.fencingToken,
    leaseGeneration: warrant.generation,
    nativeAttempts,
    reason: error.message,
    workerTerminationProven: error.workerTerminationProven !== false,
  };
  const evidenceRoot = devDeliveryContentRoot(failure);
  writeJson(path.join(evidenceDirectory, "failure.json"), {
    ...failure,
    evidenceRoot,
  });
  if (options.nativeOnly) {
    writeJson(
      path.join(evidenceDirectory, "failure-provider-settlement.json"),
      {
        schema: "kungfu.buildchain.two-phase-provider-settlement-required/v1",
        evidenceRoot,
        stateRoot: warrantStateRoot,
        candidateId: warrant.candidateId,
        fencingToken: warrant.fencingToken,
        leaseGeneration: warrant.generation,
        pullRequestNumber: options.pullRequestNumber,
        sourceHead: options.expectedHead,
        workerTerminationProven: error.workerTerminationProven !== false,
        nextAction:
          "Run the separate credentialed post-native finalizer; candidate code has exited and cannot ancestor provider authority.",
      },
    );
    return;
  }
  if (error.workerTerminationProven === false) {
    writeJson(path.join(evidenceDirectory, "failure-warrant-retained.json"), {
      schema: "kungfu.buildchain.two-phase-delivery-retained-warrant/v1",
      reason: error.message,
      fencingToken: warrant.fencingToken,
      leaseGeneration: warrant.generation,
      workerTerminationProven: false,
      nextAction:
        "Prove the fenced native worker stopped before closing or releasing this provisional Warrant.",
    });
    return;
  }
  try {
    const closed = await runCommand({
      command: "close",
      repository: options.repository,
      branch: options.branch,
      fencingToken: warrant.fencingToken,
      leaseGeneration: warrant.generation,
      outcome: "terminal-failure",
      evidenceRoot,
      reason: error.message,
      execute: true,
      token: options.token,
      apiUrl: options.apiUrl,
    });
    writeJson(path.join(evidenceDirectory, "failure-close.json"), closed);
    const nextCandidate = closed.receipt?.successorWake || null;
    if (nextCandidate && options.wakeEventType) {
      try {
        await client.wake(options.wakeEventType, nextCandidate);
        writeJson(path.join(evidenceDirectory, "wake-next.json"), {
          schema: "kungfu.buildchain.dev-delivery-wake-receipt/v1",
          eventType: options.wakeEventType,
          candidateId: nextCandidate.candidateId,
          pullRequestNumber: nextCandidate.pullRequestNumber,
          sourceHead: nextCandidate.sourceHead,
          action: "repository-dispatch-sent",
        });
      } catch (wakeError) {
        writeJson(path.join(evidenceDirectory, "wake-next-error.json"), {
          schema: "kungfu.buildchain.dev-delivery-wake-error/v1",
          reason: wakeError.message,
          candidateId: nextCandidate.candidateId,
          nextAction:
            "A later candidate submission or lease recovery will retry deterministic selection.",
        });
      }
    }
  } catch (closeError) {
    writeJson(path.join(evidenceDirectory, "failure-close-error.json"), {
      schema: "kungfu.buildchain.two-phase-delivery-close-error/v1",
      reason: closeError.message,
      nextAction:
        "Recover the expired lease or close the current fenced generation; no merge admission was attempted.",
    });
  }
}

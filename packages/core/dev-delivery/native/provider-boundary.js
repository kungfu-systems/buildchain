import path from "node:path";
import {
  verifyNativeExecutionTransfer,
  createProviderFinalizerBoundary,
  verifyProviderFailureSettlementBinding,
} from "../dev-delivery-process-boundary.js";
import { readJson, writeJson } from "./files.js";
export function verifyNativeProviderBoundary({
  directory: directoryInput,
  runtimeSelectionRoot,
  pullRequestNumber,
  sourceHead,
  run,
  runner,
  jobs,
  pullRequestReadback,
  baseRefReadback,
  output,
  nativeJob = "native-execution",
  nativeJobName = "Credentialless native execution",
  sealJobName = "Credentialless native evidence seal",
  finalizerJobName = "Credentialed provider finalizer",
  observedAt = new Date().toISOString(),
}) {
  const directory = path.resolve(directoryInput);
  const transfer = verifyNativeExecutionTransfer(
    readJson(
      path.join(directory, "execution-transfer.json"),
      "execution transfer",
    ),
    {
      directory,
      expected: {
        "producer.workflowRunId": run.id,
        "producer.workflowRunAttempt": run.attempt,
        "producer.job": nativeJob,
        "runtime.selectionRoot": runtimeSelectionRoot,
        "warrant.pullRequestNumber": pullRequestNumber,
        "warrant.sourceHead": sourceHead,
      },
    },
  );
  const boundary = createProviderFinalizerBoundary({
    jobs,
    executionTransfer: transfer,
    workflowRunId: run.id,
    workflowRunAttempt: run.attempt,
    nativeJobName,
    sealJobName,
    finalizerJobName,
    finalizerRunnerName: runner.name,
    finalizerRunnerEnvironment: runner.environment,
    pullRequestReadback,
    baseRefReadback,
    observedAt: observedAt,
  });
  writeJson(output, boundary);
  if (transfer.outcome === "failed") {
    const settlement = verifyProviderFailureSettlementBinding(
      boundary,
      transfer,
    );
    writeJson(
      path.join(path.dirname(output), "provider-failure-settlement.json"),
      settlement,
    );
  }
  return boundary;
}

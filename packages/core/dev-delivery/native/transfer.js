import fs from "node:fs";
import path from "node:path";
import {
  createNativeExecutionTransfer,
  createNativeExecutionSealBinding,
  stageNativeExecutionTransfer,
  verifyNativeExecutionTransfer,
} from "../dev-delivery-process-boundary.js";
import { readJson, writeJson } from "./files.js";
function warrantBinding(warrantResult) {
  const warrant =
    warrantResult.observation?.activeWarrant || warrantResult.warrant;
  if (!warrant) throw new Error("active Warrant is missing from transfer");
  return {
    repository: warrant.repository || warrantResult.observation?.repository,
    protectedBase:
      warrant.protectedBase || warrantResult.observation?.protectedBase,
    stateRoot:
      warrantResult.observation?.stateRoot || warrantResult.after?.stateRoot,
    candidateId: warrant.candidateId,
    fencingToken: warrant.fencingToken,
    generation: warrant.generation,
    pullRequestNumber: warrant.pullRequestNumber,
    sourceHead: warrant.sourceHead,
  };
}

export function sealNativeExecution({
  directory: directoryInput,
  stagingDirectory: stagingInput,
  runtimeSelectionRoot,
  runner,
  sealJob = "seal-native-execution",
  observedAt = new Date().toISOString(),
}) {
  const directory = path.resolve(directoryInput);
  const stagingDirectory = path.resolve(
    stagingInput || `${directory}-transfer`,
  );
  const warrantResult = readJson(
    path.join(directory, "warrant.json"),
    "Warrant result",
  );
  const resultPath = "two-phase-native-result.json";
  const failurePath = "failure.json";
  const succeeded = fs.existsSync(path.join(directory, resultPath));
  const context = readJson(
    path.join(directory, "native-job-context.json"),
    "native job context",
  );
  const runtimeSelection = readJson(
    path.join(directory, "runtime-selection.json"),
    "runtime selection",
  );
  const isolation = createNativeExecutionSealBinding({
    nativeContext: context,
    sealJob: sealJob,
    sealRunnerName: runner.name,
    sealRunnerEnvironment: runner.environment,
    sealRunnerOs: runner.os,
    sealRunnerArch: runner.arch,
    observedAt: observedAt,
  });
  if (isolation.nativeOutcome !== (succeeded ? "succeeded" : "failed")) {
    throw new Error("native job context outcome does not match raw evidence");
  }
  const files = [
    "native-job-context.json",
    "runtime-selection.json",
    "warrant.json",
  ];
  let nativeProofRoot = null;
  let nativeReuseDecisionRoot = null;
  if (succeeded) {
    const result = readJson(path.join(directory, resultPath), "native result");
    nativeProofRoot = result.nativeProofRoot;
    nativeReuseDecisionRoot = result.nativeReuseDecisionRoot;
    files.push(resultPath, "native-proof.json", "native-reuse-decision.json");
  } else {
    if (!fs.existsSync(path.join(directory, failurePath))) {
      throw new Error("failed native execution has no failure evidence");
    }
    if (
      !fs.existsSync(path.join(directory, "failure-provider-settlement.json"))
    ) {
      throw new Error(
        "failed native execution has no provider settlement binding",
      );
    }
    files.push(failurePath, "failure-provider-settlement.json");
  }
  stageNativeExecutionTransfer({
    sourceDirectory: directory,
    stagingDirectory,
    files,
  });
  const transfer = createNativeExecutionTransfer({
    directory: stagingDirectory,
    files,
    outcome: succeeded ? "succeeded" : "failed",
    producer: {
      ...isolation.producer,
    },
    sealer: isolation.sealer,
    runtime: {
      repository: runtimeSelection.repository,
      selector: runtimeSelection.selector,
      resolvedSha: runtimeSelection.resolvedSha,
      selectionRoot: runtimeSelectionRoot,
    },
    warrant: warrantBinding(warrantResult),
    nativeProofRoot,
    nativeReuseDecisionRoot,
    completedAt: isolation.nativeCompletedAt,
    sealedAt: isolation.sealedAt,
  });
  const output = "execution-transfer.json";
  writeJson(path.join(stagingDirectory, output), transfer);
  return verifyNativeExecutionTransfer(transfer, {
    directory: stagingDirectory,
  });
}

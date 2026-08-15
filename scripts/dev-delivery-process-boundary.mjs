#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  createNativeExecutionTransfer,
  createNativeExecutionSealBinding,
  createProviderFinalizerBoundary,
  stageNativeExecutionTransfer,
  verifyNativeExecutionTransfer,
  verifyProviderFailureSettlementBinding,
} from "../packages/core/dev-delivery-process-boundary.js";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readJson(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

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

function nativeJobContext(args, environment) {
  const outcome = flag(args, "outcome");
  if (!["succeeded", "failed"].includes(outcome)) {
    throw new Error("native job outcome must be succeeded or failed");
  }
  return {
    schema: "kungfu.buildchain.native-job-context/v1",
    workflowRunId: Number(environment.GITHUB_RUN_ID),
    workflowRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    job: flag(args, "job", "native-execution"),
    runnerEnvironment: environment.BUILDCHAIN_RUNNER_ENVIRONMENT,
    runnerName: environment.RUNNER_NAME,
    runnerOs: environment.RUNNER_OS,
    runnerArch: environment.RUNNER_ARCH,
    outcome,
    evidenceCompletedAt: new Date().toISOString(),
  };
}

function recordNative(args, environment) {
  const context = nativeJobContext(args, environment);
  writeJson(flag(args, "output"), context);
  return context;
}

function seal(args, environment) {
  const directory = path.resolve(flag(args, "directory"));
  const stagingDirectory = path.resolve(
    flag(args, "staging-directory", `${directory}-transfer`),
  );
  const warrantResult = readJson(
    path.join(directory, flag(args, "warrant", "warrant.json")),
    "Warrant result",
  );
  const resultPath = flag(args, "result", "two-phase-native-result.json");
  const failurePath = flag(args, "failure", "failure.json");
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
    sealJob: flag(args, "seal-job", "seal-native-execution"),
    sealRunnerName: environment.RUNNER_NAME,
    sealRunnerEnvironment: environment.BUILDCHAIN_RUNNER_ENVIRONMENT,
    sealRunnerOs: environment.RUNNER_OS,
    sealRunnerArch: environment.RUNNER_ARCH,
    observedAt: new Date().toISOString(),
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
      selectionRoot: flag(args, "runtime-selection-root"),
    },
    warrant: warrantBinding(warrantResult),
    nativeProofRoot,
    nativeReuseDecisionRoot,
    completedAt: isolation.nativeCompletedAt,
    sealedAt: isolation.sealedAt,
  });
  const output = flag(args, "output", "execution-transfer.json");
  if (output !== "execution-transfer.json") {
    throw new Error("native transfer manifest must be execution-transfer.json");
  }
  writeJson(path.join(stagingDirectory, output), transfer);
  return verifyNativeExecutionTransfer(transfer, {
    directory: stagingDirectory,
  });
}

function verify(args, environment) {
  const directory = path.resolve(flag(args, "directory"));
  const transfer = verifyNativeExecutionTransfer(
    readJson(
      path.join(directory, flag(args, "transfer", "execution-transfer.json")),
      "execution transfer",
    ),
    {
      directory,
      expected: {
        "producer.workflowRunId": Number(environment.GITHUB_RUN_ID),
        "producer.workflowRunAttempt": Number(environment.GITHUB_RUN_ATTEMPT),
        "producer.job": flag(args, "native-job", "native-execution"),
        "runtime.resolvedSha": flag(args, "runtime-sha"),
        "runtime.selectionRoot": flag(args, "runtime-selection-root"),
        "warrant.pullRequestNumber": Number(flag(args, "pull-request")),
        "warrant.sourceHead": flag(args, "source-head"),
      },
    },
  );
  const jobs = readJson(flag(args, "jobs-readback"), "provider jobs readback");
  const pullRequestReadback = readJson(
    flag(args, "pull-request-readback"),
    "pull request readback",
  );
  const baseRefReadback = readJson(
    flag(args, "base-ref-readback"),
    "protected base ref readback",
  );
  const boundary = createProviderFinalizerBoundary({
    jobs,
    executionTransfer: transfer,
    workflowRunId: environment.GITHUB_RUN_ID,
    workflowRunAttempt: environment.GITHUB_RUN_ATTEMPT,
    nativeJobName: flag(
      args,
      "native-job-name",
      "Credentialless native execution",
    ),
    sealJobName: flag(
      args,
      "seal-job-name",
      "Credentialless native evidence seal",
    ),
    finalizerJobName: flag(
      args,
      "finalizer-job-name",
      "Credentialed provider finalizer",
    ),
    finalizerRunnerName: environment.RUNNER_NAME,
    finalizerRunnerEnvironment: environment.BUILDCHAIN_RUNNER_ENVIRONMENT,
    pullRequestReadback,
    baseRefReadback,
    observedAt: new Date().toISOString(),
  });
  const boundaryOutput = flag(args, "output");
  writeJson(boundaryOutput, boundary);
  if (transfer.outcome === "failed") {
    const settlement = verifyProviderFailureSettlementBinding(
      boundary,
      transfer,
    );
    writeJson(
      flag(
        args,
        "failure-settlement-output",
        path.join(
          path.dirname(boundaryOutput),
          "provider-failure-settlement.json",
        ),
      ),
      settlement,
    );
  }
  return boundary;
}

export function runDevDeliveryProcessBoundary(args, environment = process.env) {
  const command = args[0];
  if (command === "record-native")
    return recordNative(args.slice(1), environment);
  if (command === "seal") return seal(args.slice(1), environment);
  if (command === "verify") return verify(args.slice(1), environment);
  throw new Error("expected record-native, seal, or verify");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = runDevDeliveryProcessBoundary(process.argv.slice(2));
    process.stdout.write(
      `Dev delivery process boundary: ${result.transferRoot || result.boundaryRoot}\n`,
    );
  } catch (error) {
    console.error(`buildchain dev boundary: ${error.message}`);
    process.exit(1);
  }
}

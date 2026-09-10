#!/usr/bin/env node
import path from "node:path";
import { readJson } from "../native/files.js";
import { recordNativeJobContext } from "../native/context-record.js";
import { sealNativeExecution } from "../native/transfer.js";
import { verifyNativeProviderBoundary } from "../native/provider-boundary.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

export function runDevDeliveryProcessBoundary(args, environment = process.env) {
  const flagValue = (name, fallback) => flag(args.slice(1), name, fallback);
  const run = {
    id: Number(environment.GITHUB_RUN_ID),
    attempt: Number(environment.GITHUB_RUN_ATTEMPT),
  };
  const runner = {
    name: environment.RUNNER_NAME,
    environment: environment.BUILDCHAIN_RUNNER_ENVIRONMENT,
    os: environment.RUNNER_OS,
    arch: environment.RUNNER_ARCH,
  };
  if (args[0] === "record-native")
    return recordNativeJobContext({
      output: flagValue("output"),
      outcome: flagValue("outcome"),
      job: flagValue("job", "native-execution"),
      run,
      runner,
    });
  if (args[0] === "seal") {
    if (
      flagValue("output", "execution-transfer.json") !==
      "execution-transfer.json"
    )
      throw new Error(
        "native transfer manifest must be execution-transfer.json",
      );
    return sealNativeExecution({
      directory: flagValue("directory"),
      stagingDirectory: flagValue("staging-directory"),
      runtimeSelectionRoot: flagValue("runtime-selection-root"),
      sealJob: flagValue("seal-job", "seal-native-execution"),
      runner,
    });
  }
  if (args[0] === "verify")
    return verifyNativeProviderBoundary({
      directory: flagValue("directory"),
      runtimeSha: flagValue("runtime-sha"),
      runtimeSelectionRoot: flagValue("runtime-selection-root"),
      pullRequestNumber: Number(flagValue("pull-request")),
      sourceHead: flagValue("source-head"),
      run,
      runner,
      jobs: readJson(flagValue("jobs-readback"), "provider jobs readback"),
      pullRequestReadback: readJson(
        flagValue("pull-request-readback"),
        "pull request readback",
      ),
      baseRefReadback: readJson(
        flagValue("base-ref-readback"),
        "protected base ref readback",
      ),
      output: flagValue("output"),
      nativeJob: flagValue("native-job", "native-execution"),
      nativeJobName: flagValue(
        "native-job-name",
        "Credentialless native execution",
      ),
      sealJobName: flagValue(
        "seal-job-name",
        "Credentialless native evidence seal",
      ),
      finalizerJobName: flagValue(
        "finalizer-job-name",
        "Credentialed provider finalizer",
      ),
    });
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

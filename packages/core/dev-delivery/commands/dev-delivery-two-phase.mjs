#!/usr/bin/env node
import path from "node:path";
import { exactSha, jsonList } from "../warrant/values.js";
import { writeJson } from "../native/files.js";
import { runTwoPhaseDelivery } from "../native/qualification.js";
function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function positiveInteger(value, label, fallback = 0) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function cliOptions(args, environment = process.env) {
  const leaseSeconds = positiveInteger(
    flag(
      args,
      "lease-seconds",
      environment.BUILDCHAIN_DEV_DELIVERY_LEASE_SECONDS,
    ),
    "leaseSeconds",
    3600,
  );
  const heartbeatSeconds = positiveInteger(
    flag(
      args,
      "heartbeat-seconds",
      environment.BUILDCHAIN_DEV_DELIVERY_HEARTBEAT_SECONDS,
    ),
    "heartbeatSeconds",
    Math.max(15, Math.floor(leaseSeconds / 3)),
  );
  if (heartbeatSeconds >= leaseSeconds) {
    throw new Error("heartbeatSeconds must be less than leaseSeconds");
  }
  const nativeOnly = args.includes("--native-only");
  const finalizeOnly = args.includes("--finalize-only");
  if (nativeOnly && finalizeOnly)
    throw new Error("native-only and finalize-only are mutually exclusive");
  return {
    repository: flag(args, "repository", environment.GITHUB_REPOSITORY),
    branch: flag(
      args,
      "branch",
      environment.BUILDCHAIN_DEV_DELIVERY_BRANCH || environment.GITHUB_BASE_REF,
    ),
    pullRequestNumber: positiveInteger(
      flag(args, "pull-request", environment.BUILDCHAIN_DEV_DELIVERY_PR_NUMBER),
      "pullRequestNumber",
    ),
    expectedHead: exactSha(
      flag(
        args,
        "expected-head",
        environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD,
      ),
      "expectedHead",
    ),
    sourceIdentityRoot: flag(
      args,
      "source-identity-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_IDENTITY_ROOT,
    ),
    sourcePatchRoot: flag(
      args,
      "source-patch-root",
      environment.BUILDCHAIN_DEV_DELIVERY_SOURCE_PATCH_ROOT,
    ),
    planRoot: flag(
      args,
      "plan-root",
      environment.BUILDCHAIN_DEV_DELIVERY_PLAN_ROOT,
    ),
    closureRoot: flag(
      args,
      "closure-root",
      environment.BUILDCHAIN_DEV_DELIVERY_CLOSURE_ROOT,
    ),
    dependencyRoot: flag(
      args,
      "dependency-root",
      environment.BUILDCHAIN_DEV_DELIVERY_DEPENDENCY_ROOT,
    ),
    toolchainRoot: flag(
      args,
      "toolchain-root",
      environment.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT,
    ),
    environmentRoot: flag(
      args,
      "environment-root",
      environment.BUILDCHAIN_DEV_DELIVERY_ENVIRONMENT_ROOT,
    ),
    affectedPaths: jsonList(
      flag(
        args,
        "affected-paths-json",
        environment.BUILDCHAIN_DEV_DELIVERY_AFFECTED_PATHS,
      ),
      "affectedPaths",
    ),
    shardEvidenceRoots: jsonList(
      flag(
        args,
        "shard-evidence-roots-json",
        environment.BUILDCHAIN_DEV_DELIVERY_SHARD_EVIDENCE_ROOTS,
      ),
      "shardEvidenceRoots",
    ),
    nativeCommand: flag(
      args,
      "native-command",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND,
    ),
    nativeProofPath: flag(
      args,
      "native-proof",
      environment.BUILDCHAIN_DEV_DELIVERY_NATIVE_PROOF,
    ),
    warrantResultPath: flag(
      args,
      "warrant-result",
      environment.BUILDCHAIN_DEV_DELIVERY_WARRANT_RESULT,
    ),
    candidateDirectory: path.resolve(
      flag(args, "candidate-directory", ".buildchain/candidate"),
    ),
    evidenceDirectory: path.resolve(
      flag(args, "evidence-directory", ".buildchain/dev-delivery"),
    ),
    leaseSeconds,
    heartbeatSeconds,
    token: environment.GITHUB_TOKEN,
    apiUrl: environment.GITHUB_API_URL || "https://api.github.com",
    wakeEventType: flag(
      args,
      "wake-event-type",
      environment.BUILDCHAIN_DEV_DELIVERY_WAKE_EVENT_TYPE ||
        "buildchain-dev-delivery-wake",
    ),
    nativeOnly,
    finalizeOnly,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    process.stdout.write(
      "Usage: buildchain dev two-phase --repository owner/repo --branch dev/vN/vN.M --pull-request N --expected-head SHA --warrant-result FILE [--native-only|--finalize-only] [--native-proof FILE] [--native-command COMMAND]\n",
    );
    return;
  }
  const options = cliOptions(args);
  const result = await runTwoPhaseDelivery(options);
  writeJson(
    path.join(
      options.evidenceDirectory,
      options.nativeOnly
        ? "two-phase-native-result.json"
        : "two-phase-result.json",
    ),
    result,
  );
  process.stdout.write(
    `Two-phase Delivery Warrant: ${result.qualificationReceiptRoot}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev two-phase: ${error.message}`);
    process.exit(1);
  });
}

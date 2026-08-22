#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { devDeliveryContentRoot } from "../packages/core/dev-delivery-warrant.js";
import { runNativeWithHeartbeat } from "./dev-delivery-native-run.mjs";
import {
  attributedGitHubBaseDelta,
  classifyNativeProofAgainstCurrent,
  GitHubTwoPhaseClient,
  LocalTwoPhaseClient,
  replayQualifiedNativeWarrant,
  runNativeQualificationAttempt,
} from "./dev-delivery-two-phase-resume.mjs";
import { runDevDeliveryCommand } from "./dev-delivery-warrant.mjs";

export { GitHubTwoPhaseClient };

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

function jsonList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (cause) {
    throw new Error(`${label} must be a JSON array: ${cause.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(`${label} must be an exact lowercase Git SHA`);
  }
  return normalized;
}

function exactRoot(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a sha256 content root`);
  }
  return normalized;
}

function readJson(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function composeCandidate(candidateDirectory, expectedHead, baseSha) {
  try {
    execFileSync("git", ["-C", candidateDirectory, "merge", "--abort"], {
      stdio: "ignore",
    });
  } catch {
    // No merge was active.
  }
  execFileSync(
    "git",
    ["-C", candidateDirectory, "reset", "--hard", expectedHead],
    {
      stdio: "ignore",
    },
  );
  execFileSync(
    "git",
    ["-C", candidateDirectory, "merge", "--no-commit", "--no-ff", baseSha],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_COMMITTER_NAME: "Buildchain Delivery Warrant",
        GIT_COMMITTER_EMAIL:
          "buildchain-delivery-warrant@users.noreply.github.com",
      },
    },
  );
}

async function releaseFailedAttempt({
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

function retainedWarrantStateRoot(warrantResult) {
  return warrantResult.observation?.stateRoot || warrantResult.after?.stateRoot;
}

export async function runTwoPhaseDelivery(options, dependencies = {}) {
  options.environmentRoot = exactRoot(
    options.environmentRoot,
    "environmentRoot",
  );
  const client =
    dependencies.client ||
    (options.nativeOnly
      ? new LocalTwoPhaseClient(options)
      : new GitHubTwoPhaseClient(options));
  const runNative = dependencies.runNative || runNativeWithHeartbeat;
  const warrantResult = readJson(options.warrantResultPath, "Warrant result");
  const warrant =
    warrantResult.observation?.activeWarrant || warrantResult.warrant;
  if (!warrant || !["provisional", "qualified"].includes(warrant.phase)) {
    throw new Error(
      "two-phase delivery requires an active provisional or qualified Warrant",
    );
  }
  if (
    Number(warrant.pullRequestNumber) !== options.pullRequestNumber ||
    warrant.sourceHead !== options.expectedHead
  ) {
    throw new Error("provisional Warrant does not match the exact PR head");
  }
  const runCommand =
    dependencies.runCommand ||
    (options.nativeOnly
      ? async ({ command }) => {
          if (command !== "heartbeat")
            throw new Error(
              "credentialless native phase cannot mutate provider state",
            );
          return {
            action: "immutable-admission-binding",
            fencingToken: warrant.fencingToken,
            leaseGeneration: warrant.generation,
          };
        }
      : runDevDeliveryCommand);
  for (const field of [
    "sourceIdentityRoot",
    "sourcePatchRoot",
    "planRoot",
    "closureRoot",
    "dependencyRoot",
    "toolchainRoot",
    "environmentRoot",
  ]) {
    if (warrant[field] !== options[field]) {
      throw new Error(`provisional Warrant ${field} does not match execution`);
    }
  }
  if (
    JSON.stringify([...(warrant.affectedPaths || [])].sort()) !==
      JSON.stringify([...options.affectedPaths].sort()) ||
    JSON.stringify([...(warrant.shardEvidenceRoots || [])].sort()) !==
      JSON.stringify([...options.shardEvidenceRoots].sort())
  ) {
    throw new Error(
      "provisional Warrant candidate evidence roots do not match execution",
    );
  }
  if (
    !warrant.nativeCommandContract ||
    warrant.nativeCommandContract.command !== options.nativeCommand
  ) {
    throw new Error(
      "provisional Warrant native command contract does not match execution",
    );
  }
  options.nativeCommandRoot = warrant.nativeCommandContract.commandRoot;
  const evidenceDirectory = path.resolve(options.evidenceDirectory);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const qualifiedReplay = await replayQualifiedNativeWarrant({
    warrant,
    pullRequestNumber: options.pullRequestNumber,
    expectedHead: options.expectedHead,
    exactPullRequestHead: (...args) => client.exactPullRequestHead(...args),
  });
  if (qualifiedReplay) return qualifiedReplay;
  let proof = options.nativeProofPath
    ? readJson(options.nativeProofPath, "native proof")
    : null;
  let classified = proof
    ? await classifyNativeProofAgainstCurrent(proof, options, client)
    : null;
  let nativeAttempts = 0;
  try {
    while (true) {
      if (classified?.decision.reusable) {
        await client.exactPullRequestHead(
          options.pullRequestNumber,
          options.expectedHead,
        );
        classified = await classifyNativeProofAgainstCurrent(
          proof,
          options,
          client,
        );
        if (classified.decision.reusable) break;
      }
      if (options.finalizeOnly) break;
      if (nativeAttempts >= 2) break;
      if (!String(options.nativeCommand || "").trim()) {
        throw new Error(
          `native proof cannot be reused (${classified?.decision.reason || "not-supplied"}) and native-command is empty`,
        );
      }
      nativeAttempts += 1;
      proof = await runNativeQualificationAttempt({
        options,
        warrant,
        attempt: nativeAttempts,
        client,
        runCommand,
        runNative,
        composeCandidate: dependencies.composeCandidate || composeCandidate,
        writeEvidence: (name, value) =>
          writeJson(path.join(evidenceDirectory, name), value),
      });
      classified = await classifyNativeProofAgainstCurrent(
        proof,
        options,
        client,
      );
    }

    if (!classified?.decision.reusable) {
      throw new Error(
        `native proof remains non-reusable after ${nativeAttempts} attempt(s): ${classified?.decision.reason || "unknown"}`,
      );
    }
    writeJson(path.join(evidenceDirectory, "native-proof.json"), proof);
    writeJson(
      path.join(evidenceDirectory, "native-reuse-decision.json"),
      classified.decision,
    );
    if (options.nativeOnly) {
      return {
        schema: "kungfu.buildchain.two-phase-delivery-result/v1",
        ok: true,
        outcome: "native-proof-ready",
        nativeAttempts,
        nativeProofRoot: proof.proofRoot,
        nativeReuseDecisionRoot: classified.decision.decisionRoot,
        qualificationReceiptRoot: null,
        landingAuthority: false,
        qualifiedWarrant: warrant,
      };
    }
    const qualified = await runCommand({
      command: "qualify",
      repository: options.repository,
      branch: options.branch,
      fencingToken: warrant.fencingToken,
      leaseGeneration: warrant.generation,
      nativeProofPath: path.join(evidenceDirectory, "native-proof.json"),
      nativeReuseDecisionPath: path.join(
        evidenceDirectory,
        "native-reuse-decision.json",
      ),
      currentBase: classified.current.currentBase,
      graphKnown: classified.current.graphKnown,
      attributionComplete: classified.current.attributionComplete,
      changedPaths: JSON.stringify(classified.current.changedPaths),
      renames: JSON.stringify(classified.current.renames),
      execute: true,
      token: options.token,
      apiUrl: options.apiUrl,
    });
    writeJson(
      path.join(evidenceDirectory, "qualified-warrant.json"),
      qualified,
    );
    return {
      schema: "kungfu.buildchain.two-phase-delivery-result/v1",
      ok: true,
      outcome: "qualified-warrant",
      nativeAttempts,
      nativeProofRoot: proof.proofRoot,
      nativeReuseDecisionRoot: classified.decision.decisionRoot,
      qualificationReceiptRoot: qualified.receiptRoot,
      landingAuthority: false,
      qualifiedWarrant: qualified.observation.activeWarrant,
    };
  } catch (error) {
    await releaseFailedAttempt({
      error,
      options,
      warrant,
      warrantStateRoot: retainedWarrantStateRoot(warrantResult),
      nativeAttempts,
      evidenceDirectory,
      runCommand,
      client,
    });
    throw error;
  }
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

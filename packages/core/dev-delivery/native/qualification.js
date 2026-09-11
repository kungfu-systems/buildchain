import fs from "node:fs";
import path from "node:path";
import { exactRoot } from "../warrant/values.js";
import { readJson, writeJson } from "./files.js";
import { composeCandidate, LocalTwoPhaseClient } from "./candidate.js";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import { runNativeWithHeartbeat } from "./execution.js";
import {
  replayQualifiedNativeWarrant,
  classifyNativeProofAgainstCurrent,
} from "./reuse.js";
import { runNativeQualificationAttempt } from "./attempt.js";
import { releaseFailedAttempt } from "./failure.js";
import { runDevDeliveryCommand } from "../warrant/service.js";
function retainedWarrantStateRoot(warrantResult) {
  return warrantResult.observation?.stateRoot || warrantResult.after?.stateRoot;
}

function bindNativeWarrantExecution(warrant, options) {
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
}

function admittedNativeWarrant(warrantResult, options) {
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

  return warrant;
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
  const warrant = admittedNativeWarrant(warrantResult, options);
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
  bindNativeWarrantExecution(warrant, options);
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

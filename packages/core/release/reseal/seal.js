import path from "node:path";
import { normalizeTailResealRequest } from "../tail-reseal.js";
import { createTailResealReceipt } from "../tail-reseal-receipt.js";
import { aggregateBuildSummary } from "../../build/summary/artifacts.js";
import { writeReleaseCandidatePassport } from "../../publication/candidate/passport.js";
import { readJson, writeJson } from "./files.js";
import { collectReadbacks } from "./readbacks.js";
import { verifyTailPolicyBindings } from "./admission.js";
export function publicationLine(version) {
  const match = /^(\d+)\.(\d+)\.\d+-alpha\.\d+$/u.exec(version || "");
  if (!match)
    throw new Error("Tail reseal requires an exact alpha publication version");
  return `alpha/v${match[1]}/v${match[1]}.${match[2]}`;
}
export function sealTailReseal({
  workspace,
  runtimeSha,
  sourceSha,
  sourceRef,
  repository,
  workflow,
  run,
}) {
  const directory = path.join(workspace, ".buildchain/tail-reseal");
  const request = normalizeTailResealRequest(
    readJson(path.join(directory, "request.json")),
  );
  const consumerPolicy = readJson(
    path.join(directory, "consumer-policy-receipt.json"),
  );
  verifyTailPolicyBindings({
    request,
    receipt: consumerPolicy,
    runtimeSha,
    sourceSha,
  });
  if (repository !== request.repository)
    throw new Error("Tail seal repository differs from admitted request");
  const plan = readJson(path.join(directory, "plan.json"));
  const summary = aggregateBuildSummary({
    inputRoot: path.join(directory, "platforms"),
    outputPath: path.join(directory, "build-summary.json"),
    artifactName: "v4-tail-reseal",
    expectedPlatformCount: 4,
    additionalPlatformCount: 0,
    platforms: request.platforms,
    additionalPlatforms: [],
    git: {
      repository,
      sha: sourceSha,
      treeSha: request.source.treeSha,
      ref: sourceRef,
      runId: run.id,
      runAttempt: run.attempt,
    },
    publishGate: {
      trustedEvent: true,
      channel: "alpha",
      allowed: true,
      reason: "exact-v4-tail-reseal",
    },
    publishSource: {
      ref: "",
      sha: sourceSha,
      locked: true,
      channel: "alpha",
      line: publicationLine(request.target.version),
      consumerVersion: request.target.version,
      releaseManifest: "",
    },
    runtime: {
      workflowShellRef: "v4-alpha",
      requestedRef: "",
      ref: "v4-alpha",
      sha: runtimeSha,
      class: "alpha",
      override: false,
      trustDecision: "",
      rollbackRef: "",
    },
  });
  const { passport } = writeReleaseCandidatePassport({
    outputPath: path.join(directory, "release-candidate-passport.json"),
    coordinatesPath: path.join(
      workspace,
      ".buildchain/artifacts/artifact-coordinates.json",
    ),
    workspace,
    request: {
      repository,
      targetChannel: "alpha",
      version: request.target.version,
      sourceHeadSha: sourceSha,
      mergeRefSha: sourceSha,
      sourceTreeHash: request.source.treeSha,
      buildSummary: summary,
      buildchain: {
        ref: "v4-alpha",
        sha: runtimeSha,
        workflowShellRef: "v4-alpha",
      },
      consumerPolicyReceipt: {
        receipt: consumerPolicy,
        receiptRoot: request.runtime.consumerPolicyReceiptRoot,
      },
      workflow: {
        name: workflow,
        runId: run.id,
        runAttempt: run.attempt,
        url: "",
      },
      pullRequest: { number: "", url: "", headRef: "", baseRef: "" },
    },
  });
  const receipt = createTailResealReceipt({
    request,
    plan,
    readbacks: collectReadbacks(path.join(directory, "platforms")),
    passport,
    protectedReadbackRoot: request.warrant.stateReadbackRoot,
    currentRun: { id: Number(run.id), attempt: Number(run.attempt) },
  });
  writeJson(path.join(directory, "receipt.json"), receipt);
  return { passport, receipt };
}

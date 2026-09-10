import path from "node:path";
import { getOctokit } from "@actions/github";
import { command } from "../../runtime/action-process.mjs";
import { installationRoot } from "../../runtime/installation-root.js";
import { exactWorkflowRuntime } from "../../runtime/workflow-runtime.js";
import { admitTailResealPlan } from "./plan.js";
import { finalizeResealPlatform } from "./finalize-platform.js";
import { sealTailReseal } from "./seal.js";
import { tailPlanOutputs } from "./outputs.js";
function runtime(core) {
  const sha = exactWorkflowRuntime(
    core.getInput("runtime-sha", { required: true }),
  );
  if (
    command(
      "git",
      ["-C", installationRoot(import.meta.url), "rev-parse", "HEAD"],
      { stdio: "pipe" },
    ).trim() !== sha
  )
    throw new Error(
      "Tail action runtime differs from admitted immutable commit",
    );
  return sha;
}
export async function admitTailResealPlanAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const result = await admitTailResealPlan(
    {
      request: JSON.parse(request["request-json"]),
      receipt: JSON.parse(request["consumer-policy-receipt-json"]),
      workspace: path.resolve(env.GITHUB_WORKSPACE),
      runtimeSha: runtime(core),
      sourceSha: env.GITHUB_SHA,
      repository: env.GITHUB_REPOSITORY,
    },
    getOctokit(core.getInput("token", { required: true })),
  );
  for (const [name, value] of Object.entries(
    tailPlanOutputs(
      result.request,
      result.plan,
      ".buildchain/tail-reseal/plan.json",
    ),
  ))
    core.setOutput(name, value);
  core.setOutput("admission-root", result.admission.admissionRoot);
}
export function finalizeResealPlatformAction(core, env) {
  return finalizeResealPlatform({
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeSha: runtime(core),
    platformId: core.getInput("platform", { required: true }),
    finalizationCommand: core.getInput("finalization-command"),
    signingToken: core.getInput("signing-token"),
    environment: Object.fromEntries(
      Object.entries(env).filter(([key]) => !key.startsWith("INPUT_")),
    ),
  });
}
export function sealTailResealAction(core, env) {
  const { passport, receipt } = sealTailReseal({
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    runtimeSha: runtime(core),
    sourceSha: env.GITHUB_SHA,
    sourceRef: env.GITHUB_REF,
    repository: env.GITHUB_REPOSITORY,
    workflow: env.GITHUB_WORKFLOW,
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
  });
  core.setOutput("receipt-root", receipt.receiptRoot);
  core.setOutput("release-candidate-passport-json", {
    contract: passport.contract,
    repository: passport.repository,
    target: passport.target,
    source: passport.source,
    candidateHash: passport.candidateHash,
    platformCount: passport.platformMatrix.length,
    gateProfileEvidence: passport.gateProfileEvidence,
    familyEvidence: passport.familyEvidence,
    consumerPolicy: passport.consumerPolicy,
    controllerReceipts: passport.controllerReceipts || [],
  });
}

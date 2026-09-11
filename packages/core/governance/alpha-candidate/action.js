import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { normalizeDevAlphaPatrolOptions } from "./options.js";
import { runDevAlphaCandidatePatrol } from "./controller.js";
import { createGitHubChannelCandidateClient } from "./provider.js";
import { alphaCandidateOutputs } from "./outputs.js";
import { markdown } from "./report.js";
export async function reconcileAlphaCandidateAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  if (
    request["pull-request-body-prefix"] &&
    request["pull-request-body-prefix-renderer"]
  )
    throw new Error(
      "pull-request-body-prefix and pull-request-body-prefix-renderer are mutually exclusive",
    );
  const settle = core.getBooleanInput("settlement-authorized");
  const prior = settle
    ? JSON.parse(core.getInput("observation-json", { required: true }))
    : {};
  const runtimeSha = env.BUILDCHAIN_RUNTIME_SHA;
  if (
    settle &&
    [
      "selected-sha",
      "prior-state-root",
      "cut-root",
      "cut-created-at",
      "observed-at",
    ].some((key) => !prior[key])
  )
    throw new Error(
      "Alpha settlement requires the complete prior observation binding",
    );
  const options = normalizeDevAlphaPatrolOptions({
    repository: env.GITHUB_REPOSITORY,
    sourceBranch: request["source-branch"],
    targetBranch: request["target-branch"],
    devWorkflowPath: request["dev-workflow-path"],
    alphaWorkflowPath: request["alpha-workflow-path"],
    maxAgeSeconds: request["max-age-seconds"],
    requireActiveReleaseTrain: true,
    buildchainRuntimeSha: runtimeSha,
    pullRequestBodyPrefix: settle
      ? core.getInput("pull-request-body-prefix")
      : request["pull-request-body-prefix"],
    expectedSelectedSha: prior["selected-sha"],
    expectedPriorStateRoot: prior["prior-state-root"],
    expectedCutRoot: prior["cut-root"],
    cutCreatedAt: prior["cut-created-at"],
    now: prior["observed-at"],
    reactivationAuthorized: settle && request["reactivation-authorized"],
    createPullRequest: settle,
    settlementAuthorized: settle,
    autoMerge: settle && request["auto-merge"],
    mergeMethod: request["merge-method"],
    dryRun: !settle,
    transitionAuthority: {
      actor: env.GITHUB_ACTOR,
      workflow: env.GITHUB_WORKFLOW,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    },
    outputPath: path.join(
      env.GITHUB_WORKSPACE,
      `.buildchain/patrol/dev-alpha-candidate${settle ? "-settlement" : ""}.json`,
    ),
  });
  const result = await runDevAlphaCandidatePatrol(
    options,
    createGitHubChannelCandidateClient({
      repository: options.repository,
      token: core.getInput("token", { required: true }),
    }),
  );
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, JSON.stringify(result, null, 2) + "\n");
  const values = {
    ...alphaCandidateOutputs(options, result),
    "runtime-sha": runtimeSha,
  };
  for (const [key, value] of Object.entries(values)) core.setOutput(key, value);
  core.setOutput("observation-json", JSON.stringify(values));
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown(result));
}

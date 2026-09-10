#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeDevAlphaPatrolOptions } from "../../governance/alpha-candidate/options.js";
import { runDevAlphaCandidatePatrol } from "../../governance/alpha-candidate/controller.js";
import { createGitHubChannelCandidateClient } from "../../governance/alpha-candidate/provider.js";
import { markdown } from "../../governance/alpha-candidate/report.js";
import { alphaCandidateOutputs } from "../../governance/alpha-candidate/outputs.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
async function main() {
  const env = process.env;
  const options = normalizeDevAlphaPatrolOptions({
    createPullRequest: env.BUILDCHAIN_CHANNEL_PATROL_CREATE_PR,
    repository: env.BUILDCHAIN_CHANNEL_PATROL_REPOSITORY,
    sourceBranch: env.BUILDCHAIN_CHANNEL_PATROL_SOURCE_BRANCH,
    targetBranch: env.BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH,
    devWorkflowPath: env.BUILDCHAIN_CHANNEL_PATROL_DEV_WORKFLOW,
    alphaWorkflowPath: env.BUILDCHAIN_CHANNEL_PATROL_ALPHA_WORKFLOW,
    maxAgeSeconds: env.BUILDCHAIN_CHANNEL_PATROL_MAX_AGE_SECONDS,
    pullRequestBodyPrefix: env.BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX,
    expectedSelectedSha: env.BUILDCHAIN_CHANNEL_PATROL_EXPECTED_SELECTED_SHA,
    expectedPriorStateRoot: env.BUILDCHAIN_CHANNEL_PATROL_EXPECTED_PRIOR_STATE_ROOT,
    expectedCutRoot: env.BUILDCHAIN_CHANNEL_PATROL_EXPECTED_CUT_ROOT,
    cutCreatedAt: env.BUILDCHAIN_CHANNEL_PATROL_CUT_CREATED_AT,
    requireActiveReleaseTrain: env.BUILDCHAIN_CHANNEL_PATROL_REQUIRE_ACTIVE_TRAIN,
    buildchainRuntimeSha: env.BUILDCHAIN_CHANNEL_PATROL_RUNTIME_SHA,
    reactivationAuthorized: env.BUILDCHAIN_CHANNEL_PATROL_REACTIVATION_AUTHORIZED,
    settlementAuthorized: env.BUILDCHAIN_CHANNEL_PATROL_SETTLEMENT_AUTHORIZED,
    autoMerge: env.BUILDCHAIN_CHANNEL_PATROL_AUTO_MERGE,
    mergeMethod: env.BUILDCHAIN_CHANNEL_PATROL_MERGE_METHOD,
    dryRun: env.BUILDCHAIN_CHANNEL_PATROL_DRY_RUN,
    now: env.BUILDCHAIN_CHANNEL_PATROL_NOW,
    outputPath: env.BUILDCHAIN_CHANNEL_PATROL_OUTPUT_PATH,
    transitionAuthority: { actor: env.GITHUB_ACTOR, workflow: env.GITHUB_WORKFLOW, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT },
  });
  const result = await runDevAlphaCandidatePatrol(options, createGitHubChannelCandidateClient({ repository: options.repository, token: env.GITHUB_TOKEN }));
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true }); fs.writeFileSync(options.outputPath, JSON.stringify(result, null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown(result)); else process.stdout.write(markdown(result));
  writeGitHubOutputs(alphaCandidateOutputs(options, result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

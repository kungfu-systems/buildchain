#!/usr/bin/env node
import fs from "node:fs";
import { GitHubHousekeeperClient } from "../engineering-housekeeper-github.js";
import { runHousekeepingTransaction } from "../housekeeping/execution.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";

async function main(env = process.env) {
  const operation = process.argv[2];
  const scope = operation === "plan" ? "plan" : operation === "apply" ? process.argv[3] : "";
  const options = {
    mode: env.HOUSEKEEPER_MODE, applyEnabled: env.HOUSEKEEPER_APPLY_ENABLED,
    repository: env.HOUSEKEEPER_REPOSITORY || env.GITHUB_REPOSITORY, targetBranch: env.HOUSEKEEPER_TARGET_BRANCH,
    staleDays: env.HOUSEKEEPER_STALE_DAYS, maxActions: env.HOUSEKEEPER_MAX_ACTIONS,
    protectedPatterns: env.HOUSEKEEPER_PROTECTED_PATTERNS, retainedPatterns: env.HOUSEKEEPER_RETAINED_PATTERNS,
    temporaryBranchPatterns: env.HOUSEKEEPER_TEMPORARY_BRANCH_PATTERNS, stalePullRequestLabel: env.HOUSEKEEPER_STALE_PR_LABEL,
    observedAt: env.HOUSEKEEPER_OBSERVED_AT, appliedAt: env.HOUSEKEEPER_APPLIED_AT, outputDirectory: env.HOUSEKEEPER_OUTPUT_DIRECTORY,
  };
  const result = await runHousekeepingTransaction({options,scope,planPath:env.HOUSEKEEPER_PLAN_PATH},new GitHubHousekeeperClient({token:env.GITHUB_TOKEN}));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,result.report);
  else process.stdout.write(result.report);
  writeGitHubOutputs(result.outputs);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.stack || error.message); process.exitCode=1; });

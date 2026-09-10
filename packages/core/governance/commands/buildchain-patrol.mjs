#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { GitHubClient } from "../../dev-delivery/admission/github-client.js";
import { normalizePatrolOptions } from "../patrol/options.js";
import { reconcileRepositoryPatrol } from "../patrol/transaction.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
async function main() {
  const env = process.env;
  const options = normalizePatrolOptions({
    repository: env.BUILDCHAIN_PATROL_REPOSITORY || env.GITHUB_REPOSITORY,
    targetBranch: env.BUILDCHAIN_PATROL_TARGET_BRANCH || env.GITHUB_REF_NAME,
    cadence: env.BUILDCHAIN_PATROL_CADENCE,
    mode: env.BUILDCHAIN_PATROL_MODE,
    capabilities: env.BUILDCHAIN_PATROL_CAPABILITIES,
    requiredChecks: env.BUILDCHAIN_PATROL_REQUIRED_CHECKS,
    readyLabel: env.BUILDCHAIN_PATROL_READY_LABEL,
    blockLabels: env.BUILDCHAIN_PATROL_BLOCK_LABELS,
    allowedHeadPrefixes: env.BUILDCHAIN_PATROL_ALLOWED_HEAD_PREFIXES,
    requireApproval: env.BUILDCHAIN_PATROL_REQUIRE_APPROVAL,
    sameRepositoryOnly: env.BUILDCHAIN_PATROL_SAME_REPOSITORY_ONLY,
    maxActions: env.BUILDCHAIN_PATROL_MAX_ACTIONS,
    mergeMethod: env.BUILDCHAIN_PATROL_MERGE_METHOD,
    landingMode: env.BUILDCHAIN_PATROL_LANDING_MODE,
    dryRun: env.BUILDCHAIN_PATROL_DRY_RUN,
    outputPath: env.BUILDCHAIN_PATROL_OUTPUT_PATH,
  });
  const [owner, repo] = options.repository.split("/");
  const client = options.capabilities.includes("merge-ready-dev-prs") ? new GitHubClient({ repository: { owner, repo, fullName: options.repository }, token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL }) : undefined;
  const { outputs } = await reconcileRepositoryPatrol({ options, summaryPath: env.GITHUB_STEP_SUMMARY }, client);
  writeGitHubOutputs(outputs);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

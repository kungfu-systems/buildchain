#!/usr/bin/env node
import fs from "node:fs";import path from "node:path";
import { normalizeStableCandidatePatrolOptions } from "../stable-patrol/options.js";
import { runStableCandidatePatrol } from "../stable-patrol/controller.js";
import { createGitHubStableCandidateClient } from "../stable-patrol/github-client.js";
import { renderStablePatrolSummary, stablePatrolOutputs } from "../stable-patrol/report.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
async function main(env=process.env) {
 const options=normalizeStableCandidatePatrolOptions({
  repository:env.BUILDCHAIN_STABLE_PATROL_REPOSITORY || env.GITHUB_REPOSITORY,
  targetBranch:env.BUILDCHAIN_STABLE_PATROL_TARGET_BRANCH,
  ledgerRef:env.BUILDCHAIN_STABLE_PATROL_LEDGER_REF,
  minimumSoakSeconds:env.BUILDCHAIN_STABLE_PATROL_MINIMUM_SOAK_SECONDS,
  requiredChecks:env.BUILDCHAIN_STABLE_PATROL_REQUIRED_CHECKS,
  revokedVersions:env.BUILDCHAIN_STABLE_PATROL_REVOKED_VERSIONS,
  revokeReason:env.BUILDCHAIN_STABLE_PATROL_REVOKE_REASON,
  hold:env.BUILDCHAIN_STABLE_PATROL_HOLD,
  holdReason:env.BUILDCHAIN_STABLE_PATROL_HOLD_REASON,
  releaseNow:env.BUILDCHAIN_STABLE_PATROL_RELEASE_NOW,
  autoPromote:env.BUILDCHAIN_STABLE_PATROL_AUTO_PROMOTE,
  autoMerge:env.BUILDCHAIN_STABLE_PATROL_AUTO_MERGE,
  mergeMethod:env.BUILDCHAIN_STABLE_PATROL_MERGE_METHOD,
  dryRun:env.BUILDCHAIN_STABLE_PATROL_DRY_RUN,
  now:env.BUILDCHAIN_STABLE_PATROL_NOW,
  outputPath:env.BUILDCHAIN_STABLE_PATROL_OUTPUT_PATH});
 const result=await runStableCandidatePatrol(options,createGitHubStableCandidateClient({repository:options.repository,token:env.GITHUB_TOKEN}));
 fs.mkdirSync(path.dirname(options.outputPath),{recursive:true});fs.writeFileSync(options.outputPath,JSON.stringify(result,null,2)+"\n");
 const summary=renderStablePatrolSummary(result);if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,summary);else process.stdout.write(summary);
 writeGitHubOutputs(stablePatrolOutputs(result,options.outputPath));
}
if(import.meta.url === `file://${process.argv[1]}`)main().catch(error=>{console.error(error.stack || error.message);process.exitCode=1;});

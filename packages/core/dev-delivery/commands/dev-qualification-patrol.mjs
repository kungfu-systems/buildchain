#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runDevQualificationPatrol } from "../qualification/controller.js";
import { normalizeDevQualificationOptions } from "../qualification/model.js";
import { createGitHubDevQualificationClient } from "../qualification/github-client.js";
import { renderDevQualificationSummary, devQualificationOutputs } from "../qualification/report.js";
import { writeGitHubOutputs } from "../../providers/commands/github-output.mjs";
async function main(env = process.env) {
 const options=normalizeDevQualificationOptions({repository:env.BUILDCHAIN_DEV_QUALIFICATION_REPOSITORY || env.GITHUB_REPOSITORY,
 sourceBranch:env.BUILDCHAIN_DEV_QUALIFICATION_SOURCE_BRANCH,devWorkflowPath:env.BUILDCHAIN_DEV_QUALIFICATION_WORKFLOW,
 preflightWorkflowPath:env.BUILDCHAIN_DEV_QUALIFICATION_PREFLIGHT_WORKFLOW,priorityWorkflowPaths:env.BUILDCHAIN_DEV_QUALIFICATION_PRIORITY_WORKFLOWS,
 dispatchInputs:env.BUILDCHAIN_DEV_QUALIFICATION_DISPATCH_INPUTS,maxAttempts:env.BUILDCHAIN_DEV_QUALIFICATION_MAX_ATTEMPTS,
 mutationAuthorized:env.BUILDCHAIN_DEV_QUALIFICATION_MUTATION_AUTHORIZED,expectedAction:env.BUILDCHAIN_DEV_QUALIFICATION_EXPECTED_ACTION,
 expectedSourceSha:env.BUILDCHAIN_DEV_QUALIFICATION_EXPECTED_SOURCE_SHA,outputPath:env.BUILDCHAIN_DEV_QUALIFICATION_OUTPUT_PATH,now:env.BUILDCHAIN_DEV_QUALIFICATION_NOW});
 const result=await runDevQualificationPatrol(options,createGitHubDevQualificationClient({repository:options.repository,token:env.GITHUB_TOKEN}));
 fs.mkdirSync(path.dirname(options.outputPath),{recursive:true});fs.writeFileSync(options.outputPath,JSON.stringify(result,null,2)+"\n");
 const summary=renderDevQualificationSummary(result);if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,summary);else process.stdout.write(summary);
 writeGitHubOutputs(devQualificationOutputs(result,options.outputPath));
}
if(import.meta.url === `file://${process.argv[1]}`)main().catch(error=>{console.error(error.stack || error.message);process.exitCode=1;});

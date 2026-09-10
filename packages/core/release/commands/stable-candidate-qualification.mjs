#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { runStableCandidateQualification } from "../qualification/campaign.js";
import { createGitHubQualificationClient } from "../../providers/github/qualification.js";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 try {
 const result = await runStableCandidateQualification({
  repository: process.env.BUILDCHAIN_QUALIFICATION_REPOSITORY || process.env.GITHUB_REPOSITORY,
  candidateSha: process.env.BUILDCHAIN_QUALIFICATION_CANDIDATE_SHA,
  buildWorkflowFile: process.env.BUILDCHAIN_QUALIFICATION_BUILD_WORKFLOW_FILE,
  buildWorkflowName: process.env.BUILDCHAIN_QUALIFICATION_BUILD_WORKFLOW_NAME,
  canaryRepository: process.env.BUILDCHAIN_QUALIFICATION_CANARY_REPOSITORY,
  canaryWorkflowFile: process.env.BUILDCHAIN_QUALIFICATION_CANARY_WORKFLOW_FILE,
  canaryWorkflowName: process.env.BUILDCHAIN_QUALIFICATION_CANARY_WORKFLOW_NAME,
  canaryStatusContext: process.env.BUILDCHAIN_QUALIFICATION_CANARY_STATUS_CONTEXT,
  canaryRef: process.env.BUILDCHAIN_QUALIFICATION_CANARY_REF,
  canarySha: process.env.BUILDCHAIN_QUALIFICATION_CANARY_SHA,
  pollAttempts: process.env.BUILDCHAIN_QUALIFICATION_POLL_ATTEMPTS,
  pollIntervalMs: process.env.BUILDCHAIN_QUALIFICATION_POLL_INTERVAL_MS,
  dryRun: process.env.BUILDCHAIN_QUALIFICATION_DRY_RUN,
 }, createGitHubQualificationClient({ token: process.env.GITHUB_TOKEN, attestationToken: process.env.BUILDCHAIN_QUALIFICATION_ATTESTATION_TOKEN || process.env.GITHUB_TOKEN }));
 process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
 } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import fs from "node:fs";
import path from "node:path";
import { getOctokit } from "@actions/github";
import {
  getStableReleasePolicy,
  loadBuildchainConfig,
} from "../../consumer/buildchain-config.js";
import { stableReleaseCoordinates } from "./coordinates.js";
import { runStableCandidatePatrol } from "./controller.js";
import { createGitHubStableCandidateClient } from "./github-client.js";
import { renderStablePatrolSummary, stablePatrolOutputs } from "./report.js";

export async function reconcileStableCandidateAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const variables = JSON.parse(core.getInput("policy-json") || "{}");
  const line = stableReleaseCoordinates(
    request["target-branch"],
    env.GITHUB_REF_NAME,
  );
  const policy = getStableReleasePolicy(
    loadBuildchainConfig(path.join(env.GITHUB_WORKSPACE, ".buildchain/source")),
  );
  const outputPath = path.join(
    env.GITHUB_WORKSPACE,
    ".buildchain/patrol/stable-candidate.json",
  );
  const result = await runStableCandidatePatrol(
    {
      repository: env.GITHUB_REPOSITORY,
      targetBranch: line["target-branch"],
      ledgerRef: request["ledger-ref"] || policy.ledgerRef,
      minimumSoakSeconds:
        request["minimum-soak-seconds"] || policy.minimumSoakSeconds,
      requiredChecks:
        request["required-checks"] ||
        policy.requiredChecks.join(",") ||
        "alpha-release",
      revokedVersions:
        request["revoked-versions"] ||
        variables.BUILDCHAIN_STABLE_REVOKED_ALPHA_VERSIONS,
      revokeReason:
        request["revoke-reason"] || variables.BUILDCHAIN_STABLE_REVOKE_REASON,
      hold: request.hold || variables.BUILDCHAIN_STABLE_HOLD === "true",
      holdReason:
        request["hold-reason"] || variables.BUILDCHAIN_STABLE_HOLD_REASON,
      releaseNow: request["release-now"],
      autoPromote: request["auto-promote"] || policy.autoPromote,
      autoMerge: request["auto-merge"] || policy.autoMerge,
      mergeMethod: request["merge-method"],
      dryRun: request["dry-run"],
      outputPath,
    },
    createGitHubStableCandidateClient({
      repository: env.GITHUB_REPOSITORY,
      token: core.getInput("token", { required: true }),
    }),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      renderStablePatrolSummary(result),
    );
  for (const [key, value] of Object.entries(
    stablePatrolOutputs(result, outputPath),
  ))
    core.setOutput(key, value);
  core.setOutput("artifact-line", line["artifact-line"]);
  if (
    request["auto-approve"] === true &&
    request["dry-run"] === false &&
    result.promotion?.pullRequest?.html_url
  ) {
    const github = getOctokit(
      core.getInput("approval-token", { required: true }),
    );
    const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
    await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number: result.promotion.pullRequest.number,
      event: "APPROVE",
      body: "Approved by the repository-owned Buildchain Stable Candidate Patrol policy.",
    });
  }
}

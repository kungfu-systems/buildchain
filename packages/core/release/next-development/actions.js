import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installationRoot } from "../../runtime/installation-root.js";
import { createGitHubCliApi } from "../../providers/github-cli-api.js";
import { releaseAssetClient } from "../../providers/github/release-assets.js";
import { readBinaryPublicationEvidence } from "../../publication/binary/evidence.js";
import { verifyVersionStateDelta } from "../version-state/verification.js";
import { REPOSITORY } from "./review-policy.js";
import { verifyNextDevelopmentReview } from "./verification.js";
import { approveNextDevelopment } from "./approval.js";
import { enqueueVerifiedDevelopmentReview } from "./enqueue.js";
function coordinates(env) {
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    !/^[1-9][0-9]*$/.test(env.VERIFY_RUN_ID || "")
  )
    throw new Error("exact repository and verification run required");
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (fs.realpathSync(workspace) !== installationRoot(import.meta.url))
    throw new Error(
      "Next-development review must execute the protected source checkout",
    );
  return {
    repository: env.GITHUB_REPOSITORY,
    runId: env.VERIFY_RUN_ID,
    workspace,
    file: path.join(workspace, ".buildchain/next-development-review.json"),
  };
}
function persist(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
export async function qualifyNextDevelopmentAction(core, env) {
  if (env.BUILDCHAIN_APPROVAL_TOKEN)
    throw new Error("verification must not receive the approval credential");
  const { repository, runId, workspace, file } = coordinates(env),
    token = core.getInput("token", { required: true });
  const client = createGitHubCliApi(undefined, { ...env, GH_TOKEN: token });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git("rev-parse", "HEAD") !== env.GITHUB_SHA)
    throw new Error(
      "Review runtime differs from the exact protected workflow source",
    );
  const plan = await verifyNextDevelopmentReview({
    client,
    repository,
    runId,
    git,
    verifyDelta: (args) =>
      verifyVersionStateDelta({
        ...args,
        cwd: workspace,
        nodeModules: path.join(workspace, "node_modules"),
      }),
    publication: (args) =>
      readBinaryPublicationEvidence({
        ...args,
        client: releaseAssetClient(repository, { token }),
        attempts: 1,
      }),
  });
  persist(file, plan);
  core.setOutput("review-path", file);
  core.setOutput("head-sha", plan.headSha);
}
export async function completeNextDevelopmentReviewAction(core, env) {
  const { repository, runId, workspace, file } = coordinates(env);
  const token = core.getInput("token", { required: true }),
    approvalToken = core.getInput("approval-token", { required: true }),
    mutationToken = core.getInput("mutation-token", { required: true });
  const client = createGitHubCliApi(undefined, { ...env, GH_TOKEN: token });
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  if (plan.repository !== repository || String(plan.runId) !== runId)
    throw new Error("review plan is from another invocation");
  const reviewed = await approveNextDevelopment({
    client,
    plan,
    reviewer: createGitHubCliApi(undefined, {
      ...env,
      GH_TOKEN: approvalToken,
    }),
  });
  persist(file, reviewed);
  core.setOutput("review-path", file);
  core.setOutput("review-id", reviewed.reviewId);
  core.setOutput("head-sha", reviewed.headSha);
  await enqueueVerifiedDevelopmentReview({
    client: createGitHubCliApi(undefined, { ...env, GH_TOKEN: mutationToken }),
    repository,
    runId,
    plan: reviewed,
    mergeFinalization: ({ repository, number, headSha }) =>
      execFileSync(
        "gh",
        [
          "pr",
          "merge",
          String(number),
          "--repo",
          repository,
          "--merge",
          "--auto",
          "--match-head-commit",
          headSha,
        ],
        {
          cwd: workspace,
          env: { ...env, GH_TOKEN: mutationToken },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
  });
}

import fs from "node:fs";
import path from "node:path";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import { reconcileConfiguredDevMergeQueue } from "../merge-queue-policy.js";
export async function reconcileMergeQueueAction(
  core,
  env,
  { reconcile = reconcileConfiguredDevMergeQueue } = {},
) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  const branch = core.getInput("branch", { required: true });
  const provider = new GitHubTwoPhaseClient({
    repository: env.GITHUB_REPOSITORY,
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  });
  const facts = await reconcile({
    api: {
      request: (method, endpoint, body) =>
        provider.request(`/${endpoint}`, { method, body }),
    },
    repository: env.GITHUB_REPOSITORY,
    branch,
    cwd: workspace,
    apply: core.getBooleanInput("apply"),
  });
  fs.writeFileSync(
    path.join(workspace, ".buildchain-dev-merge-queue.json"),
    `${JSON.stringify(facts, null, 2)}\n`,
  );
  await core.summary
    .addHeading("Dev merge queue governance", 2)
    .addList([
      `branch: ${branch}`,
      `mode: ${facts.policyResolution.mode}`,
      `action: ${facts.action}`,
      `applied: ${facts.applied}`,
      `source branch: ${facts.policyResolution.sourceBranch || "none"}`,
    ])
    .write();
}

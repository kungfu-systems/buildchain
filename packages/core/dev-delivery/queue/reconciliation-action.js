import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import { reconcileConfiguredDevMergeQueue } from "../merge-queue-policy.js";
export async function reconcileMergeQueueAction(core, env) {
  const workspace = path.resolve(env.GITHUB_WORKSPACE);
  if (
    fs.realpathSync(installationRoot(import.meta.url)) !==
    fs.realpathSync(workspace)
  )
    throw new Error(
      "Merge queue policy must use the checked-out governed source implementation",
    );
  const branch = core.getInput("branch", { required: true });
  const provider = new GitHubTwoPhaseClient({
    repository: env.GITHUB_REPOSITORY,
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  });
  const facts = await reconcileConfiguredDevMergeQueue({
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

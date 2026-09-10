import fs from "node:fs";
import path from "node:path";
import { GitHubHousekeeperClient } from "../engineering-housekeeper-github.js";
import { runHousekeepingTransaction } from "./execution.js";

export async function reconcileHousekeepingAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const scope = core.getInput("scope", { required: true });
  const planning = scope === "plan";
  const client = new GitHubHousekeeperClient({
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL,
  });
  const options = {
    repository: core.getInput("repository", { required: true }),
    targetBranch: request["target-branch"],
    mode: request.mode,
    applyEnabled: request["apply-enabled"],
    staleDays: request["stale-days"],
    maxActions: request["max-actions"],
    protectedPatterns: request["protected-patterns"],
    retainedPatterns: request["retained-patterns"],
    temporaryBranchPatterns: request["temporary-branch-patterns"],
    stalePullRequestLabel: request["stale-pull-request-label"],
    outputDirectory: path.join(
      env.GITHUB_WORKSPACE,
      `.buildchain/engineering-housekeeper${planning ? "" : `-${scope}`}`,
    ),
  };
  const result = await runHousekeepingTransaction(
    {
      options,
      scope,
      planPath: path.join(
        env.GITHUB_WORKSPACE,
        ".buildchain/engineering-housekeeper-input/plan.json",
      ),
    },
    client,
  );
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, result.report);
  for (const [key, value] of Object.entries(result.outputs))
    core.setOutput(key, value);
}

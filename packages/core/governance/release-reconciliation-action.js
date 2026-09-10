import fs from "node:fs";
import path from "node:path";
import { reconcileReleaseGovernance } from "./release-reconciliation.js";

export async function reconcileReleaseGovernanceAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const result = await reconcileReleaseGovernance({
    repository: env.GITHUB_REPOSITORY,
    branch: request.branch,
    candidateSha: request["candidate-sha"],
    apply: request.apply ?? false,
    apiUrl: env.GITHUB_API_URL,
    token: core.getInput("token", { required: true }),
  });
  fs.writeFileSync(
    path.join(
      env.GITHUB_WORKSPACE,
      ".buildchain-release-governance-reconciliation.json",
    ),
    JSON.stringify(result, null, 2) + "\n",
  );
  core.info(
    `Release governance ${result.status}: ${result.repository} ${result.branch}`,
  );
}

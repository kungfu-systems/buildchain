import path from "node:path";
import { GitHubClient } from "../../dev-delivery/admission/github-client.js";
import { reconcileRepositoryPatrol } from "./transaction.js";
export async function reconcileRepositoryPatrolAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const [owner, repo] = env.GITHUB_REPOSITORY.split("/");
  const client = new GitHubClient({
    repository: { owner, repo, fullName: env.GITHUB_REPOSITORY },
    token: core.getInput("token", { required: true }),
    apiUrl: env.GITHUB_API_URL,
  });
  const { outputs } = await reconcileRepositoryPatrol(
    {
      summaryPath: env.GITHUB_STEP_SUMMARY,
      options: {
        repository: env.GITHUB_REPOSITORY,
        targetBranch: request["target-branch"] || env.GITHUB_REF_NAME,
        cadence: request.cadence,
        mode: request.mode,
        capabilities: request.capabilities,
        requiredChecks: request["required-status-checks"],
        readyLabel: request["ready-label"],
        blockLabels: request["block-labels"],
        allowedHeadPrefixes: request["allowed-head-prefixes"],
        requireApproval: request["require-approval"],
        sameRepositoryOnly: request["same-repository-only"],
        maxActions: request["max-actions"],
        mergeMethod: request["merge-method"],
        landingMode: request["landing-mode"],
        dryRun: request["dry-run"],
        outputPath: path.join(
          env.GITHUB_WORKSPACE,
          ".buildchain/patrol/result.json",
        ),
      },
    },
    client,
  );
  for (const [key, value] of Object.entries(outputs))
    core.setOutput(key, value);
}

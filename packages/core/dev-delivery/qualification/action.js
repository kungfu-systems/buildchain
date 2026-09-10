import fs from "node:fs";
import path from "node:path";
import { runDevQualificationPatrol } from "./controller.js";
import { createGitHubDevQualificationClient } from "./github-client.js";
import {
  renderDevQualificationSummary,
  devQualificationOutputs,
} from "./report.js";

export async function reconcileDevQualificationAction(core, env) {
  const request = JSON.parse(core.getInput("request-json", { required: true }));
  const mode = core.getInput("mode", { required: true });
  if (!["observe", "apply"].includes(mode))
    throw new Error("Dev qualification mode must be observe or apply");
  const mutationAuthorized = mode === "apply";
  if (
    mutationAuthorized &&
    (request["mutation-authorized"] !== true || request["dry-run"] !== false)
  )
    throw new Error(
      "Dev qualification mutation requires explicit authorization and dry-run=false",
    );
  const observation = JSON.parse(core.getInput("observation-json") || "{}");
  if (mutationAuthorized && (!observation.action || !observation["source-sha"]))
    throw new Error("Mutation requires the observed action and exact source");
  const outputPath = path.join(
    env.GITHUB_WORKSPACE,
    `.buildchain/patrol/dev-qualification${mutationAuthorized ? "-mutation" : ""}.json`,
  );
  const result = await runDevQualificationPatrol(
    {
      repository: env.GITHUB_REPOSITORY,
      sourceBranch: request["source-branch"],
      devWorkflowPath: request["dev-workflow-path"],
      preflightWorkflowPath: request["preflight-workflow-path"],
      priorityWorkflowPaths: request["priority-workflows-json"],
      dispatchInputs: request["dispatch-inputs-json"],
      maxAttempts: request["max-attempts"],
      mutationAuthorized,
      expectedAction: mutationAuthorized ? observation.action : "",
      expectedSourceSha: mutationAuthorized ? observation["source-sha"] : "",
      outputPath,
    },
    createGitHubDevQualificationClient({
      repository: env.GITHUB_REPOSITORY,
      token: core.getInput("token", { required: true }),
    }),
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  if (env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      renderDevQualificationSummary(result),
    );
  for (const [key, value] of Object.entries(
    devQualificationOutputs(result, outputPath),
  ))
    core.setOutput(key, value);
}

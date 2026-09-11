import * as github from "@actions/github";
import { buildArtifactActionContext } from "../artifact/actions.js";
import { createBuildFinalizationService } from "./finalization.js";
import { readJson } from "../plan/values.js";

export async function finalizeBuildAction(core, env) {
  const context = buildArtifactActionContext(core, env);
  const octokit = github.getOctokit(core.getInput("token", { required: true }));
  const service = createBuildFinalizationService(
    {
      ...context,
      workflow: { name: env.GITHUB_WORKFLOW, serverUrl: env.GITHUB_SERVER_URL },
      event: env.GITHUB_EVENT_PATH ? readJson(env.GITHUB_EVENT_PATH) : {},
    },
    {
      readProviderArtifacts: (run) => {
        const [owner, repo] = run.repository.split("/");
        return octokit.paginate(octokit.rest.actions.listWorkflowRunArtifacts, {
          owner,
          repo,
          run_id: Number(run.id),
          per_page: 100,
        });
      },
    },
  );
  core.setOutput(
    "result",
    await service.finalizeBuild(
      JSON.parse(core.getInput("jobs", { required: true })),
    ),
  );
}

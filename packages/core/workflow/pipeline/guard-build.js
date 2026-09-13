import { githubPipelineRuns } from "../../providers/github/pipeline-runs.js";
import { readPipelineCaller } from "../../providers/github/pipeline-run-entry.js";
import { pipelineBuildEvidence } from "./build-evidence.js";
import { qualifyPipelineSourceRun } from "./delivery-request.js";

export async function guardPipelineBuild(
  input,
  observed,
  {
    material,
    source,
    request,
    repository,
    runs = githubPipelineRuns(request, repository),
  },
) {
  const session = { observed, journal: { read: async () => observed } };
  const build = await pipelineBuildEvidence(session, {
    runId: 0,
    runs,
    source,
    materialStore: () => material,
  });
  if (!build || build.run.id !== Number(input["source-workflow-run-id"]))
    throw new Error(
      "Delivery requires its independently qualified exact product build",
    );
  const current = { ...observed.history.at(-1), intent: observed.intent };
  qualifyPipelineSourceRun(build.run, current, build.readback);
  await readPipelineCaller(
    build.run,
    current.generation.source.configPath,
    request,
    repository,
  );
  return build;
}

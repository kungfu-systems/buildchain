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

// A commit status is source-bound and survives later workflow suites. Publish
// only the independently reread build at the protected landing boundary, whose
// existing Actions credential owns statuses:write. Retained build receipts
// preserve the original executions and their outcomes.
export async function publishPipelineBuildStatus(
  input,
  build,
  request,
  repository,
) {
  if (
    build.readback.source.repository !== repository ||
    build.readback.source.commit !== input["expected-head-sha"] ||
    build.sourceHead !== input["expected-head-sha"] ||
    build.run.id !== Number(input["source-workflow-run-id"]) ||
    build.readback.runId !== build.run.id ||
    build.readback.runAttempt !== build.run.run_attempt ||
    build.outcome !== "success" ||
    build.readback.outcome !== "success"
  )
    throw new Error(
      "Landing status differs from its qualified exact-source build",
    );
  return request(`/repos/${repository}/statuses/${build.sourceHead}`, {
    method: "POST",
    body: {
      context: "check",
      state: "success",
      description: `Qualified product build: ${build.readback.root}`.slice(
        0,
        140,
      ),
      target_url: `https://github.com/${repository}/actions/runs/${build.run.id}/attempts/${build.run.run_attempt}`,
    },
  });
}

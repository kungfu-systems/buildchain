import { resolveRecoverySource } from "./recovery.js";
import {
  pipelineRuntimeContinuation,
  pipelineRecoveryContinuation,
} from "../../workflow/pipeline/runtime-source.js";

export async function resolveRuntimeActionSource(
  core,
  env,
  { providerFactory, github, pipelineLookup },
) {
  let source = {
    repository: core.getInput("source-repository") || env.GITHUB_REPOSITORY,
    sha: core.getInput("source-sha") || env.GITHUB_SHA,
    ref: env.GITHUB_REF,
  };
  const pipelineAttempt = core.getInput("pipeline-attempt");
  const recoveryAttempt = core.getInput("recovery-attempt");
  const resumeRunId = core.getInput("resume-run-id");
  if (
    [pipelineAttempt, recoveryAttempt, resumeRunId].filter(Boolean).length > 1
  )
    throw new Error("Runtime source selectors are mutually exclusive");
  let continuation;
  if (recoveryAttempt) {
    continuation = await pipelineRecoveryContinuation(
      recoveryAttempt,
      source.repository,
      core.getInput("token", { required: true }),
      pipelineLookup,
    );
    source = continuation.source;
  }
  if (pipelineAttempt) {
    continuation = await pipelineRuntimeContinuation(
      pipelineAttempt,
      source.repository,
      core.getInput("token", { required: true }),
      pipelineLookup,
    );
    source = continuation.source;
  }
  if (resumeRunId) {
    const reader = providerFactory(github, {
      sourceRepository: source.repository,
      sourceSha: source.sha,
      actor: env.GITHUB_ACTOR,
      eventName: env.GITHUB_EVENT_NAME,
    });
    await reader.authorize({ origin: "runtime-parameter" });
    source = await resolveRecoverySource(
      {
        repository: source.repository,
        runId: resumeRunId,
        currentRunId: env.GITHUB_RUN_ID,
        workflow: env.GITHUB_WORKFLOW_REF?.slice(source.repository.length + 1),
      },
      reader.readRun,
    );
  }
  return { source, continuation, resumeRunId, pipelineAttempt };
}

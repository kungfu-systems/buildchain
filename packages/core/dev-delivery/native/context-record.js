import { writeJson } from "./files.js";
export function recordNativeJobContext({
  output,
  outcome,
  run,
  runner,
  job = "native-execution",
  completedAt = new Date().toISOString(),
}) {
  if (!["succeeded", "failed"].includes(outcome))
    throw new Error("native job outcome must be succeeded or failed");
  const context = {
    schema: "kungfu.buildchain.native-job-context/v1",
    workflowRunId: run.id,
    workflowRunAttempt: run.attempt,
    job,
    runnerEnvironment: runner.environment,
    runnerName: runner.name,
    runnerOs: runner.os,
    runnerArch: runner.arch,
    outcome,
    evidenceCompletedAt: completedAt,
  };
  writeJson(output, context);
  return context;
}

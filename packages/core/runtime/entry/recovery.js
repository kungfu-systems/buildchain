export async function resolveRecoverySource(
  { repository, runId, currentRunId, workflow },
  readRun,
) {
  if (
    !/^[1-9]\d*$/u.test(String(runId)) ||
    String(runId) === String(currentRunId)
  )
    throw new Error("Recovery requires a different positive workflow run ID");
  const run = await readRun({ repository, runId: Number(runId) });
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  )
    throw new Error("Recovery cannot cross repository or fork boundaries");
  if (workflow && run.path?.split("@")[0] !== workflow.split("@")[0])
    throw new Error(
      "Recovery must enter through the original consumer workflow",
    );
  if (
    run.status !== "completed" ||
    !["failure", "cancelled", "timed_out", "action_required"].includes(
      run.conclusion,
    )
  )
    throw new Error("Recovery requires a completed unsuccessful execution");
  if (!/^[a-f0-9]{40}$/u.test(run.head_sha || ""))
    throw new Error("Recovery source commit is unavailable");
  return {
    repository,
    sha: run.head_sha,
    ref: run.head_branch || run.head_sha,
    runId: String(run.id),
    attempt: String(run.run_attempt),
    workflow: run.path,
  };
}

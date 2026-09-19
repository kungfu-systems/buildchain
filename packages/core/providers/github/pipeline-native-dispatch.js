const repository = "kungfu-systems/buildchain";
const workflow = "public-release-signing-authority.yml";

export function githubPipelineNativeDispatch(request) {
  async function entry(ref) {
    if (!["v4", "v4-alpha"].includes(ref))
      throw new Error(
        "Native signing entry must use a published floating channel",
      );
    const commit = await request(`/repos/${repository}/commits/${ref}`);
    if (!/^[0-9a-f]{40}$/u.test(commit?.sha || ""))
      throw new Error("Native signing entry has no exact provider commit");
    return { repository, ref, entrySha: commit.sha };
  }
  async function observe(operation, known) {
    const title = `Sign ${operation.source.repository} run ${operation.source.runId} (${operation.correlationId})`;
    const matches = [];
    if (known) {
      if (!Number.isSafeInteger(known.runId) || known.runId < 1)
        throw new Error("Native dispatch recovery has invalid run coordinates");
      matches.push(
        await request(`/repos/${repository}/actions/runs/${known.runId}`),
      );
    }
    for (let page = 1; !known && page <= 100; page++) {
      const response = await request(
        `/repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.workflow_runs))
        throw new Error("Native dispatch provider omitted its run inventory");
      matches.push(
        ...response.workflow_runs.filter((run) => run.display_title === title),
      );
      if (response.workflow_runs.length < 100) break;
      if (page === 100)
        throw new Error("Native dispatch run inventory exceeds its bound");
    }
    if (!matches.length) return { state: "absent" };
    if (matches.length !== 1)
      throw new Error("Native dispatch correlation is ambiguous");
    const run = matches[0];
    if (
      run.repository?.full_name !== repository ||
      run.display_title !== title ||
      run.path !== `.github/workflows/${workflow}` ||
      run.event !== "workflow_dispatch" ||
      run.head_sha !== operation.authority.entrySha ||
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      !Number.isSafeInteger(run.run_attempt) ||
      run.run_attempt < 1 ||
      (known &&
        (run.id !== known.runId || run.run_attempt !== known.runAttempt))
    )
      throw new Error(
        "Native dispatch returned a different authority execution",
      );
    return {
      state: run.status === "completed" ? "completed" : "pending",
      runId: run.id,
      runAttempt: run.run_attempt,
      conclusion: run.conclusion,
    };
  }
  async function dispatch(operation) {
    const current = await entry(operation.authority.ref);
    if (current.entrySha !== operation.authority.entrySha)
      throw new Error("Native signing entry moved after dispatch admission");
    await request(
      `/repos/${repository}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        body: {
          ref: current.ref,
          inputs: {
            "source-repository": operation.source.repository,
            "source-run-id": String(operation.source.runId),
            "source-run-attempt": String(operation.source.runAttempt),
            "request-artifact-pattern": operation.requestArtifact,
            "expected-request-root": operation.requestRoot,
            "result-artifact-name": operation.resultArtifact,
            "correlation-id": operation.correlationId,
            "runtime-ref": operation.runtimeSha,
          },
        },
      },
    );
  }
  return { entry, observe, dispatch };
}

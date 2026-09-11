export async function lookupSourceProof({
  github,
  repository,
  mergeGroupHeadRef,
  callerWorkflowRef,
}) {
  const outputs = {};
  const headRef = String(mergeGroupHeadRef || "");
  const match = headRef.match(/\/pr-(\d+)-/u);
  if (!match) {
    outputs["found"] = "false";
    outputs["reason"] = "merge-group-pr-number-unresolved";
    return outputs;
  }
  const pullNumber = Number(match[1]);
  const pull = await github.rest.pulls.get({
    owner: repository.owner,
    repo: repository.repo,
    pull_number: pullNumber,
  });
  const sourceHead = String(pull.data.head.sha || "").toLowerCase();
  const workflowRef = String(callerWorkflowRef || "");
  const prefix = `${repository.owner}/${repository.repo}/`;
  const callerPath = workflowRef.startsWith(prefix)
    ? workflowRef.slice(prefix.length).replace(/@.*$/u, "")
    : "";
  if (
    !/^[0-9a-f]{40}$/.test(sourceHead) ||
    !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(callerPath)
  ) {
    outputs["found"] = "false";
    outputs["reason"] = "source-proof-caller-coordinate-invalid";
    return outputs;
  }
  const runs = await github.rest.actions.listWorkflowRunsForRepo({
    owner: repository.owner,
    repo: repository.repo,
    event: "pull_request",
    head_sha: sourceHead,
    status: "completed",
    per_page: 20,
  });
  const candidates = runs.data.workflow_runs
    .filter((run) => run.conclusion === "success")
    .filter((run) => String(run.path || "").replace(/@.*$/u, "") === callerPath)
    .filter(
      (run) =>
        (run.pull_requests || []).length === 0 ||
        (run.pull_requests || []).some(
          (pullRequest) => pullRequest.number === pullNumber,
        ),
    )
    .slice(0, 5);
  const artifactName = `buildchain-source-qualification-proof-${sourceHead}`;
  for (const run of candidates) {
    const artifacts = await github.rest.actions.listWorkflowRunArtifacts({
      owner: repository.owner,
      repo: repository.repo,
      run_id: run.id,
      per_page: 100,
    });
    const matches = artifacts.data.artifacts.filter(
      (entry) => entry.name === artifactName && !entry.expired,
    );
    if (matches.length === 1) {
      outputs["found"] = "true";
      outputs["reason"] = "candidate-found";
      outputs["run-id"] = String(run.id);
      outputs["source-head"] = sourceHead;
      outputs["artifact-name"] = artifactName;
      outputs["workflow-path"] = run.path;
      return outputs;
    }
  }
  outputs["found"] = "false";
  outputs["reason"] =
    candidates.length > 0
      ? "source-proof-artifact-missing"
      : "accepted-source-workflow-missing";
  outputs["source-head"] = sourceHead;
  return outputs;
}

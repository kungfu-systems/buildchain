export async function lookupSourceProof({
  github,
  context,
  core,
  env = process.env,
}) {
  const headRef = String(context.payload.merge_group?.head_ref || "");
  const match = headRef.match(/\/pr-(\d+)-/u);
  if (!match) {
    core.setOutput("found", "false");
    core.setOutput("reason", "merge-group-pr-number-unresolved");
    return;
  }
  const pullNumber = Number(match[1]);
  const pull = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: pullNumber,
  });
  const sourceHead = String(pull.data.head.sha || "").toLowerCase();
  const workflowRef = String(env.CALLER_WORKFLOW_REF || "");
  const prefix = `${context.repo.owner}/${context.repo.repo}/`;
  const callerPath = workflowRef.startsWith(prefix)
    ? workflowRef.slice(prefix.length).replace(/@.*$/u, "")
    : "";
  if (
    !/^[0-9a-f]{40}$/.test(sourceHead) ||
    !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(callerPath)
  ) {
    core.setOutput("found", "false");
    core.setOutput("reason", "source-proof-caller-coordinate-invalid");
    return;
  }
  const runs = await github.rest.actions.listWorkflowRunsForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
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
      owner: context.repo.owner,
      repo: context.repo.repo,
      run_id: run.id,
      per_page: 100,
    });
    const matches = artifacts.data.artifacts.filter(
      (entry) => entry.name === artifactName && !entry.expired,
    );
    if (matches.length === 1) {
      core.setOutput("found", "true");
      core.setOutput("reason", "candidate-found");
      core.setOutput("run-id", String(run.id));
      core.setOutput("source-head", sourceHead);
      core.setOutput("artifact-name", artifactName);
      core.setOutput("workflow-path", run.path);
      return;
    }
  }
  core.setOutput("found", "false");
  core.setOutput(
    "reason",
    candidates.length > 0
      ? "source-proof-artifact-missing"
      : "accepted-source-workflow-missing",
  );
  core.setOutput("source-head", sourceHead);
}

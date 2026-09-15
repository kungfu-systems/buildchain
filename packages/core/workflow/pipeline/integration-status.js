import { recordDigest } from "../../release/discussion/envelope.js";

// The landing job already owns statuses:write. Keep its exact admission alive
// through the actual queue result so later channel PRs need not borrow the
// temporary queue branch's Actions check suite.
async function observeProtectedQueue(current, ports) {
  const { repository, request, queue } = ports;
  const now = ports.now || Date.now;
  const pause =
    ports.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 120 * 60 * 1000;
  const number = current.intent.source.pullRequest;
  const branch = current.intent.source.targetBranch;
  let queueExitAt;
  while (true) {
    const pr = await request(`/repos/${repository}/pulls/${number}`);
    if (
      pr.head?.sha !== current.generation.source.commit ||
      pr.head?.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      pr.base?.ref !== branch
    )
      throw new Error("Integrated status lost its exact admitted PR source");
    if (pr.merged) return { pr, deadline, now, pause };
    if (now() >= deadline)
      throw new Error(
        "Protected queue did not complete the admitted integration",
      );
    const pending = await queue(branch);
    if (
      pr.state !== "open" ||
      !pending.enabled ||
      !pending.entries.some(
        (entry) =>
          entry.pullRequestNumber === number &&
          entry.pullRequestHeadSha === current.generation.source.commit,
      )
    ) {
      // Queue removal can precede the PR endpoint's merged readback. Bound
      // convergence without treating absence or a closed PR as merge evidence.
      queueExitAt ??= now();
      if (now() - queueExitAt >= 30_000)
        throw new Error("Admitted PR left its protected merge queue");
    } else queueExitAt = undefined;
    await pause(10000);
  }
}

async function observeIntegrationWorkflow(merged, ports) {
  const { pr, deadline, now, pause } = merged;
  if (!/^[0-9a-f]{40}$/u.test(pr.merge_commit_sha || ""))
    throw new Error("Merged PR has no exact integration commit");
  while (true) {
    const result = await ports.request(
      `/repos/${ports.repository}/actions/runs?event=merge_group&head_sha=${pr.merge_commit_sha}&per_page=100`,
    );
    if (!Array.isArray(result.workflow_runs) || result.total_count > 100)
      throw new Error("Integration workflow inventory exceeds its bound");
    const runs = result.workflow_runs.filter(
      (run) =>
        run.path?.split("@")[0] === ".github/workflows/buildchain.yml" &&
        run.event === "merge_group" &&
        run.head_sha === pr.merge_commit_sha,
    );
    if (
      runs.some(
        (run) => run.status === "completed" && run.conclusion === "success",
      )
    )
      return;
    if (!runs.some((run) => run.status !== "completed") || now() >= deadline)
      throw new Error("Merged integration has no successful queue workflow");
    await pause(10000);
  }
}

function validateIntegratedStatus(proof, current, repository) {
  const { root, ...body } = proof;
  if (
    recordDigest(body) !== root ||
    proof.repository !== repository ||
    proof.pullRequest !== current.intent.source.pullRequest ||
    proof.sourceHead !== current.generation.source.commit ||
    proof.branch !== current.intent.source.targetBranch ||
    proof.build.source.commit !== proof.mergeCommit ||
    proof.build.source.repository !== repository ||
    proof.build.outcome !== "success" ||
    proof.run.conclusion !== "success" ||
    proof.run.status !== "completed" ||
    proof.run.event !== "merge_group" ||
    proof.run.head_sha !== proof.mergeCommit
  )
    throw new Error("Integrated status differs from its verified queue result");
}

export async function publishIntegratedPipelineStatus(current, ports) {
  const merged = await observeProtectedQueue(current, ports);
  await observeIntegrationWorkflow(merged, ports);
  const { repository, integration, status } = ports;
  const proof = await integration.observe(current);
  validateIntegratedStatus(proof, current, repository);
  const { root } = proof;
  await status(`/repos/${repository}/statuses/${proof.mergeCommit}`, {
    method: "POST",
    body: {
      context: "check",
      state: "success",
      description: `Qualified protected integration: ${root}`.slice(0, 140),
      target_url: `https://github.com/${repository}/actions/runs/${proof.run.id}/attempts/${proof.run.run_attempt}`,
    },
  });
  return proof;
}

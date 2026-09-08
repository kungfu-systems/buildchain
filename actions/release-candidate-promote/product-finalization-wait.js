const SHA = /^[a-f0-9]{40}$/u;
const failure = (message, code, kind = "conflict") => Object.assign(new Error(message), {
  releaseTailClass: kind, releaseTailCode: code,
});

async function protectedVerification(octokit, coordinates, sha, branch, requiredStatusCheck) {
  const { data } = await octokit.rest.checks.listForRef({ ...coordinates, ref: sha, filter: "latest", per_page: 100 });
  const checks = data.check_runs.filter((entry) => entry.name === requiredStatusCheck && entry.head_sha === sha);
  if (!checks.length) return false;
  if (checks.length !== 1) throw failure("ambiguous final protected check", "protected-finalization-check-ambiguous");
  const check = checks[0];
  const prefix = `https://github.com/${coordinates.owner}/${coordinates.repo}/actions/runs/`;
  const runId = check.details_url?.startsWith(prefix) && /^(\d+)(?:\/|$)/u.exec(check.details_url.slice(prefix.length))?.[1];
  if (!runId || check.app?.slug !== "github-actions") throw failure("final check lacks GitHub workflow identity", "protected-finalization-check-identity");
  const { data: run } = await octokit.rest.actions.getWorkflowRun({ ...coordinates, run_id: Number(runId) });
  if (run.head_sha !== sha || run.head_branch !== branch || run.event !== "push")
    throw failure("final check is not bound to the protected push", "protected-finalization-check-identity");
  if (run.status !== "completed" || check.status !== "completed") return false;
  if (run.conclusion !== "success" || check.conclusion !== "success")
    throw failure("final protected Verify failed", "protected-finalization-check-failed");
  return true;
}

// Waiting has no approval authority. The independent protected reviewer owns it.
export async function waitForProductFinalization({
  octokit, repository, pull, branch, headSha, baseSha, wait,
  requiredStatusCheck = "check",
  maxPolls = 160,
}) {
  const [owner, repo] = repository.split("/");
  const coordinates = { owner, repo };
  if (![headSha, baseSha].every((sha) => SHA.test(sha || "")) || !pull?.number)
    throw failure("exact finalization PR coordinates required", "protected-finalization-identity");
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const { data: current } = await octokit.rest.pulls.get({ ...coordinates, pull_number: pull.number });
    if (current.head?.sha !== headSha || current.head?.repo?.full_name !== repository ||
      current.base?.ref !== branch || current.base?.repo?.full_name !== repository || current.draft)
      throw failure("finalization PR identity changed", "protected-finalization-identity");
    const { data: ref } = await octokit.rest.git.getRef({ ...coordinates, ref: `heads/${branch}` });
    if (current.merged_at) {
      if (!SHA.test(current.merge_commit_sha || "") || ref.object?.sha !== current.merge_commit_sha)
        throw failure("protected branch moved beyond the finalization merge", "protected-finalization-base-drift");
      if (await protectedVerification(octokit, coordinates, current.merge_commit_sha, branch, requiredStatusCheck))
        return current.merge_commit_sha;
    } else {
      if (current.state !== "open") throw failure("finalization PR closed without merge", "protected-finalization-closed");
      if (ref.object?.sha !== baseSha) throw failure("protected base changed while finalizing", "protected-finalization-base-drift");
    }
    if (poll + 1 < maxPolls) await wait(15_000);
  }
  throw failure("timed out waiting for protected finalization; resume the original publication", "protected-finalization-timeout", "transient");
}

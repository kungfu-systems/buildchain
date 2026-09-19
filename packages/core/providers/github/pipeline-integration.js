import { recordDigest } from "../../release/discussion/envelope.js";
import { pipelinePlatforms } from "../../workflow/pipeline/platforms.js";

export function githubPipelineIntegration(request, repository, source, runs) {
  const base = `/repos/${repository}`;
  async function observe(current) {
    const number = current.intent.source.pullRequest;
    const branch = current.intent.source.targetBranch;
    const pr = await request(`${base}/pulls/${number}`);
    if (
      !pr.merged ||
      pr.head?.sha !== current.generation.source.commit ||
      pr.base?.ref !== branch ||
      pr.head?.repo?.full_name !== repository ||
      pr.base?.repo?.full_name !== repository ||
      !/^[0-9a-f]{40}$/u.test(pr.merge_commit_sha || "")
    )
      throw new Error(
        "Integration needs the exact source PR merged into its protected target",
      );
    const mergeCommit = pr.merge_commit_sha;
    const protectedHead = await source.branchHead(branch);
    const ancestry = await request(
      `${base}/compare/${mergeCommit}...${protectedHead}`,
    );
    if (
      !["identical", "ahead"].includes(ancestry.status) ||
      ancestry.merge_base_commit?.sha !== mergeCommit
    )
      throw new Error(
        "Exact merge commit is not contained in the protected branch",
      );
    const commits = await source.source(
      mergeCommit,
      current.generation.source.configPath,
    );
    const response = await request(
      `${base}/actions/runs?event=merge_group&head_sha=${mergeCommit}&per_page=100`,
    );
    if (!Array.isArray(response.workflow_runs) || response.total_count > 100)
      throw new Error(
        "Exact merge-group run inventory is unavailable or ambiguous",
      );
    const candidates = response.workflow_runs.filter(
      (run) =>
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.path?.split("@")[0] === ".github/workflows/buildchain.yml",
    );
    if (!candidates.length)
      throw new Error(
        "Exact merged commit has no successful normal pipeline merge-group run",
      );
    const chosen = candidates.sort((a, b) => b.id - a.id)[0];
    const { run } = await runs.read(chosen.id, chosen.run_attempt);
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.event !== "merge_group" ||
      run.head_sha !== mergeCommit
    )
      throw new Error("Integration merge-group execution changed");
    const build = await runs.build(
      run.id,
      run.run_attempt,
      commits.identity,
      pipelinePlatforms(commits.plan).map((item) => item.platform),
    );
    if (build.outcome !== "success")
      throw new Error("Exact merged tree product verification failed");
    const again = await request(`${base}/pulls/${number}`);
    if (
      !again.merged ||
      again.merge_commit_sha !== mergeCommit ||
      again.head.sha !== pr.head.sha ||
      again.base.ref !== branch
    )
      throw new Error("Integration provider source changed during readback");
    const body = {
      schema: "buildchain.pipeline-integration-readback/v1",
      repository,
      pullRequest: number,
      sourceHead: pr.head.sha,
      branch,
      protectedHead,
      mergeCommit,
      mergeTree: commits.identity.tree,
      run,
      build,
      ancestry,
    };
    return { ...body, root: recordDigest(body) };
  }
  return { observe };
}

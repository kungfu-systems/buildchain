import { pathToFileURL } from "node:url";
export async function run({ github, context, core, env = process.env }) {
  const runtime = await import(
    pathToFileURL(
      `${env.BUILDCHAIN_RUNTIME_ROOT}/packages/core/release/release-invocation.js`,
    ).href
  );
  const targetRef = (
    env.INPUT_TARGET_REF || context.ref.replace(/^refs\/heads\//, "")
  ).replace(/^refs\/heads\//, "");
  const requestedSha = env.INPUT_TARGET_SHA || context.sha;
  const current = await github.rest.git.getRef({
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref: `heads/${targetRef}`,
  });
  const currentSha = current.data.object.sha;
  const sourceCommit = await github.rest.git.getCommit({
    owner: context.repo.owner,
    repo: context.repo.repo,
    commit_sha: requestedSha,
  });
  const sourceTimestamp =
    sourceCommit.data.committer?.date || sourceCommit.data.author?.date;
  if (!sourceTimestamp)
    throw new Error("requested source commit has no provider timestamp");
  let comparisonStatus = "identical";
  if (currentSha !== requestedSha) {
    const comparison = await github.rest.repos.compareCommitsWithBasehead({
      owner: context.repo.owner,
      repo: context.repo.repo,
      basehead: `${requestedSha}...${currentSha}`,
    });
    comparisonStatus = comparison.data.status;
  }
  const route = runtime.planReleaseRoute({
    requestedSha,
    observedSha: currentSha,
    comparisonStatus,
    requestedChannel: env.INPUT_CHANNEL,
    targetRef,
    dryRun: env.INPUT_DRY_RUN === "true",
    resume: env.INPUT_RESUME === "true",
  });
  if (route.decision === "Blocked")
    throw new Error(`release route blocked: ${route.reason}`);
  core.setOutput("action", route.decision === "NoOp" ? "noop" : "promote");
  core.setOutput("reason", route.reason);
  core.setOutput("channel", route.channel);
  core.setOutput("target-ref", route.targetRef);
  core.setOutput("requested-sha", route.requestedSha);
  core.setOutput("source-timestamp", new Date(sourceTimestamp).toISOString());
  core.setOutput("current-sha", currentSha);
}

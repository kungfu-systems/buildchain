import { pathToFileURL } from "node:url";
export async function run({ github, context, core, env = process.env }) {
  const runtime = await import(
    pathToFileURL(
      `${env.BUILDCHAIN_RUNTIME_ROOT}/packages/core/workflow/universal-workflow-bootstrap.js`,
    ).href
  );
  const requestedSha = env.BUILDCHAIN_REQUESTED_SHA;
  const explicitResume = env.BUILDCHAIN_EXPLICIT_RESUME === "true";
  const refs = explicitResume
    ? []
    : await github.paginate(github.rest.git.listMatchingRefs, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: `heads/buildchain/v4-product-state/${requestedSha}-`,
        per_page: 100,
      });
  const recoveryStates = [];
  for (const stateRef of refs) {
    const version = runtime.productStateVersion(stateRef, requestedSha);
    const stateCommit = (
      await github.rest.git.getCommit({
        owner: context.repo.owner,
        repo: context.repo.repo,
        commit_sha: stateRef.object.sha,
      })
    ).data;
    let exactTagRef;
    try {
      exactTagRef = (
        await github.rest.git.getRef({
          owner: context.repo.owner,
          repo: context.repo.repo,
          ref: `tags/v${version}`,
        })
      ).data;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    recoveryStates.push({ stateRef, stateCommit, exactTagRef });
  }
  let exactTagRef;
  if (!explicitResume && recoveryStates.length === 0) {
    try {
      exactTagRef = (
        await github.rest.git.getRef({
          owner: context.repo.owner,
          repo: context.repo.repo,
          ref: `tags/v${env.BUILDCHAIN_CANDIDATE_VERSION}`,
        })
      ).data;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const version = runtime.selectRecoveredProductPublicationVersion({
    routeDecision: "Resume",
    candidateVersion: env.BUILDCHAIN_CANDIDATE_VERSION,
    requestedSha,
    explicitResume,
    recoveryStates,
    exactTagRef,
  });
  core.setOutput("version", version);
}

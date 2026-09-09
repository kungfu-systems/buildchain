import { pathToFileURL } from "node:url";
export async function run({ github, context, core, env = process.env }) {
  const runtime = await import(
    pathToFileURL(
      `${env.GITHUB_WORKSPACE}/packages/core/workflow/universal-workflow-bootstrap.js`,
    ).href
  );
  const requestedSha = env.BUILDCHAIN_TARGET_SHA;
  const head = await github.rest.git.getCommit({
    owner: context.repo.owner,
    repo: context.repo.repo,
    commit_sha: requestedSha,
  });
  const refs = await github.paginate(github.rest.git.listMatchingRefs, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    ref: "heads/buildchain/v4-product-state/",
    per_page: 100,
  });
  const recoveryStates = [];
  for (const stateRef of refs) {
    const match = stateRef.ref.match(
      /^refs\/heads\/buildchain\/v4-product-state\/([0-9a-f]{40})-/,
    );
    if (!match) continue;
    const stateCommit = (
      await github.rest.git.getCommit({
        owner: context.repo.owner,
        repo: context.repo.repo,
        commit_sha: stateRef.object.sha,
      })
    ).data;
    if (stateCommit.tree?.sha !== head.data.tree?.sha) continue;
    const comparison = await github.rest.repos.compareCommitsWithBasehead({
      owner: context.repo.owner,
      repo: context.repo.repo,
      basehead: `${stateRef.object.sha}...${requestedSha}`,
    });
    const version = runtime.productStateVersion(stateRef, match[1]);
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
    recoveryStates.push({
      stateRef,
      stateCommit,
      exactTagRef,
      headComparisonStatus: comparison.data.status,
    });
  }
  const finalizedVersion = runtime.selectFinalizedProductPublicationVersion({
    requestedSha,
    requestedTree: head.data.tree.sha,
    targetRef: env.BUILDCHAIN_TARGET_REF,
    recoveryStates,
  });
  core.setOutput("action", finalizedVersion ? "noop" : "promote");
  core.setOutput("finalized-version", finalizedVersion);
  if (finalizedVersion) {
    core.info(
      `Publication head is generated finalization for v${finalizedVersion}; no new promotion is required.`,
    );
  }
}

import { recordDigest } from "../../release/discussion/envelope.js";

export async function prepareNextDevelopmentPullRequest(
  context,
  host,
  journal,
  transition,
  adapter,
) {
  const { plan } = context;
  const retained = await journal.materials(
    "publication/next-development-source/",
  );
  if (retained.length > 1)
    throw new Error("Next-development source reservation is ambiguous");
  let request = retained[0];
  if (!request) {
    const baseCommit = await host.source.branchHead(plan.developmentBranch);
    const source = await host.source.source(baseCommit, plan.source.configPath);
    if (recordDigest(source.plan) !== plan.contractRoot)
      throw new Error(
        "Protected development contract changed before version preparation",
      );
    const input = await adapter.inspect(source.identity, plan.versionPolicy);
    if (
      plan.channel === "stable"
        ? input.version.split("-alpha.")[0] !== plan.version
        : input.version !== plan.version
    )
      throw new Error(
        "Development version already changed; reconcile its protected provenance before preparing another PR",
      );
    request = {
      source: source.identity,
      versionPolicy: plan.versionPolicy,
      version: transition.target.version,
      root: recordDigest({
        transitionRoot: transition.idempotencyKey,
        source: source.identity,
      }),
      sourceTimestamp: input.sourceTimestamp,
    };
    await journal.record("publication/next-development-source", request, {
      phase: "next-development",
    });
  }
  await journal.fence();
  const materialization = await adapter.materializeDevelopment(request);
  const branch = materialization.branch;
  const pulls = await host.request(
    `/repos/${host.repository}/pulls?state=all&head=${encodeURIComponent(`${host.repository.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(plan.developmentBranch)}&per_page=100`,
  );
  if (!Array.isArray(pulls) || pulls.length > 1)
    throw new Error("Next-development PR identity is ambiguous");
  let pr = pulls[0];
  if (!pr) {
    await journal.fence();
    if (!host.pullRequests)
      throw new Error(
        "Next-development requires the repository-authorized automation App or token to trigger ordinary PR checks",
      );
    pr = await host.pullRequests(`/repos/${host.repository}/pulls`, {
      method: "POST",
      body: {
        title: `chore(version): prepare ${transition.target.version}`,
        head: branch,
        base: plan.developmentBranch,
        body: `Prepare the declared next development version after ${plan.tag}.\n\nBuildchain-Parent-Attempt: ${context.attempt}\nBuildchain-Transition: ${transition.idempotencyKey}\n\nThe normal protected pipeline verifies the declared products before merge.`,
      },
    });
  }
  const selected = {
    schema: "buildchain.pipeline-next-development-pr/v1",
    number: pr.number,
    branch,
    base: plan.developmentBranch,
    source: materialization.source,
    materialization,
    transitionRoot: transition.idempotencyKey,
  };
  await journal.record("publication/next-development-pr", selected, {
    phase: "next-development",
  });
  return selected;
}

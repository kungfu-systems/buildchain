import { compareDevelopmentVersions } from "../publication-development.js";
import { recordDigest } from "../../release/discussion/envelope.js";

export async function observeAdvancedPipelineDevelopment(
  context,
  host,
  transition,
  adapter,
) {
  const { plan } = context;
  const commit = await host.source.branchHead(plan.developmentBranch);
  const source = await host.source.source(commit, plan.source.configPath);
  if (recordDigest(source.plan) !== plan.contractRoot)
    throw new Error(
      "Protected development contract changed before next-version readback",
    );
  const observed = await adapter.inspect(source.identity, plan.versionPolicy);
  const order = compareDevelopmentVersions(
    observed.version,
    transition.target.version,
  );
  if (order < 0) return null;
  const pulls = await host.request(
    `/repos/${host.repository}/commits/${commit}/pulls?per_page=100`,
  );
  const matches = pulls.filter(
    (pr) =>
      pr.base?.ref === plan.developmentBranch && pr.merge_commit_sha === commit,
  );
  if (matches.length !== 1)
    throw new Error(
      "Advanced development requires one exact protected merged PR",
    );
  const pr = await host.request(
    `/repos/${host.repository}/pulls/${matches[0].number}`,
  );
  const integration = await host.integration.observe({
    intent: {
      source: { pullRequest: pr.number, targetBranch: plan.developmentBranch },
    },
    generation: {
      source: { commit: pr.head.sha, configPath: plan.source.configPath },
    },
  });
  if (integration.mergeCommit !== commit)
    throw new Error(
      "Advanced development proof differs from the observed protected commit",
    );
  return {
    state: "success",
    reason:
      order === 0
        ? "protected-development-already-current"
        : "protected-development-already-advanced",
    transitionRoot: transition.idempotencyKey,
    targetVersion: transition.target.version,
    observedVersion: observed.version,
    source: source.identity,
    integration,
    filesRoot: recordDigest(observed.files),
    publicationOutcome: "preserved-success",
  };
}

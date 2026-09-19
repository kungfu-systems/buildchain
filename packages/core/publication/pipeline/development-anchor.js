import { createHash } from "node:crypto";
import { recordDigest } from "../../release/discussion/envelope.js";
import { bindPipelineDevelopmentAnchor } from "./development-transition.js";
import { githubPipelineVersion } from "../../providers/github/pipeline-version.js";
import { developmentTransitionReadback } from "./development-proof.js";

export async function observePipelineVersionAnchor(context, host, transition) {
  const { plan } = context;
  const commit = await host.source.branchHead(plan.developmentBranch);
  const source = await host.source.source(commit, plan.source.configPath);
  const ancestry =
    plan.channel === "stable"
      ? null
      : await host.request(
          `/repos/${host.repository}/compare/${plan.intentSource.commit}...${commit}`,
        );
  if (
    ancestry &&
    (!["identical", "ahead"].includes(ancestry.status) ||
      ancestry.merge_base_commit?.sha !== plan.intentSource.commit)
  )
    throw new Error(
      "Version anchor is not descended from the released development source",
    );
  if (recordDigest(source.plan) !== plan.contractRoot)
    throw new Error("Protected anchor changed the product contract");
  const version = await githubPipelineVersion(
    host.request,
    host.repository,
  ).inspect(source.identity, plan.versionPolicy);
  if (version.version === plan.version)
    return {
      state: "waiting",
      reason: "waiting-for-protected-version-anchor",
      transitionRoot: transition.idempotencyKey,
    };
  const pulls = await host.request(
    `/repos/${host.repository}/commits/${commit}/pulls?per_page=100`,
  );
  const candidates = pulls.filter(
    (pr) =>
      pr.base?.ref === plan.developmentBranch && pr.merge_commit_sha === commit,
  );
  if (candidates.length !== 1)
    throw new Error("Version anchor requires one exact protected merged PR");
  const pr = await host.request(
    `/repos/${host.repository}/pulls/${candidates[0].number}`,
  );
  const integration = await host.integration.observe({
    intent: {
      source: { pullRequest: pr.number, targetBranch: plan.developmentBranch },
    },
    generation: {
      source: { commit: pr.head.sha, configPath: plan.source.configPath },
    },
  });
  if (
    plan.channel === "stable" &&
    Date.parse(pr.merged_at) <=
      Date.parse(transition.completedStable.completedAt)
  )
    return {
      state: "waiting",
      reason: "waiting-for-protected-version-anchor",
      transitionRoot: transition.idempotencyKey,
    };
  const file = plan.versionPolicy.files[0].path;
  const anchor = {
    manifestPath: file,
    manifestRoot: `sha256:${createHash("sha256").update(version.files[file]).digest("hex")}`,
  };
  const bound = bindPipelineDevelopmentAnchor(transition, {
    targetVersion: version.version,
    anchor,
  });
  const verified = developmentTransitionReadback(bound, {
    before: version,
    after: version,
    evidence: integration,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at,
  });
  return {
    state: "success",
    reason: "protected-version-anchor-verified",
    transition: verified,
    source: source.identity,
    integration,
    anchor,
  };
}

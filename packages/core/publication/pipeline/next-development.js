import { observeAdvancedPipelineDevelopment } from "./development-current.js";
import { createPipelineDevelopmentTransition } from "./development-transition.js";
import { githubPipelineVersion } from "../../providers/github/pipeline-version.js";
import { uniquePublicationMaterial } from "./context.js";
import { observePipelineVersionAnchor } from "./development-anchor.js";
import { developmentTransitionReadback } from "./development-proof.js";
import { prepareNextDevelopmentPullRequest } from "./development-pr.js";

export async function nextPipelineDevelopment(context, host, journal) {
  const { plan } = context;
  const publication = await uniquePublicationMaterial(
    journal,
    "publication/complete/",
  );
  const transitions = await journal.materials(
    "publication/next-development-plan/",
  );
  if (transitions.length > 1)
    throw new Error("Next-development has conflicting retained declarations");
  let transition = transitions[0];
  if (!transition) {
    transition = createPipelineDevelopmentTransition(context, publication);
    await journal.record("publication/next-development-plan", transition, {
      phase: "next-development",
    });
  }
  if (transition.model.strategy === "anchored")
    return observePipelineVersionAnchor(context, host, transition);
  const retained = await journal.materials("publication/next-development-pr/");
  if (retained.length > 1)
    throw new Error("Next-development has conflicting retained PRs");
  let selected = retained[0];
  const adapter = githubPipelineVersion(host.request, host.repository);
  if (!selected) {
    const advanced = await observeAdvancedPipelineDevelopment(
      context,
      host,
      transition,
      adapter,
    );
    if (advanced) return advanced;
    selected = await prepareNextDevelopmentPullRequest(
      context,
      host,
      journal,
      transition,
      adapter,
    );
  }
  const pr = await host.request(
    `/repos/${host.repository}/pulls/${selected.number}`,
  );
  if (
    pr.head?.sha !== selected.source.commit ||
    pr.head?.ref !== selected.branch ||
    pr.base?.ref !== selected.base ||
    pr.head?.repo?.full_name !== host.repository
  )
    throw new Error(
      "Next-development PR changed its retained source or target",
    );
  const before = await adapter.inspect(
    selected.materialization.protectedSource,
    plan.versionPolicy,
  );
  const after = await adapter.inspect(selected.source, plan.versionPolicy);
  const pending = developmentTransitionReadback(transition, {
    before,
    after,
    evidence: selected,
    createdAt: pr.created_at,
  });
  if (!pr.merged)
    return {
      state: "waiting",
      reason:
        pr.state === "open"
          ? "next-development-protected-pr-pending"
          : "next-development-pr-closed",
      pullRequest: selected.number,
      source: selected.source,
      transition: pending,
    };
  const integration = await host.integration.observe({
    intent: {
      source: { pullRequest: selected.number, targetBranch: selected.base },
    },
    generation: {
      source: { ...selected.source, configPath: plan.source.configPath },
    },
  });
  const source = await host.source.source(
    integration.mergeCommit,
    plan.source.configPath,
  );
  const readback = await adapter.inspect(source.identity, plan.versionPolicy);
  if (readback.version !== transition.target.version)
    throw new Error(
      "Protected next-development version readback differs from its declaration",
    );
  return {
    state: "success",
    reason: "protected-next-development-verified",
    transitionRoot: transition.idempotencyKey,
    integration,
    version: readback.version,
    publicationRoot: publication.release.receiptRoot,
    transition: developmentTransitionReadback(transition, {
      before,
      after: readback,
      evidence: integration,
      createdAt: pr.created_at,
      mergedAt: pr.merged_at,
    }),
  };
}

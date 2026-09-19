import { claimPipelinePublicationWorker } from "./worker.js";
import { recordDigest } from "../../release/discussion/envelope.js";
import { pipelinePlatforms } from "../../workflow/pipeline/platforms.js";
import { githubPipelineVersion } from "../../providers/github/pipeline-version.js";
import { createPipelinePublicationPlan } from "./source-plan.js";
import { preparePipelineStableQualification } from "./stable-wait.js";
import { prepareRecoveredPublication } from "./recovery-prepare.js";
import { completedPublicationRecovery } from "./context.js";
import {
  preparePipelineVersionContext,
  retainedPipelineVersionRegeneration,
} from "./version-context.js";

function publicationNextOperation(phase, existing, recovery) {
  if (phase !== "publish") return "settle";
  if (existing.length) return "apply";
  if (recovery?.mode === "prepared" || recovery?.build?.scheduled.length === 0)
    return "qualify";
  return "build";
}

export async function preparePipelinePublication(attempt, publisherSha, host) {
  const claimed = await claimPipelinePublicationWorker(
    attempt,
    publisherSha,
    host,
  );
  if (!claimed) return { operation: "wait" };
  const { session, journal, phase } = claimed;
  const observed = session.observed;
  const recovery = await prepareRecoveredPublication(
    session,
    publisherSha,
    host,
    journal,
    phase,
  );
  const plans = await journal.materials("publication/plan/");
  if (plans.length > 1)
    throw new Error("Publication has conflicting retained plans");
  const version = githubPipelineVersion(host.request, host.repository);
  let plan = plans[0];
  if (!plan) {
    plan = await createPipelinePublicationPlan(
      session,
      publisherSha,
      host,
      version,
    );
    await journal.record("publication/plan", plan);
  }
  // Native phase order admits follow-ups only after publication succeeded.
  // Later PR events must not reopen the completed publication's Alpha gate.
  const completed = await completedPublicationRecovery(
    { plan, recovery },
    journal,
  );
  if (phase === "publish" && !completed) {
    const wait = await preparePipelineStableQualification(plan, host, journal, {
      attempt,
      generation: observed.generation,
      phase,
    });
    if (wait) return { operation: "wait", wait };
  }
  if (
    !recovery &&
    (plan.publisher.workflowSha !== publisherSha ||
      plan.runtime.commit !== host.runtime.sha)
  )
    throw new Error(
      "Publication resume requires its retained publisher and runtime; use typed recovery for upgrades",
    );
  const materializations = await journal.materials(
    "publication/materialization/",
  );
  if (materializations.length > 1)
    throw new Error("Publication materialized source is ambiguous");
  let materialization = materializations[0];
  if (!materialization) {
    const regeneration = await retainedPipelineVersionRegeneration(
      journal,
      plan,
      "publication",
      host.runtime,
    );
    if (plan.versionPolicy.derived_files?.length && !regeneration) {
      const publication = {
        attempt,
        generation: observed.generation,
        plan,
        ...(recovery ? { recovery } : {}),
      };
      return {
        operation: "regenerate",
        context: await preparePipelineVersionContext(
          plan,
          "publication",
          publication,
          host,
          journal,
          publisherSha,
        ),
      };
    }
    await journal.fence();
    materialization = await version.materialize(plan, regeneration);
    const verified = await host.source.source(
      materialization.source.commit,
      plan.source.configPath,
    );
    if (recordDigest(verified.plan) !== plan.contractRoot)
      throw new Error("Version materialization altered the product contract");
    const { root, ...body } = materialization;
    materialization = { ...body, source: verified.identity };
    materialization.root = recordDigest(materialization);
    await journal.record("publication/materialization", materialization);
  }
  const admitted = await host.source.source(
    materialization.source.commit,
    plan.source.configPath,
  );
  if (
    recordDigest(admitted.identity) !== recordDigest(materialization.source) ||
    recordDigest(admitted.plan) !== plan.contractRoot
  )
    throw new Error("Retained publication source or contract drifted");
  const existing = await journal.materials("publication/qualified/");
  const context = {
    schema: "buildchain.pipeline-publication-context/v1",
    attempt,
    generation: observed.generation,
    plan,
    materialization,
    platforms: pipelinePlatforms(admitted.plan).filter(
      ({ platform }) =>
        !recovery?.build || recovery.build.scheduled.includes(platform),
    ),
    runId: host.runId,
    runAttempt: host.runAttempt,
    ...(recovery ? { recovery } : {}),
  };
  await journal.record("publication/context", context, { phase });
  return {
    operation: publicationNextOperation(phase, existing, recovery),
    context,
  };
}

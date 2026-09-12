import { recordDigest } from "../../release/discussion/envelope.js";
import { resumePipelineSession } from "../../workflow/pipeline/session.js";
import { pipelinePlatforms } from "../../workflow/pipeline/platforms.js";
import { githubPipelineVersion } from "../../providers/github/pipeline-version.js";
import { createPipelinePublicationPlan } from "./source-plan.js";
import { pipelinePublicationJournal } from "./journal.js";

export async function preparePipelinePublication(attempt, publisherSha, host) {
  const { run: execution } = await host.runs.read(host.runId, host.runAttempt);
  const definitions = (execution.referenced_workflows || []).filter((entry) =>
    entry.path?.startsWith(
      "kungfu-systems/buildchain/.github/workflows/.release-pipeline-products.yml@",
    ),
  );
  if (
    !/^[0-9a-f]{40}$/u.test(publisherSha || "") ||
    definitions.length !== 1 ||
    definitions[0].sha !== publisherSha
  )
    throw new Error(
      "Publisher definition is not the exact hosted reusable workflow",
    );
  const session = await resumePipelineSession({ ...host, attempt }, host);
  const observed = session.observed;
  if (observed.phases.merge?.payload.state !== "success")
    throw new Error(
      "Product publication requires completed protected integration",
    );
  if (observed.status === "complete") return { operation: "wait" };
  const phase = observed.missing[0];
  if (!["publish", "distribution", "next-development"].includes(phase))
    throw new Error("Attempt is not at product publication");
  const prior = observed.history
    .at(-1)
    .events.filter((event) =>
      event.payload.materials.some((material) =>
        material.id.startsWith("publication/worker/"),
      ),
    )
    .at(-1)?.payload.writer;
  if (
    prior &&
    (prior.runId !== String(host.runId) ||
      prior.runAttempt !== String(host.runAttempt))
  ) {
    const { run } = await host.runs.read(
      Number(prior.runId),
      Number(prior.runAttempt),
    );
    if (run.status !== "completed") return { operation: "wait" };
  }
  const journal = pipelinePublicationJournal(session, host);
  const claim = {
    schema: "buildchain.pipeline-publication-worker/v1",
    attempt,
    runId: host.runId,
    runAttempt: host.runAttempt,
  };
  await journal.record("publication/worker", claim, {
    phase,
    expectedHead: observed.head,
  });
  await journal.fence();
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
  if (
    plan.publisher.workflowSha !== publisherSha ||
    plan.runtime.commit !== host.runtime.sha
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
    await journal.fence();
    materialization = await version.materialize(plan);
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
    platforms: pipelinePlatforms(admitted.plan),
    runId: host.runId,
    runAttempt: host.runAttempt,
  };
  await journal.record("publication/context", context, { phase });
  return {
    operation:
      phase !== "publish" ? "settle" : existing.length ? "apply" : "build",
    context,
  };
}

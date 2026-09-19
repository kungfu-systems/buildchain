import { recordDigest } from "../../release/discussion/envelope.js";
import { qualifyRecoveryRuntime } from "../../workflow/pipeline/recovery-runtime.js";
import { githubPipelinePublicationArtifacts } from "../../providers/github/pipeline-publication-artifacts.js";
import { verifyPipelinePublicationPlan } from "./plan.js";

export function assertRecoveryProductContract(
  original,
  plan,
  source,
  materialization,
) {
  verifyPipelinePublicationPlan(original);
  if (
    original.version !== plan.version ||
    original.contractRoot !== plan.contractRoot ||
    recordDigest(original.nativeSigning || []) !==
      recordDigest(plan.nativeSigning || []) ||
    recordDigest(original.outputs) !== recordDigest(plan.outputs) ||
    recordDigest(original.source) !== recordDigest(plan.source) ||
    recordDigest(source) !== recordDigest(materialization.source)
  )
    throw new Error(
      "Recovered product build changed version, source or declared outputs",
    );
}

async function completedPlatforms(context, platforms, host) {
  const { run, jobs } = await host.runs.read(context.runId, context.runAttempt);
  if (run.status !== "completed")
    throw new Error("Publication recovery cannot reuse an active producer");
  return platforms.filter((platform) => {
    const name = `Build publication (${platform})`;
    const matches = jobs.filter(
      (job) => job.name === name || job.name.endsWith(` / ${name}`),
    );
    if (matches.length > 1)
      throw new Error("Publication recovery product job is ambiguous");
    return (
      matches[0]?.status === "completed" && matches[0]?.conclusion === "success"
    );
  });
}

export async function planRecoveryPublicationBuild(
  session,
  plan,
  materialization,
  materials,
  host,
) {
  const declared = [
    ...new Set(plan.outputs.map(({ platform }) => platform)),
  ].sort();
  const contexts = [
    ...new Map(
      materials
        .filter((item) =>
          /^publication\/(?:context|predecessor-context)\//u.test(item.id),
        )
        .map(({ value }) => [recordDigest(value), value]),
    ).values(),
  ].reverse();
  if (contexts.length > 100)
    throw new Error("Publication producer history exceeds its bound");
  const remaining = new Set(declared),
    segments = [],
    comparisons = [];
  const provider = githubPipelinePublicationArtifacts(host);
  for (const context of contexts) {
    if (!remaining.size) break;
    const owner = session.observed.history.find(
      (item) => item.identity.id === context.attempt,
    );
    if (
      !owner ||
      owner.generation.id !== session.observed.generation ||
      context.schema !== "buildchain.pipeline-publication-context/v1"
    )
      throw new Error(
        "Publication producer has no canonical same-generation attempt",
      );
    assertRecoveryProductContract(
      context.plan,
      plan,
      context.materialization.source,
      materialization,
    );
    const producerRuntime = owner.events[0].runtime;
    if (context.plan.runtime.commit !== producerRuntime.sha)
      throw new Error(
        "Publication product producer differs from its admitted runtime",
      );
    const comparison = await qualifyRecoveryRuntime(
      producerRuntime,
      host.runtime,
      "publication-build",
      host.request,
    );
    comparisons.push(comparison);
    if (!comparison.compatible) continue;
    const candidates = [...remaining].filter(
      (platform) =>
        !plan.nativeSigning?.some((rule) => rule.platform === platform) ||
        context.plan.runtime.commit === host.runtime.sha,
    );
    if (!candidates.length) continue;
    const platforms = await completedPlatforms(context, candidates, host);
    if (!platforms.length) continue;
    const { build } = await provider.buildReadback(context, platforms);
    segments.push({
      plan: context.plan,
      materialization: context.materialization,
      runtime: producerRuntime,
      build,
    });
    platforms.forEach((platform) => remaining.delete(platform));
  }
  const body = {
    schema: "buildchain.pipeline-recovery-publication-build/v1",
    source: materialization.source,
    predecessorPlanRoot: plan.root,
    segments,
    comparisons,
    scheduled: [...remaining].sort(),
    reason: contexts.length
      ? "Requalify exact successful producer artifacts; execute only missing or explicitly changed implementations"
      : "No product execution was retained; execute the declared publication platforms",
  };
  return { ...body, root: recordDigest(body) };
}

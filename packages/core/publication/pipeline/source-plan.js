import { planPipelinePublication } from "./plan.js";

export async function createPipelinePublicationPlan(
  session,
  publisherSha,
  host,
  version,
) {
  const observed = session.observed;
  const attempt = observed.attempt;
  const integration = await host.integration.observe({
    ...observed.history.at(-1),
    intent: session.intent,
  });
  const source = await host.source.source(
    integration.mergeCommit,
    observed.history.at(-1).generation.source.configPath,
  );
  const route = source.plan.channels.find(
    (entry) =>
      entry.to === session.intent.source.targetBranch &&
      entry.operation !== "develop",
  );
  if (!route)
    throw new Error(
      "Protected source does not declare this publication channel",
    );
  const input = await version.inspect(source.identity, source.plan.version);
  const runtimeCommit = await host.request(
    `/repos/${host.runtime.repository}/git/commits/${host.runtime.sha}`,
  );
  if (
    runtimeCommit.sha !== host.runtime.sha ||
    !/^[0-9a-f]{40}$/u.test(runtimeCommit.tree?.sha || "")
  )
    throw new Error("Publication runtime has no exact source tree");
  const definition = {
    repository: "kungfu-systems/buildchain",
    workflow: ".github/workflows/.release-pipeline-products.yml",
    workflowSha: publisherSha,
    job: "apply",
  };
  const parameters = {
    attempt,
    generation: observed.generation,
    source: source.identity,
    intentSource: observed.history.at(-1).generation.source,
    runtime: {
      repository: host.runtime.repository,
      commit: runtimeCommit.sha,
      tree: runtimeCommit.tree.sha,
    },
    publisher: definition,
    contract: source.plan,
    route,
    version: input.version,
    sourceTimestamp: input.sourceTimestamp,
  };
  let plan = planPipelinePublication(parameters);
  const tag = await host.request(
    `/repos/${host.repository}/git/ref/tags/${encodeURIComponent(plan.tag)}`,
    { allow404: true },
  );
  const channel = `v${plan.version.split(".")[0]}${plan.channel === "alpha" ? "-alpha" : ""}`;
  const previous = await host.request(
    `/repos/${host.repository}/git/ref/tags/${channel}`,
    { allow404: true },
  );
  if (
    previous &&
    (previous.object?.type !== "commit" ||
      !/^[0-9a-f]{40}$/u.test(previous.object.sha))
  )
    throw new Error(
      "Publication channel requires an exact lightweight commit ref",
    );
  plan = planPipelinePublication({
    ...parameters,
    expectedTagSha: tag?.object?.sha || null,
    previousChannelCommit: previous?.object?.sha || null,
  });
  return plan;
}

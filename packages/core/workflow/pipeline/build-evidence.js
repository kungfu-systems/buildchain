import { recordDigest } from "../../release/discussion/envelope.js";
import {
  PIPELINE_BUILD_QUALIFICATION,
  verifyPipelineBuildQualification,
} from "./build-qualification.js";
import { pipelinePlatforms } from "./platforms.js";

// The archive reference is already validated against the current attempt. A
// build result is still re-read from the provider before it can admit delivery.
export async function pipelineBuildEvidence(session, host) {
  const observed = await session.journal.read();
  const current = observed.history.at(-1);
  const phase = current.phases.build;
  if (phase?.payload.state !== "success") return null;
  const references = phase.payload.materials.filter(
    (material) =>
      material.id.startsWith("build/provider-") ||
      material.id.startsWith("build/qualified-"),
  );
  if (references.length !== 1)
    throw new Error("Pipeline build requires one retained provider receipt");
  const retained = await host.materialStore(session).read(references[0]);
  let { run } = await host.runs.read(retained.runId, retained.runAttempt);
  if (run.status !== "completed" && run.id !== host.runId)
    run = await host.runs.completed(retained.runId, retained.runAttempt);
  if (retained.schema === PIPELINE_BUILD_QUALIFICATION) {
    const source = await host.source.source(
      current.generation.source.commit,
      current.generation.source.configPath,
    );
    if (
      recordDigest(source.identity) !== recordDigest(current.generation.source)
    )
      throw new Error("Recovered build source changed during qualification");
    await verifyPipelineBuildQualification(
      retained,
      source.identity,
      pipelinePlatforms(source.plan).map(({ platform }) => platform),
      host.runs,
    );
  } else {
    const verified = await host.runs.build(
      retained.runId,
      retained.runAttempt,
      current.generation.source,
      retained.jobs.map(
        (job) => job.name.match(/Build product \(([^)]+)\)$/u)?.[1],
      ),
    );
    if (recordDigest(verified) !== recordDigest(retained))
      throw new Error("Retained product build provider result changed");
  }
  return {
    run,
    readback: retained,
    sourceHead: current.generation.source.commit,
    outcome: retained.outcome,
  };
}

export async function publishPipelineBuildCheck(
  context,
  readback,
  request,
  repository,
) {
  if (
    context.source.repository !== repository ||
    recordDigest(context.source) !== recordDigest(readback.source) ||
    context.runId !== readback.runId ||
    context.runAttempt !== readback.runAttempt
  )
    throw new Error(
      "Product check source differs from independently verified build",
    );
  const externalId = `buildchain:${context.attempt}:${context.runId}:${context.runAttempt}`;
  return request(`/repos/${repository}/check-runs`, {
    method: "POST",
    body: {
      name: "check",
      head_sha: context.source.commit,
      external_id: externalId,
      status: "completed",
      conclusion: readback.outcome === "success" ? "success" : "failure",
      output: {
        title: "Buildchain product verification",
        summary: `Exact product jobs: ${readback.root}\nAttempt: ${context.attempt}`,
      },
      details_url: `https://github.com/${repository}/actions/runs/${context.runId}/attempts/${context.runAttempt}`,
    },
  });
}

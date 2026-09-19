import { resumePipelineSession } from "../../workflow/pipeline/session.js";
import { pipelinePublicationJournal } from "./journal.js";
import { retainedPipelineStableWait } from "./stable-wait.js";

export async function claimPipelinePublicationWorker(
  attempt,
  publisherSha,
  host,
) {
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
  if (observed.status === "complete") return null;
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
    // A time-only wait releases publication ownership before its outer run ends.
    // The next worker still claims the exact native head under the publication lock.
    if (
      run.status !== "completed" &&
      !(await retainedPipelineStableWait(observed, host))
    )
      return null;
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
  return { session, journal, phase };
}

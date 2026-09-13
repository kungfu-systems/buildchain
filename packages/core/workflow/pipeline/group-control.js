import { recordDigest } from "../../release/discussion/envelope.js";
import { object } from "../../consumer/contract/shape.js";

export async function recordPipelineGroup(context, host) {
  object(context, [
    "schema",
    "source",
    "branch",
    "baseCommit",
    "runId",
    "runAttempt",
    "platforms",
  ]);
  if (
    context.schema !== "buildchain.pipeline-group-build-context/v1" ||
    context.runId !== host.runId ||
    context.runAttempt !== host.runAttempt
  )
    throw new Error("Merge group callback execution drift");
  const { run } = await host.runs.read(context.runId, context.runAttempt);
  if (run.event !== "merge_group" || run.head_sha !== context.source.commit)
    throw new Error("Merge group build is not the exact provider execution");
  const queue = await host.queue.getMergeQueueState(context.branch);
  if (
    !queue.enabled ||
    !queue.entries.some(
      (entry) =>
        entry.headSha === context.source.commit &&
        entry.baseSha === context.baseCommit,
    )
  )
    throw new Error("Merge group was removed or changed before verification");
  const readback = await host.runs.build(
    context.runId,
    context.runAttempt,
    context.source,
    context.platforms.map((platform) => platform.platform),
  );
  await host.request(`/repos/${host.repository}/check-runs`, {
    method: "POST",
    body: {
      name: "check",
      head_sha: context.source.commit,
      external_id: `buildchain:merge-group:${recordDigest(context)}`,
      status: "completed",
      conclusion: readback.outcome,
      output: {
        title: "Buildchain exact merge-group verification",
        summary: `Provider product jobs: ${readback.root}`,
      },
    },
  });
  if (readback.outcome !== "success")
    throw new Error("Merge-group products failed verification");
  return readback;
}

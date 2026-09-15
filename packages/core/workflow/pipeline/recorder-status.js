import { createHash } from "node:crypto";
import { parse } from "yaml";
import { publishPipelineBuildStatus } from "./guard-build.js";
import { recordDigest } from "../../release/discussion/envelope.js";

// A repaired runtime may execute through an older immutable published entry.
// Read the real recorder job's permission, rather than assuming the runtime's
// current workflow is the one GitHub scheduled. API failures are never ignored.
export async function publishRecorderStatus(context, readback, host) {
  const { root, ...body } = readback;
  if (
    context.runId !== host.runId ||
    context.runAttempt !== host.runAttempt ||
    readback.runId !== host.runId ||
    readback.runAttempt !== host.runAttempt ||
    recordDigest(context.source) !== recordDigest(readback.source) ||
    root !== recordDigest(body)
  )
    throw new Error("Recorder status changed its current source or execution");
  const { run } = await host.runs.read(host.runId, host.runAttempt);
  const path = ".github/workflows/.ops-pipeline-execute.yml";
  const entries = (run.referenced_workflows || []).filter((entry) =>
    entry.path?.startsWith(`kungfu-systems/buildchain/${path}@`),
  );
  if (entries.length !== 1 || !/^[0-9a-f]{40}$/u.test(entries[0].sha || ""))
    throw new Error("Recorder has no exact published execution workflow");
  const file = await host.request(
    `/repos/kungfu-systems/buildchain/contents/${path}?ref=${entries[0].sha}`,
  );
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > 64000 ||
    typeof file.content !== "string" ||
    file.content.length > 128000
  )
    throw new Error(
      "Recorder execution workflow is unavailable or exceeds its bound",
    );
  const bytes = Buffer.from(file.content, "base64");
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (bytes.length !== file.size || blob !== file.sha)
    throw new Error("Recorder execution workflow bytes changed");
  const job = parse(bytes.toString("utf8")).jobs?.["record-build"];
  if (job?.name !== "Record product build")
    throw new Error("Recorder execution workflow changed its job identity");
  if (job.permissions?.statuses !== "write") return { published: false };
  if (readback.outcome !== "success") return { published: false };
  await publishPipelineBuildStatus(
    {
      "expected-head-sha": context.source.commit,
      "source-workflow-run-id": String(readback.runId),
    },
    {
      sourceHead: context.source.commit,
      outcome: readback.outcome,
      run: { id: readback.runId, run_attempt: readback.runAttempt },
      readback,
    },
    host.request,
    host.repository,
  );
  return { published: true };
}

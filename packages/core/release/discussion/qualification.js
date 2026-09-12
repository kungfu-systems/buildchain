import { discussionStatus } from "./reader.js";
import fs from "node:fs";
import path from "node:path";
import { releaseCheckpoints } from "./checkpoints.js";
import { openReleaseSession, selectedRecordRuntime } from "./session.js";
import { decodeRecord } from "./envelope.js";
import { discussionTransport } from "../../providers/github/discussions/transport.js";
import { releaseDiscussionStore } from "./store.js";

// The same public Bootstrap entry exposes transport qualification and diagnosis
// to any consumer; this is not a Buildchain-only writer or runtime bootstrap.
export async function executeReleaseDiscussion(request, _admission, context) {
  const payload = request.payload;
  if (
    payload?.schema !== "buildchain.release-discussion-request/v1" ||
    !["inspect", "qualify"].includes(payload.operation)
  )
    throw new Error("Unsupported release Discussion operation");
  const allowed =
    payload.operation === "inspect"
      ? ["schema", "operation", "discussionId"]
      : [
          "schema",
          "operation",
          "key",
          "outcome",
          "discussionId",
          "predecessor",
          "verifyMaterials",
        ];
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    throw new Error("Unknown release Discussion request field");
  const repository = request.consumer.repository;
  const transport = discussionTransport(context.octokit.graphql);
  if (payload.operation === "inspect") {
    const discussion = await transport.get(payload.discussionId);
    const intent = decodeRecord(discussion.body);
    if (intent?.repository !== repository)
      throw new Error("Discussion is outside the consumer repository");
    return discussionStatus(
      await releaseDiscussionStore(transport).read({
        discussion,
        intent,
        writerId: discussion.author.id,
      }),
    );
  }
  if (request.capability.permissions?.discussions !== "write")
    throw new Error(
      "Discussion qualification requires declared discussions: write",
    );
  if (
    !/^[a-zA-Z0-9._-]{1,80}$/u.test(payload.key || "") ||
    !["success", "failure"].includes(payload.outcome)
  )
    throw new Error("Invalid Discussion qualification request");
  const journal = await openReleaseSession({
    graphql: context.octokit.graphql,
    repository,
    key: `qualification:${payload.key}`,
    source: { qualification: payload.key },
    expectedNodes: ["transport", "recovery"],
    runtime: selectedRecordRuntime({
      BUILDCHAIN_RUNTIME_SELECTION: context.runtimeSelection,
      BUILDCHAIN_RUNTIME_ROOT: context.runtimeRoot,
    }),
    attempt: `${context.runId}:${context.runAttempt || "1"}`,
    discussionId: payload.discussionId || "",
    predecessor: payload.predecessor || "",
  });
  await journal.observe("transport", async () => {
    if (payload.verifyMaterials === true) {
      if (request.capability.permissions?.contents !== "write")
        throw new Error(
          "Material qualification requires declared contents: write",
        );
      const retained = releaseCheckpoints({
        session: journal.session,
        store: journal.store,
        octokit: context.octokit,
      });
      const probe = await retained.checkpoint("transport", {
        schema: "buildchain.material-qualification/v1",
        value: payload.key,
      });
      if ((await retained.readCheckpoint(probe)).value !== payload.key)
        throw new Error("Small material qualification readback mismatch");
      const reader = await retained.materials.put(
        fs.readFileSync(
          path.join(context.runtimeRoot, "dist/readers/release-discussion.cjs"),
        ),
      );
      const checkpoint = await retained.checkpoint("transport", {
        schema: "buildchain.material-qualification/v1",
        reader,
        value: payload.key,
      });
      const readback = await retained.readCheckpoint(checkpoint);
      if (readback.value !== payload.key)
        throw new Error("Material qualification readback mismatch");
    }
  });
  await journal.record("recovery", payload.outcome);
  const state = await journal.read();
  if (payload.outcome === "failure")
    throw Object.assign(
      new Error(
        "Injected Discussion qualification failure after durable recording",
      ),
      { code: "discussion-qualification-injected-failure" },
    );
  return {
    schema: "buildchain.release-discussion-qualification/v1",
    discussionId: journal.session.discussion.id,
    discussionUrl: journal.session.discussion.url,
    status: state.status,
    handoff: state.handoff,
    attempt: state.attempt,
    runtime: journal.session.runtime,
  };
}

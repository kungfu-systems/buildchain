import test from "node:test";
import assert from "node:assert/strict";
import { atomicAttemptJournal } from "../packages/core/workflow/attempt/journal.js";
import { pipelineProgress } from "../packages/core/workflow/pipeline/progress.js";
import { identities, runtime } from "./helpers/business-attempt.mjs";

test("pipeline progress preserves failed history and rejects late results after recovery", async () => {
  const f = identities();
  let saved;
  const journal = atomicAttemptJournal(
    {
      read: async () => saved,
      append: async ({ snapshot, expectedCommit }) => {
        assert.equal(expectedCommit, saved?.commit || "");
        saved = { commit: `${Number(expectedCommit || 0) + 1}`, snapshot };
      },
    },
    f.intent,
  );
  const controller = pipelineProgress(journal, {
    intent: f.intent,
    writer: f.writer,
    runtime,
  });
  const first = await controller.open(f.source, f.generation.baseCommit);
  assert.equal(
    (await controller.open(f.source, f.generation.baseCommit)).attempt,
    first.attempt,
  );
  const admission = {
    attempt: first.attempt,
    phase: "admission",
    state: "success",
    eventKey: "admitted",
  };
  await controller.progress(admission);
  await controller.progress(admission);
  await assert.rejects(
    controller.progress({ ...admission, state: "failure" }),
    /changed its meaning/,
  );
  await controller.requestStop("pull-request-closed");
  await assert.rejects(
    controller.open(
      { ...f.source, commit: "f".repeat(40) },
      f.generation.baseCommit,
    ),
    /terminal state/,
  );
  await controller.progress({
    attempt: first.attempt,
    phase: "build",
    state: "cancelled",
    reason: "provider proved worker stopped",
    eventKey: "cancelled",
  });
  const second = await controller.open(
    { ...f.source, commit: "f".repeat(40) },
    f.generation.baseCommit,
  );
  assert.notEqual(first.attempt, second.attempt);
  assert.equal(second.history.length, 2);
  assert.equal(second.history[0].phases.build.payload.state, "cancelled");
  assert.deepEqual(second.missing, f.intent.expectedNodes);
  await assert.rejects(
    controller.progress({ ...admission, eventKey: "late" }),
    /superseded attempt/,
  );
});

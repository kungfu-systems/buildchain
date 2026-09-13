import test from "node:test";
import assert from "node:assert/strict";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { readBusinessAttempt } from "../packages/core/workflow/attempt/reader.js";
import {
  pipelineHeartbeat,
  STOP_REQUESTED,
} from "../packages/core/workflow/pipeline/fence.js";
import { identities } from "./helpers/business-attempt.mjs";

test("controller heartbeat observes stop requests without releasing or transferring Warrant", async () => {
  const f = identities();
  const root = f.event();
  const admitted = f.event(root, { state: "success" });
  const running = f.event(admitted, { phase: "build", state: "running" });
  let records = [root, admitted, running],
    beats = 0;
  const journal = {
    read: async () => readBusinessAttempt({ intent: f.intent, records }),
  };
  const expected = {
    intent: f.intent.id,
    attempt: f.attempt.id,
    generation: f.generation.id,
    sourceRoot: recordDigest(f.source),
  };
  const heartbeat = pipelineHeartbeat(journal, expected, async () => {
    beats++;
  });
  await heartbeat();
  records = [
    ...records,
    f.event(running, {
      phase: "build",
      state: "waiting",
      reason: `${STOP_REQUESTED}pull-request-closed`,
    }),
  ];
  await assert.rejects(heartbeat(), /requested stop/);
  assert.equal(beats, 1);
});

test("stop racing the Warrant heartbeat is checked again before returning", async () => {
  const f = identities();
  const root = f.event();
  let records = [root];
  const heartbeat = pipelineHeartbeat(
    { read: async () => readBusinessAttempt({ intent: f.intent, records }) },
    {
      intent: f.intent.id,
      attempt: f.attempt.id,
      generation: f.generation.id,
      sourceRoot: recordDigest(f.source),
    },
    async () => {
      records.push(
        f.event(root, {
          state: "waiting",
          reason: `${STOP_REQUESTED}source-updated`,
        }),
      );
    },
  );
  await assert.rejects(heartbeat(), /requested stop/);
});

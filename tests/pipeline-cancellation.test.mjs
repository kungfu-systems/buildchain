import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelPipelineCandidate,
  recoverPipelineCancellation,
} from "../packages/core/workflow/pipeline/cancellation.js";
import { cancellationFixture } from "./helpers/pipeline-cancellation.mjs";

test("real Warrant queued cancellation preserves a different active candidate", async () => {
  const f = await cancellationFixture();
  const active = structuredClone(f.queue().activeWarrant);
  const result = await cancelPipelineCandidate(await f.observe(), f.ports);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(f.queue().activeWarrant, active);
  assert.equal(
    f.queue().candidates.find((c) => c.pullRequestNumber === 23).status,
    "cancelled",
  );
  assert.equal((await f.journal.read()).status, "cancelled");
  assert.equal(f.writes(), 1);
});

test("lost terminal mutation response recovers from retained pending evidence without a second write", async () => {
  const f = await cancellationFixture();
  f.lose();
  await assert.rejects(
    cancelPipelineCandidate(await f.observe(), f.ports),
    /Response lost/,
  );
  assert.equal(f.writes(), 1);
  assert.equal((await f.journal.read()).status, "waiting");
  const fresh = await f.observe();
  assert.equal(fresh.decision.operation, "record-cancellation");
  const result = await recoverPipelineCancellation(fresh, f.ports);
  assert.equal(result.status, "cancelled");
  assert.equal(f.writes(), 1);
  assert.equal((await f.journal.read()).status, "cancelled");
});

test("active worker stop is required before Warrant settlement and successor wake", async () => {
  const f = await cancellationFixture({ active: true });
  const result = await cancelPipelineCandidate(await f.observe(), f.ports);
  assert.equal(result.status, "cancelled");
  assert.equal(f.queue().activeWarrant, null);
  assert.equal(f.wakes(), 1);
  const running = await cancellationFixture({ active: true });
  running.running();
  assert.equal(
    (await cancelPipelineCandidate(await running.observe(), running.ports))
      .status,
    "waiting",
  );
  assert.equal(running.writes(), 0);
  assert.ok(running.queue().activeWarrant);
});

test("interrupted successor dispatch retries without rewriting cancelled history", async () => {
  const f = await cancellationFixture({ active: true });
  const ports = {
    ...f.ports,
    wake: async () => {
      throw new Error("Dispatch unavailable");
    },
  };
  await assert.rejects(
    cancelPipelineCandidate(await f.observe(), ports),
    /Dispatch unavailable/,
  );
  const before = await f.journal.read();
  assert.equal(before.status, "cancelled");
  await recoverPipelineCancellation(await f.observe(), f.ports);
  assert.equal((await f.journal.read()).head, before.head);
  assert.equal(f.writes(), 1);
  assert.equal(f.wakes(), 1);
});

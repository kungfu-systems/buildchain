import test from "node:test";
import assert from "node:assert/strict";
import {
  recoveryBuildFixture,
  productReadback,
} from "./helpers/pipeline-recovery.mjs";
import {
  beginRecoveryBuild,
  recordRecoveryBuild,
} from "../packages/core/workflow/pipeline/recovery-build-control.js";

test("recovery executes only the failed platform and retains an idempotent qualified aggregate", async () => {
  const f = await recoveryBuildFixture();
  const context = await beginRecoveryBuild(f.session, f.host);
  assert.deepEqual(
    context.platforms.map((item) => item.platform),
    ["windows-x64"],
  );
  f.readbacks.set(300, productReadback(300, f.f.source, ["windows-x64"]));
  const before = f.snapshot().records.length;
  await assert.rejects(
    recordRecoveryBuild({ ...context, platforms: [] }, f.host),
    /reserved work/,
  );
  assert.equal(f.snapshot().records.length, before);
  assert.equal((await recordRecoveryBuild(context, f.host)).outcome, "success");
  const references = f.observed().phases.build.payload.materials;
  const retained = await f.host.materialStore(f.session).read(references[0]);
  assert.equal(retained.runId, 300);
  assert.deepEqual(
    retained.segments.map((item) => item.platforms),
    [["linux-x64"], ["windows-x64"]],
  );
  assert.deepEqual(retained.segments[0].readback, f.old);
  assert.equal(retained.segments[0].readback.outcome, "failure");
  const complete = structuredClone(f.snapshot().records);
  await recordRecoveryBuild(context, f.host);
  assert.deepEqual(f.snapshot().records, complete);
  assert(
    f.reads
      .filter((item) => item.id === 300)
      .every((item) => item.platforms.join() === "windows-x64"),
  );
});

test("all completed platforms are requalified without a product rebuild", async () => {
  const f = await recoveryBuildFixture({ failed: [] });
  const context = await beginRecoveryBuild(f.session, f.host);
  assert.deepEqual(context.platforms, []);
  assert.equal((await recordRecoveryBuild(context, f.host)).outcome, "success");
  assert(!f.reads.some((item) => item.id === 300));
  const result = await f.host
    .materialStore(f.session)
    .read(f.observed().phases.build.payload.materials[0]);
  assert.equal(result.runId, 300);
  assert.equal(result.segments[0].readback.runId, 100);
});

test("changed runtime code schedules affected platforms explicitly and drifted provider evidence cannot advance recovery", async () => {
  const changed = await recoveryBuildFixture({ changedRuntime: true });
  assert.match(changed.build.reason, /Changed stage implementation/);
  assert.equal(changed.build.scheduled.length, 2);
  assert.deepEqual(changed.build.segments, []);
  const f = await recoveryBuildFixture();
  const context = await beginRecoveryBuild(f.session, f.host);
  f.readbacks.set(
    100,
    productReadback(
      100,
      f.f.source,
      ["linux-x64", "windows-x64"],
      ["linux-x64"],
    ),
  );
  const before = structuredClone(f.snapshot().records);
  await assert.rejects(
    recordRecoveryBuild(context, f.host),
    /execution requalification/,
  );
  assert.deepEqual(f.snapshot().records, before);
  await assert.rejects(
    recordRecoveryBuild({ ...context, runId: 999 }, f.host),
    /another execution/,
  );
});

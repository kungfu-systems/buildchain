import test from "node:test";
import assert from "node:assert/strict";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { productReadback } from "./helpers/pipeline-recovery.mjs";
import { resumePipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { qualifyRecoveryBuild } from "../packages/core/workflow/pipeline/recovery-build.js";
import { terminateRecoveryPredecessor } from "../packages/core/workflow/pipeline/recovery-transition.js";

test("cancellation before recording requalifies completed platform jobs and terminates only the abandoned phase", async () => {
  const f = pipelineHostFixture();
  f.admission.plan.products[0].platforms = ["linux-x64", "windows-x64"];
  const initial = await f.event();
  const session = await resumePipelineSession(
    { ...f.host, attempt: initial.context.attempt },
    f.host,
  );
  const value = productReadback(
    100,
    f.f.source,
    ["linux-x64", "windows-x64"],
    ["windows-x64"],
  );
  const run = {
    id: 100,
    run_attempt: 1,
    status: "completed",
    conclusion: "cancelled",
    repository: { full_name: f.host.repository },
    head_repository: { full_name: f.host.repository },
  };
  f.host.runs.read = async () => ({ run, jobs: value.jobs });
  f.host.runs.build = async (id, attempt, source, platforms) =>
    productReadback(id, source, platforms);
  f.host.request = async (url) =>
    url.includes(".wasm") ? null : { type: "file", sha: "9".repeat(40) };
  const build = await qualifyRecoveryBuild(
    session,
    { identity: f.f.source, plan: f.admission.plan },
    f.host,
  );
  assert.deepEqual(build.segments[0].platforms, ["linux-x64"]);
  assert.deepEqual(
    build.scheduled.map((item) => item.platform),
    ["windows-x64"],
  );
  const before = structuredClone(f.snapshot().records);
  const terminated = await terminateRecoveryPredecessor(
    session,
    { terminal: true, predecessor: initial.context.attempt, runs: [run] },
    null,
    f.host,
  );
  assert.equal(terminated.observed.status, "cancelled");
  assert.equal(terminated.observed.phases.admission.payload.state, "success");
  assert.deepEqual(f.snapshot().records.slice(0, before.length), before);
  assert.equal(f.snapshot().records.length, before.length + 1);
  await assert.rejects(
    terminateRecoveryPredecessor(session, { terminal: true }, null, f.host),
    /advanced/,
  );
});

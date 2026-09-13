import test from "node:test";
import assert from "node:assert/strict";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { recordPipelineBuild } from "../packages/core/workflow/pipeline/build-control.js";
import { pipelineRuntimeSource } from "../packages/core/workflow/pipeline/runtime-source.js";

test("normal controller binds product build, independently records it, and waits for real review before delivery", async () => {
  const f = pipelineHostFixture();
  const first = await f.event();
  assert.equal(first.operation, "build");
  assert.equal(f.observed().phases.build.payload.state, "running");
  f.build(first.context);
  await recordPipelineBuild(first.context, f.host);
  assert.equal(f.observed().phases.build.payload.state, "success");
  assert.equal(
    f.effects.find((effect) => effect.name === "check").head_sha,
    first.context.source.commit,
  );
  assert.equal((await f.wake()).reason, "source-workflow-still-running");
  f.complete();
  f.host.runId = 101;
  assert.equal((await f.wake()).reason, "protected-source-gates-pending");
  f.admission.live.ready = true;
  f.host.policy.observe = async () => ({
    review: true,
    checksPassing: true,
    root: `sha256:${"a".repeat(64)}`,
  });
  const ready = await f.wake();
  assert.equal(ready.operation, "deliver");
  assert.equal(ready.request["pipeline-attempt"], first.context.attempt);
  assert.equal(f.observed().phases.warrant.payload.state, "running");
});

test("source update ends the old attempt, opens a successor and reselects its runtime before building", async () => {
  const f = pipelineHostFixture();
  const first = await f.event();
  f.admission.live.source = {
    ...f.admission.live.source,
    commit: "9".repeat(40),
  };
  f.admission.live.observedHead = f.admission.live.source.commit;
  const stopped = await f.event("synchronize");
  assert.equal(stopped.reason, "source-generation-changed");
  assert.equal(f.observed().status, "superseded");
  const selected = await f.wake();
  assert.equal(selected.reason, "source-generation-runtime-selection-required");
  const next = f.observed().attempt;
  assert.notEqual(next, first.context.attempt);
  assert.equal(f.observed().history.length, 2);
  f.host.selection.source.sha = f.admission.live.source.commit;
  assert.equal((await f.wake()).operation, "build");
  f.build(first.context);
  await assert.rejects(
    recordPipelineBuild(first.context, f.host),
    /historical|Historical|another|changed/,
  );
  await assert.rejects(
    pipelineRuntimeSource(
      first.context.attempt,
      f.host.repository,
      "test",
      f.host.index,
    ),
    /Historical/,
  );
  assert.equal(
    (await pipelineRuntimeSource(next, f.host.repository, "test", f.host.index))
      .sha,
    f.admission.live.source.commit,
  );
});

test("duplicate normal events do not start a second live product execution", async () => {
  const f = pipelineHostFixture();
  await f.event();
  const before = f.observed().head;
  f.host.runId = 101;
  f.host.writer = { ...f.host.writer, runId: "101", jobId: "13" };
  assert.equal(
    (await f.event("labeled")).reason,
    "existing-build-execution-retained",
  );
  assert.equal(f.observed().head, before);
});

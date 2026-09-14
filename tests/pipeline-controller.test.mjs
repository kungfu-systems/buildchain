import test from "node:test";
import assert from "node:assert/strict";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { recordPipelineBuild } from "../packages/core/workflow/pipeline/build-control.js";
import { resumePipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { pipelineRuntimeSource } from "../packages/core/workflow/pipeline/runtime-source.js";
import { controlPipeline } from "../packages/core/workflow/pipeline/controller.js";
import { observePipelineDelivery } from "../packages/core/workflow/pipeline/delivery-control.js";
import { pipelineCandidateRoot } from "../packages/core/workflow/pipeline/reconcile.js";

test("attempt wake reads queue removal while a stale dequeue webhook cannot cancel current work", async () => {
  const f = pipelineHostFixture();
  const first = await f.event();
  const session = await resumePipelineSession(
    { ...f.host, attempt: first.context.attempt },
    f.host,
  );
  const current = { ...f.observed().history.at(-1), intent: session.intent };
  const queue = await f.host.delivery().read();
  queue.candidates.push({
    candidateId: "owned-candidate",
    pullRequestNumber: 23,
    sourceHead: current.generation.source.commit,
    sourceRoot: pipelineCandidateRoot(current),
    status: "queued",
  });
  const delivery = { read: async () => queue };
  f.host.eventAction = "buildchain-attempt-wake";
  f.host.queueExit = async () => ({ id: "provider-removal" });
  const inputs = { "config-path": f.f.source.configPath };
  const removed = await observePipelineDelivery(
    session,
    inputs,
    f.host,
    delivery,
  );
  assert.equal(removed.decision.operation, "cancel-queued");
  assert.equal(removed.decision.reason, "pull-request-dequeued");
  assert.equal(removed.live.queueExit.id, "provider-removal");
  f.host.eventAction = "dequeued";
  f.host.queueExit = async () => null;
  const currentQueue = await observePipelineDelivery(
    session,
    inputs,
    f.host,
    delivery,
  );
  assert.equal(currentQueue.live.dequeued, false);
  assert.notEqual(currentQueue.decision.operation, "cancel-queued");
});

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

test("concurrent close notifications retain one immutable terminal result", async () => {
  const f = pipelineHostFixture();
  const first = await f.event();
  f.build(first.context);
  await recordPipelineBuild(first.context, f.host);
  f.complete();
  f.admission.live.state = "closed";
  const results = await Promise.all(
    ["pull_request", "pull_request_target"].map((name, index) =>
      controlPipeline(
        name,
        {
          repository: { full_name: f.host.repository },
          action: "closed",
          pull_request: { number: 23 },
        },
        { "config-path": f.f.source.configPath },
        {
          ...f.host,
          runId: 101 + index,
          writer: { ...f.host.writer, runId: String(101 + index) },
        },
      ),
    ),
  );
  assert.ok(results.every((result) => result.operation === "wait"));
  const observed = f.observed();
  assert.equal(observed.status, "superseded");
  assert.equal(observed.phases.review.payload.reason, "pull-request-closed");
  assert.equal(
    observed.history.at(-1).events.filter((event) => event.node === "review")
      .length,
    1,
  );
  const history = JSON.stringify(observed.history);
  await f.event("closed");
  assert.equal(JSON.stringify(f.observed().history), history);
});

test("a failed close write without terminal readback remains an error", async () => {
  const f = pipelineHostFixture();
  await f.event();
  f.admission.live.state = "closed";
  f.host.provider.append = async () => {
    throw new Error("provider unavailable");
  };
  await assert.rejects(f.event("closed"), /provider unavailable/);
  assert.equal(f.observed().status, "running");
});

test("a failed product build retains its history and admits a changed source without retrying unchanged bytes", async () => {
  const f = pipelineHostFixture();
  const first = await f.event();
  const session = await resumePipelineSession(
    { ...f.host, attempt: first.context.attempt },
    f.host,
  );
  await session.progress.progress({
    attempt: first.context.attempt,
    phase: "build",
    state: "failure",
    reason: "missing-product-toolchain",
    eventKey: "build-failed",
  });
  f.complete();
  const failed = JSON.stringify(f.observed().history[0]);
  for (const action of ["labeled", "reopened", "synchronize"]) {
    assert.equal((await f.event(action)).reason, "attempt-failure");
    assert.equal(f.observed().attempt, first.context.attempt);
  }
  f.admission.live.source = {
    ...f.admission.live.source,
    commit: "9".repeat(40),
  };
  f.admission.live.observedHead = f.admission.live.source.commit;
  assert.equal(
    (await f.event("synchronize")).reason,
    "source-generation-runtime-selection-required",
  );
  assert.notEqual(f.observed().attempt, first.context.attempt);
  assert.equal(JSON.stringify(f.observed().history[0]), failed);
  f.host.selection.source.sha = f.admission.live.source.commit;
  assert.equal((await f.wake()).operation, "build");
});

test("a queued delivery owns its coordinates before Warrant acquisition and terminal failure permits a new execution", async () => {
  const f = pipelineHostFixture();
  const first = await f.event();
  f.build(first.context);
  await recordPipelineBuild(first.context, f.host);
  f.complete();
  f.admission.live.ready = true;
  f.host.policy.observe = async () => ({
    review: true,
    checksPassing: true,
    root: `sha256:${"a".repeat(64)}`,
  });
  f.host.runId = 101;
  assert.equal((await f.wake()).operation, "deliver");
  const retained = structuredClone(f.snapshot());
  assert.equal((await f.host.delivery().read()).activeWarrant, null);
  const read = f.host.runs.read;
  let ownerStatus = "queued",
    ownerAttempt = 1;
  f.host.runs.read = async (id, attempt) =>
    id === 101
      ? {
          run: {
            id,
            run_attempt: ownerAttempt,
            status: ownerStatus,
            conclusion: ownerStatus === "completed" ? "failure" : null,
          },
          jobs: [],
        }
      : read(id, attempt);
  f.host.runId = 102;
  for (const status of ["queued", "pending", "in_progress"]) {
    ownerStatus = status;
    assert.equal(
      (await f.wake()).reason,
      "admitted-delivery-execution-running",
    );
    assert.deepEqual(f.snapshot(), retained);
  }
  ownerAttempt = 2;
  await assert.rejects(f.wake(), /provider identity drift/u);
  assert.deepEqual(f.snapshot(), retained);
  ownerAttempt = 1;
  ownerStatus = "completed";
  assert.equal((await f.wake()).operation, "deliver");
  const references = f
    .observed()
    .history.at(-1)
    .events.flatMap((e) => e.payload.materials)
    .filter((m) => m.id.startsWith("delivery/execution-"));
  assert.equal(references.length, 2);
  assert.match(references[0].id, /execution-101-1$/u);
  assert.match(references[1].id, /execution-102-1$/u);
});

import test from "node:test";
import assert from "node:assert/strict";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { openPipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { controlPipelineChannel } from "../packages/core/workflow/pipeline/channel-control.js";
import { controlPipeline } from "../packages/core/workflow/pipeline/controller.js";
import {
  beginPipelineBuild,
  recordPipelineBuild,
} from "../packages/core/workflow/pipeline/build-control.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("lawful channel PR uses protected queue and hands exact merge to the distinct publication stage", async () => {
  const f = pipelineHostFixture();
  f.admission.route = {
    operation: "alpha",
    from: "dev/v4/v4.1",
    to: "alpha/v4/v4.1",
  };
  f.admission.live.targetBranch = f.admission.route.to;
  const session = await openPipelineSession(
    { admission: f.admission, ...f.host },
    f.host,
  );
  const inputs = { "config-path": f.f.source.configPath };
  const control = () =>
    controlPipelineChannel(session, f.admission, inputs, f.host);
  const qualify = f.host.qualifyChannel;
  f.host.qualifyChannel = async () => {
    throw new Error("invalid source version lane");
  };
  await assert.rejects(control(), /invalid source version lane/);
  f.host.qualifyChannel = qualify;
  assert.equal((await control()).operation, "build");
  const context = await beginPipelineBuild(session, f.admission, f.host);
  f.build(context);
  await recordPipelineBuild(context, f.host);
  f.complete();
  f.admission.live.ready = true;
  f.host.policy.observe = async () => ({
    review: true,
    checksPassing: true,
    pr: { id: "PR23" },
    root: recordDigest("policy fixture"),
  });
  const entries = [];
  let enqueued = 0;
  f.host.queue = {
    getMergeQueueState: async () => ({
      enabled: true,
      entries: structuredClone(entries),
    }),
    enqueuePullRequest: async ({ pullRequestId, expectedHeadOid }) => {
      assert.equal(pullRequestId, "PR23");
      assert.equal(expectedHeadOid, f.f.source.commit);
      enqueued++;
      entries.push({
        pullRequestNumber: 23,
        pullRequestHeadSha: expectedHeadOid,
      });
    },
  };
  assert.equal((await control()).reason, "channel-enqueued");
  assert.equal((await control()).reason, "channel-in-protected-merge-queue");
  assert.equal(enqueued, 1);
  f.admission.live.merged = true;
  f.host.integration = {
    observe: async () => ({
      schema: "buildchain.pipeline-integration-readback/v1",
      sourceHead: f.f.source.commit,
      mergeCommit: "9".repeat(40),
      root: recordDigest("integration fixture"),
    }),
  };
  assert.equal((await control()).operation, "publish");
  const observed = await session.journal.read();
  assert.equal(observed.phases.merge.payload.state, "success");
  assert.equal(observed.phases.warrant, undefined);
  assert.deepEqual(observed.missing, [
    "publish",
    "distribution",
    "next-development",
  ]);
  assert.notEqual(observed.status, "complete");

  // A merged PR's run.head_sha names its source, while its signing certificate
  // names the merge commit. Publication must use the normal attempt dispatch,
  // whose provider run and signing source identify the same execution commit.
  f.admission.live.state = "closed";
  f.host.channel = (selected, admission, input) =>
    controlPipelineChannel(selected, admission, input, f.host);
  const request = f.host.request;
  f.host.request = (url, options) =>
    url.endsWith("/pulls/23")
      ? { base: { ref: f.admission.route.to }, state: "closed" }
      : request(url, options);
  const retained = JSON.stringify(f.snapshot());
  for (const [name, action] of [
    ["pull_request", "closed"],
    ["pull_request_target", "closed"],
    ["pull_request_review", "submitted"],
  ]) {
    const before = f.effects.filter((effect) => effect.wake).length;
    const result = await controlPipeline(
      name,
      {
        repository: { full_name: f.host.repository },
        action,
        pull_request: { number: 23 },
      },
      inputs,
      f.host,
    );
    assert.equal(result.operation, "wait", name);
    assert.equal(result.reason, "publication-requires-a-normal-dispatch");
    assert.equal(result.attempt, observed.attempt);
    assert.equal(f.effects.filter((effect) => effect.wake).length, before + 1);
    assert.equal(JSON.stringify(f.snapshot()), retained);
  }
  const dispatched = await f.wake();
  assert.equal(dispatched.operation, "publish");
  assert.equal(dispatched.attempt, observed.attempt);
  assert.equal(JSON.stringify(f.snapshot()), retained);
});

test("repeated channel source retirement reuses verified immutable material across workers", async () => {
  const f = pipelineHostFixture();
  f.admission.route = {
    operation: "alpha",
    from: "dev/v4/v4.1",
    to: "alpha/v4/v4.1",
  };
  f.admission.live.targetBranch = f.admission.route.to;
  const session = await openPipelineSession(
    { admission: f.admission, ...f.host },
    f.host,
  );
  const materialStore = f.host.materialStore;
  let retained = 0;
  f.host.materialStore = (selected) => {
    const store = materialStore(selected);
    return {
      ...store,
      retain: async (...args) => {
        retained++;
        return store.retain(...args);
      },
    };
  };
  f.admission.live.state = "closed";
  const control = () =>
    controlPipelineChannel(session, f.admission, {}, f.host);
  assert.equal((await control()).operation, "successor");
  const original = await session.journal.read();
  f.host.runId = 101;
  f.host.writer = { ...f.host.writer, runId: "101", jobId: "201" };
  assert.equal((await control()).operation, "successor");
  assert.equal(retained, 1, "replay must keep the original asset identity");
  assert.deepEqual(await session.journal.read(), original);

  f.host.materialStore = (selected) => ({
    ...materialStore(selected),
    read: async () => ({ changed: true }),
  });
  await assert.rejects(
    control(),
    /Channel retry changed its immutable receipt/,
  );
  assert.deepEqual(await session.journal.read(), original);
});

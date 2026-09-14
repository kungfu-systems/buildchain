import test from "node:test";
import assert from "node:assert/strict";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { openPipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { controlPipelineChannel } from "../packages/core/workflow/pipeline/channel-control.js";
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

test("channel projects the independently verified build before protected policy readback", async () => {
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
  const context = await beginPipelineBuild(session, f.admission, f.host);
  f.build(context);
  await recordPipelineBuild(context, f.host);
  const writes = [];
  f.host.request = async (url, options) => {
    assert.equal(
      url,
      `/repos/${f.host.repository}/statuses/${context.source.commit}`,
    );
    assert.equal(options.method, "POST");
    assert.equal(options.body.context, "check");
    assert.equal(options.body.state, "success");
    assert.equal(
      options.body.target_url,
      `https://github.com/${f.host.repository}/actions/runs/100/attempts/1`,
    );
    writes.push(options.body);
    return { id: 42 };
  };
  const control = () =>
    controlPipelineChannel(session, f.admission, {}, f.host);
  assert.equal((await control()).reason, "source-workflow-not-qualified");
  assert.equal(writes.length, 0);
  f.complete();
  f.host.policy.observe = async () => {
    assert.equal(
      writes.length,
      1,
      "required check must precede policy observation",
    );
    return { review: false, checksPassing: true };
  };
  assert.equal((await control()).reason, "protected-channel-gates-pending");
  const read = f.host.materialStore;
  f.host.materialStore = (selected) => ({
    ...read(selected),
    read: async (reference) => ({
      ...(await read(selected).read(reference)),
      outcome: "failure",
    }),
  });
  await assert.rejects(
    control(),
    /Retained product build provider result changed/,
  );
  assert.equal(
    writes.length,
    1,
    "changed retained evidence must not publish success",
  );
});

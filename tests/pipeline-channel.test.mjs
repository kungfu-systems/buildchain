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

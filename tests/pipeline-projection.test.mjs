import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers/business-attempt.mjs";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";
import { resumePipelineSession } from "../packages/core/workflow/pipeline/session.js";
import { pipelineProjection } from "../packages/core/workflow/pipeline/projection.js";

test("Discussion copies admitted journal records and retry does not create new business history", async () => {
  const f = pipelineHostFixture(),
    discussion = fixture();
  const build = await f.event();
  const session = await resumePipelineSession(
    { ...f.host, attempt: build.context.attempt },
    f.host,
  );
  const project = pipelineProjection(null, discussion.transport);
  const original = f.observed().head;
  const result = await project(session);
  assert.equal(result.journalHead, original);
  const count = discussion.comments.length;
  await project(session);
  assert.equal(discussion.comments.length, count);
  assert.equal(f.observed().head, original);
});

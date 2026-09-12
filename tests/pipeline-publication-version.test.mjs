import assert from "node:assert/strict";
import test from "node:test";
import { pipelineVersionFixture as fixture } from "./helpers/pipeline-version.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";

test("version material uses an isolated deterministic ref and recovers a lost successful ref response", async () => {
  const { plan, provider, writes, refs } = fixture({ lostResponse: true });
  const first = await provider.materialize(plan),
    again = await provider.materialize(plan);
  assert.equal(first.root, again.root);
  assert.notEqual(first.source.commit, plan.source.commit);
  assert.equal(first.material.version, "1.0.0");
  assert.equal(refs.size, 1);
  assert.ok(
    [...refs.keys()].every((ref) =>
      ref.startsWith("heads/buildchain/publication-source/"),
    ),
  );
  assert.equal(
    writes.some(({ body }) => body.force),
    false,
  );
});

test("a stable version overlay retains previous published ancestry without changing additional tree paths", async () => {
  const { plan, provider, commits } = fixture();
  const first = await provider.materialize(plan);
  const { root, ...body } = plan;
  const nextBody = { ...body, previousChannelCommit: first.source.commit };
  const next = await provider.materialize({
    ...nextBody,
    root: recordDigest(nextBody),
  });
  assert.deepEqual(
    commits.get(next.source.commit).parents.map(({ sha }) => sha),
    [plan.source.commit, first.source.commit],
  );
  assert.deepEqual(
    next.material.changes.map(({ path }) => path),
    ["package.json"],
  );
});

test("version material rejects symlinks and provider changes beyond the exact planned fields", async () => {
  const symbolic = fixture({ mode: "120000" });
  await assert.rejects(
    symbolic.provider.materialize(symbolic.plan),
    /tracked regular file/,
  );
  assert.equal(symbolic.writes.length, 0);
  const tampered = fixture({ tamper: true });
  await assert.rejects(
    tampered.provider.materialize(tampered.plan),
    /beyond the planned fields/,
  );
  assert.equal(tampered.refs.size, 0);
});

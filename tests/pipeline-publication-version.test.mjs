import assert from "node:assert/strict";
import test from "node:test";
import { pipelineVersionFixture as fixture } from "./helpers/pipeline-version.mjs";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { pipelineVersionRegenerationResult } from "../packages/core/publication/pipeline/version-regeneration.js";
import { materializePipelineVersion } from "../packages/core/publication/pipeline/version.js";

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

test("derived materialization requires qualified preparation and writes only the admitted regenerated documents", async () => {
  const f = fixture({
    derivedFiles: { "dist/facts.json": '{"version":"1.0.0-alpha.1"}' },
  });
  await assert.rejects(
    f.provider.materialize(f.plan),
    /retained qualified regeneration/,
  );
  assert.equal(f.writes.length, 0);
  const before = await f.provider.inspect(f.plan.source, f.plan.versionPolicy);
  const preparation = {
    root: recordDigest("test preparation"),
    parentRoot: f.plan.root,
    source: f.plan.source,
    version: f.plan.version,
    versionPolicy: f.plan.versionPolicy,
    platforms: ["linux-x64"],
  };
  const pure = materializePipelineVersion(
    f.plan.versionPolicy,
    before.files,
    f.plan.version,
  );
  const files = {
    ...before.files,
    ...Object.fromEntries(
      pure.changes.map(({ path, content }) => [path, content]),
    ),
    "dist/facts.json": '{"version":"1.0.0"}',
  };
  // Provider IO qualification is covered by pipeline-version-artifacts tests;
  // this fixture exercises the subsequent Git byte boundary and exact readback.
  const body = { preparationRoot: preparation.root, runId: 8, runAttempt: 2 };
  const regeneration = {
    context: { preparation, runId: 8, runAttempt: 2 },
    build: { ...body, root: recordDigest(body) },
    results: [
      pipelineVersionRegenerationResult(preparation, "linux-x64", files),
    ],
  };
  const materialized = await f.provider.materialize(f.plan, regeneration);
  assert.deepEqual(
    materialized.material.changes.map(({ path }) => path),
    ["dist/facts.json", "package.json"],
  );
  const readback = await f.provider.inspect(
    materialized.source,
    f.plan.versionPolicy,
  );
  assert.deepEqual(readback.files, files);
  assert.equal(JSON.parse(readback.files["package.json"]).keep, "untouched");
  const previousWrites = f.writes.length;
  const substituted = structuredClone(regeneration);
  substituted.context.preparation.parentRoot = recordDigest("different plan");
  await assert.rejects(
    f.provider.materialize(f.plan, substituted),
    /exact version materialization/,
  );
  assert.equal(f.writes.length, previousWrites);
});

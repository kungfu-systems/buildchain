import assert from "node:assert/strict";
import test from "node:test";
import {
  validateBinaryPublicationSelection,
  resolveBinaryPublicationCoordinates,
} from "../packages/core/release/binary/coordinates.js";
const runtime = "e".repeat(40),
  source = "d".repeat(40);
function input() {
  return {
    runId: "123",
    tag: "v4.1.0-alpha.0",
    runtime: runtime,
    workflowSha: runtime,
    repository: "example/consumer",
  };
}
test("binary selection requires exact runtime at the workflow source and derives the release line", () => {
  assert.equal(validateBinaryPublicationSelection(input()).targetRef, "alpha/v4/v4.1");
  assert.equal(
    validateBinaryPublicationSelection({ ...input(), tag: "v4.1.0" }).targetRef,
    "release/v4/v4.1",
  );
  for (const change of [
    { runId: "0" },
    { runId: "latest" },
    { tag: "v4-alpha" },
  ])
    assert.throws(() => validateBinaryPublicationSelection({ ...input(), ...change }));
});
test("binary coordinates require stable tag readback and an existing Release before exposing outputs", async () => {
  const calls = [];
  const github = { rest: { repos: {
    getCommit: async args => { calls.push(args); return { data: { sha: source } }; },
    getReleaseByTag: async args => { calls.push(args); return { data: { id: 1 } }; },
  } } };
  const result = await resolveBinaryPublicationCoordinates({ ...input(), github });
  assert.equal(result["source-sha"], source);
  assert.equal(Object.hasOwn(result,"buildchain-ref"), false);
  assert.equal(result["evidence-run-id"], "123");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], { owner: "example", repo: "consumer", tag: "v4.1.0-alpha.0" });
  let reads = 0;
  github.rest.repos.getCommit = async () => ({ data: { sha: ++reads === 1 ? source : runtime } });
  await assert.rejects(resolveBinaryPublicationCoordinates({ ...input(), github }), /tag moved/);
  github.rest.repos.getCommit = async () => ({ data: { sha: source } });
  github.rest.repos.getReleaseByTag = async () => { throw new Error("release missing"); };
  await assert.rejects(resolveBinaryPublicationCoordinates({ ...input(), github }), /release missing/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  validateSelection,
  resolve,
} from "../packages/core/release/nodes/binary-publication-coordinates.mjs";
const runtime = "e".repeat(40),
  source = "d".repeat(40);
function input() {
  return {
    INPUT_RUN_ID: "123",
    INPUT_RELEASE_TAG: "v4.1.0-alpha.0",
    INPUT_BUILDCHAIN_REF: runtime,
    GITHUB_SHA: runtime,
    GITHUB_REPOSITORY: "example/consumer",
  };
}
test("binary selection requires exact runtime at the workflow source and derives the release line", () => {
  assert.equal(validateSelection(input()).targetRef, "alpha/v4/v4.1");
  assert.equal(
    validateSelection({ ...input(), INPUT_RELEASE_TAG: "v4.1.0" }).targetRef,
    "release/v4/v4.1",
  );
  for (const change of [
    { INPUT_RUN_ID: "0" },
    { INPUT_RUN_ID: "latest" },
    { INPUT_RELEASE_TAG: "v4-alpha" },
    { INPUT_BUILDCHAIN_REF: "" },
    { INPUT_BUILDCHAIN_REF: "v4" },
    { INPUT_BUILDCHAIN_REF: source },
  ])
    assert.throws(() => validateSelection({ ...input(), ...change }));
});
test("binary coordinates require stable tag readback and an existing Release before exposing outputs", () => {
  const calls = [];
  const result = resolve(input(), (program, args) => {
    calls.push({ program, args });
    return args[0] === "api" ? source : "release";
  });
  assert.equal(result["source-sha"], source);
  assert.equal(result["buildchain-ref"], runtime);
  assert.equal(result["evidence-run-id"], "123");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args, [
    "release",
    "view",
    "v4.1.0-alpha.0",
    "--repo",
    "example/consumer",
  ]);
  let reads = 0;
  assert.throws(
    () => resolve(input(), () => (++reads === 1 ? source : runtime)),
    /tag moved/,
  );
  assert.throws(
    () =>
      resolve(input(), (_program, args) => {
        if (args[0] === "release") throw Error("release missing");
        return source;
      }),
    /release missing/,
  );
});

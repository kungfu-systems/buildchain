import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { lowerSelfReferencesForLint } from "../scripts/workflow-self-reference.mjs";

test("self action lint projection preserves inputs and expressions against actual source metadata", () => {
  const source = { jobs: { entry: { steps: [{ uses: "$/actions/runtime/environment/prepare", with: { selection: "${{ needs.runtime.outputs.selection }}", misspelled: "still checked" } }] } } };
  const projected = YAML.parse(lowerSelfReferencesForLint(YAML.stringify(source)));
  const expected = structuredClone(source);
  expected.jobs.entry.steps[0].uses = "./actions/runtime/environment/prepare";
  assert.deepEqual(projected, expected);
  assert.equal(source.jobs.entry.steps[0].uses, "$/actions/runtime/environment/prepare");
});

test("malformed self references fail instead of being hidden from the linter", () => {
  for (const uses of ["$/actions/runtime/environment/prepare@v4", "$/../actions/runtime/environment/prepare", "$/actions/runtime/environment/../prepare"])
    assert.throws(() => lowerSelfReferencesForLint(YAML.stringify({ jobs: { entry: { steps: [{ uses }] } } })), /Invalid Buildchain/u);
});

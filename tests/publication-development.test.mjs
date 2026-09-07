import assert from "node:assert/strict";
import test from "node:test";
import {
  nextPatchDevelopmentVersion,
  compareDevelopmentVersions,
} from "../packages/core/publication-development.js";
import { invokeDomainWasm } from "../packages/core/domain-wasm.js";

test("next patch selection has no product generation and compares arbitrarily large counters", () => {
  for (const major of [3, 4, 5, 12])
    assert.equal(
      nextPatchDevelopmentVersion(`${major}.2.9`),
      `${major}.2.10-alpha.0`,
    );
  assert.equal(
    compareDevelopmentVersions(
      "4.0.3-alpha.0",
      "4.0.2-alpha.9999999999999999999999",
    ),
    1,
  );
  assert.equal(compareDevelopmentVersions("4.0.3", "4.0.3-alpha.99"), 1);
  assert.throws(() => nextPatchDevelopmentVersion("4.0.2-alpha.9"));
});

test("Rust projection requires an explicit completed stable version for next patch alpha zero", () => {
  const project = (value) =>
    invokeDomainWasm("source-version-projection", value);
  const input = {
    baseVersion: "4.0.2-alpha.53",
    version: "4.0.3-alpha.0",
    completedStableVersion: "4.0.2",
  };
  assert.equal(project(input).valid, true);
  assert.equal(project({ ...input, baseVersion: "4.0.2" }).valid, true);
  for (const mutation of [
    { completedStableVersion: undefined },
    { completedStableVersion: "4.0.2-alpha.53" },
    { baseVersion: "4.0.1-alpha.53" },
    { version: "4.0.3-alpha.1" },
    { version: "4.0.4-alpha.0" },
  ])
    assert.throws(() => project({ ...input, ...mutation }));
});

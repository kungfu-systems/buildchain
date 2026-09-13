import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  getStableReleasePolicy,
  loadBuildchainConfig,
} from "../packages/core/consumer/buildchain-config.js";
import { loadStableReleasePolicy } from "../packages/core/release/stable-release-gate.js";

const root = path.resolve(import.meta.dirname, "..");

test("self stable policy consumes the current public zero-input qualification", () => {
  const patrol = getStableReleasePolicy(loadBuildchainConfig(root));
  assert.deepEqual(patrol.requiredChecks, [
    "alpha-release",
    "status:buildchain-canary/buildchain-zero-input",
  ]);
  assert.equal(patrol.minimumSoakSeconds, 3600);
  const gate = loadStableReleasePolicy({
    cwd: root,
    input: ".buildchain/stable-release-policy.json",
  });
  assert.equal(gate.minimumCanarySoakSeconds, 3600);
  assert.equal(gate.minimumStableIntervalSeconds, 86400);
  const canary = gate.requiredCanaries.find(
    (entry) => entry.source === "public-build",
  );
  assert.ok(canary);
  assert.equal(canary.repository, "kungfu-systems/buildchain");
  assert.equal(canary.workflow, "Buildchain Alpha Self-Dogfood");
  assert.equal(canary.context, "buildchain-canary/buildchain-zero-input");
  assert.deepEqual(canary.allowedAttestors, ["github-actions[bot]"]);
  assert.equal(
    gate.requiredCanaries.some((entry) =>
      entry.repository.includes("site-libkungfu-dev"),
    ),
    false,
  );
});

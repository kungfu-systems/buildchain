import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { compileConsumerPlan } from "../packages/core/consumer/contract/plan.js";
import { loadStableReleasePolicy } from "../packages/core/release/stable-release-gate.js";

const root = path.resolve(import.meta.dirname, "..");

test("self stable plan removes fixed delays and preserves published-entry requirements", () => {
  const policy = compileConsumerPlan(fs.readFileSync(path.join(root, ".buildchain/buildchain.toml"), "utf8")).stable;
  assert.equal(policy.minimum_soak_seconds, 0);
  assert.equal(policy.minimum_interval_seconds, 0);
  assert.equal(policy.require_published_entry, true);
  // Both policy paths retain the required evidence without a fixed delay.
  const gate = loadStableReleasePolicy({
    cwd: root,
    input: ".buildchain/stable-release-policy.json",
  });
  assert.equal(gate.minimumCanarySoakSeconds, 0);
  assert.equal(gate.minimumStableIntervalSeconds, 0);
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

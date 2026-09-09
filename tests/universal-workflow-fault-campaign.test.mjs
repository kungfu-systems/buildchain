import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const campaign = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/universal-workflow-fault-campaign.json"),
    "utf8",
  ),
);
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("the universal fault campaign freezes all ten independent defect classes", () => {
  assert.equal(campaign.independentFaultsOnly, true);
  assert.equal(campaign.simultaneousPrimaryAndRecoveryFailureClaimed, false);
  assert.deepEqual(
    campaign.faults.map(({ id }) => id),
    [
      "primary-facade",
      "typed-input-adapter",
      "route-selector",
      "ordinary-candidate-loader",
      "router",
      "action",
      "cli-runtime",
      "recovery-logic",
      "result-projection",
      "self-dogfood-caller",
    ],
  );
  assert.equal(campaign.externalBoundary.recovered, false);
  assert.equal(
    campaign.externalBoundary.classification,
    "irreducible-external-availability",
  );
});

test("every injected target has a distinct pre-positioned or exact-Train route", () => {
  for (const fault of campaign.faults) {
    assert.ok(read(fault.injectionTarget).length > 0, fault.id);
    assert.ok(read(fault.recoveryTarget).length > 0, fault.id);
    assert.match(
      fault.recoveryRoute,
      /^(?:pre-positioned-recovery-shell|exact-train-candidate|primary-bootstrap-shell|consumer-equivalent-recovery-shell)$/u,
      fault.id,
    );
    if (fault.recoveryRoute !== "exact-train-candidate")
      assert.notEqual(fault.injectionTarget, fault.recoveryTarget, fault.id);
  }
});

test("primary and recovery shells are non-circular and retain opposite fault routes", () => {
  const primary = read("templates/universal-buildchain-bootstrap.yml");
  const recovery = read(
    "templates/universal-buildchain-bootstrap-recovery.yml",
  );
  assert.match(primary, /\.github\/workflows\/public-ops-bootstrap\.yml@/u);
  assert.doesNotMatch(
    recovery,
    /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\//u,
  );
  const workflow = YAML.parse(recovery);
  assert.deepEqual(Object.keys(workflow.jobs), ["recovery-admit", "recovery-execute", "recovery-settle"]);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job.steps.some((step) => step.uses?.includes(".buildchain/bootstrap-recovery/actions/workflow/")));
    assert.ok(job.steps.every((step) => !Object.hasOwn(step, "run")));
  }
  const settle = read("actions/workflow/bootstrap-recovery-settle/action.yml");
  assert.match(settle, /Seal receipt outside candidate authority/);
  assert.doesNotMatch(settle, /candidate.*universal-workflow-engine.*terminal/);
});

test("candidate-owned faults execute only after exact admission", () => {
  const action = YAML.parse(read("actions/workflow/bootstrap-recovery-admit/action.yml"));
  const review = action.runs.steps.findIndex((step) => /independent review/.test(step.name || ""));
  const install = action.runs.steps.findIndex((step) => step.uses?.endsWith("actions/runtime/prepare"));
  const admit = action.runs.steps.findIndex((step) => step.id === "admit");
  assert.ok(review >= 0 && review < install && install < admit);
  const execute = YAML.parse(read("actions/workflow/bootstrap-recovery-execute/action.yml"));
  const candidate = execute.runs.steps.find((step) => step.name === "Checkout exact admitted candidate");
  assert.equal(candidate.with.ref, "${{ fromJSON(inputs.needs-recovery-admit-outputs-runtime-sha) }}");
  assert.ok(execute.runs.steps.every((step) => !/train\/v4|v4-alpha/.test(JSON.stringify(step))));
});

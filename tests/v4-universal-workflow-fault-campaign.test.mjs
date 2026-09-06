import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const campaign = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/v4-universal-workflow-fault-campaign.json"),
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
  assert.match(primary, /\.github\/workflows\/bootstrap\.yml@/u);
  assert.doesNotMatch(
    recovery,
    /uses:\s+kungfu-systems\/buildchain\/\.github\/workflows\//u,
  );
  assert.match(
    recovery,
    /Parse exact recovery coordinates without Buildchain code/u,
  );
  assert.match(recovery, /Execute only the exact admitted engine/u);
  assert.match(recovery, /Seal receipt outside candidate authority/u);
  assert.doesNotMatch(recovery, /candidate\/scripts\/v4-universal-workflow-engine\.mjs terminal/u);
});

test("candidate-owned faults execute only after exact admission", () => {
  const recovery = read(
    "templates/universal-buildchain-bootstrap-recovery.yml",
  );
  const review = recovery.indexOf("Prove exact independent review");
  const admit = recovery.indexOf(
    "Admit candidate policy and exact-head checks",
  );
  const execute = recovery.indexOf("Execute only the exact admitted engine");
  assert.ok(review >= 0 && review < admit && admit < execute);
  assert.match(
    recovery,
    /ref: \$\{\{ needs\.recovery-admit\.outputs\.runtime-sha \}\}/u,
  );
  assert.doesNotMatch(
    recovery.slice(execute),
    /train\/v4|v4-alpha|@v4(?:\s|$)/u,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  loadWarrantPlan,
  validateFixtures,
  validatePlan,
} from "../scripts/v4-warrant-shadow-plan.mjs";

const root = new URL("..", import.meta.url).pathname;

test("v4 Warrant plan validates complete authority and cutover coverage", () => {
  const { plan, report, fixtureResults } = loadWarrantPlan(root);
  assert.deepEqual(report, {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-delivery-warrant-plan-validation",
    ok: true,
    states: 9,
    events: 7,
    transitionRows: 7,
    primitives: 9,
    disagreements: 7,
    rolloutStages: 4,
    wave1Nodes: 6,
    permanentDualAuthority: false,
    candidateSelfQualification: false,
  });
  assert.equal(fixtureResults.length, 5);
  assert.equal(plan.wave1Reconciliation.productionAuthority, "typescript-v3");
  assert.equal(plan.wave1Reconciliation.parentInitiativeState, "inert");
  assert.equal(plan.wave1Reconciliation.children.length, 6);
  assert.ok(
    plan.wave1Reconciliation.children.every(
      (child) =>
        child.status === "proved" &&
        child.captureReceiptRoot.startsWith("sha256:") &&
        child.sealRoot.startsWith("sha256:") &&
        child.review === "exact-head-approved-by-kungfu-origin",
    ),
  );
  assert.deepEqual(
    plan.wave2.nodes.map((node) => node.id),
    [
      "stage-capsule-contracts",
      "stage-capsule-store-retention",
      "platform-stage-checkpoints",
      "resume-planner",
      "stage-capsule-qualification-reconciliation",
    ],
  );
  assert.equal(plan.wave2.authority, "typescript-v3");
  assert.equal(plan.wave2.mode, "effect-disabled-shadow-foundation");
  assert.ok(
    fixtureResults.every(
      (result) =>
        result.projectionRoot.startsWith("sha256:") &&
        result.projections.length > 0,
    ),
  );
});

test("shared fixtures freeze legacy successes, no-ops, and typed faults", () => {
  const { fixtures, fixtureResults } = loadWarrantPlan(root);
  assert.deepEqual(
    fixtureResults.map((entry) => entry.projectionRoot),
    fixtures.traces.map((entry) => entry.expectedLegacyProjectionRoot),
  );
  const projections = fixtureResults.flatMap((entry) => entry.projections);
  for (const expected of [
    "duplicate-noop",
    "heartbeat",
    "terminal-closeout",
    "recovered-expired-lease",
    "duplicate-terminal-event-noop",
    "duplicate-cancellation-noop",
    "cas-rejected",
    "committed-readback",
    "provider-conflict-stop",
  ]) {
    assert.ok(
      projections.some((entry) => entry.action === expected),
      `missing fixture action ${expected}`,
    );
  }
  assert.ok(
    projections.some((entry) => entry.errorCode === "stale-fencing-token"),
  );
  assert.ok(
    projections.some((entry) => entry.errorCode === "stale-expected-old"),
  );
});

test("validation rejects ambient time, provider SDKs, and self qualification", () => {
  const { plan } = loadWarrantPlan(root);
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-capability-state-machine-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const bootstrap = JSON.parse(
    fs.readFileSync(
      new URL("../architecture/v4-bootstrap-authority.json", import.meta.url),
      "utf8",
    ),
  );
  const invalid = structuredClone(plan);
  invalid.canonicalContract.clock.mode = "ambient-default";
  invalid.boundaries.rustDomain.providerSdkImports = "adapter-only";
  invalid.authority.candidateSelfQualification = true;
  assert.throws(
    () => validatePlan({ plan: invalid, manifest, bootstrap }),
    /explicit-input-only.*forbid provider SDK.*self-qualification/su,
  );
});

test("validation rejects the former circular Wave 1 entry gate", () => {
  const { plan } = loadWarrantPlan(root);
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-capability-state-machine-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const bootstrap = JSON.parse(
    fs.readFileSync(
      new URL("../architecture/v4-bootstrap-authority.json", import.meta.url),
      "utf8",
    ),
  );
  const invalid = structuredClone(plan);
  invalid.wave1.entryGate = invalid.wave1.readCandidateEntryGate;
  assert.throws(
    () => validatePlan({ plan: invalid, manifest, bootstrap }),
    /entry gates must remain distinct/u,
  );
});

test("fixture validation fails on a changed legacy projection root", () => {
  const { fixtures } = loadWarrantPlan(root);
  const drifted = structuredClone(fixtures);
  drifted.traces[0].expectedLegacyProjectionRoot = `sha256:${"f".repeat(64)}`;
  assert.throws(() => validateFixtures(drifted), /projection drift/u);
});

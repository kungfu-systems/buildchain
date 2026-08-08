import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import { planV4StageCapsuleResume } from "../packages/core/v4-stage-capsule-resume-planner.js";

const root = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(
  root,
  "contracts/fixtures/v4-stage-capsule-resume-v1/late-platform-failure.json",
);
const request = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const clone = (value) => structuredClone(value);

function buildOnly(value) {
  value.targets = ["build"];
  return value;
}

test("late platform failure restores completed work and rebuilds only the missing stage", () => {
  const plan = planV4StageCapsuleResume(request);
  assert.equal(
    plan.planRoot,
    "sha256:38ca577ec06e3312b1d27a1362cf517d64909d22802946ad0b452d911016a10b",
  );
  assert.deepEqual(
    plan.decisions.map(({ stageKey, decision, reasonCode }) => ({
      stageKey,
      decision,
      reasonCode,
    })),
    [
      { stageKey: "build", decision: "reuse", reasonCode: "eligible" },
      {
        stageKey: "verify",
        decision: "rebuild",
        reasonCode: "unavailable",
      },
    ],
  );
  assert.deepEqual(plan.requiredRestores, ["build"]);
  assert.deepEqual(plan.requiredStages, ["verify"]);
  assert.equal(plan.mode, "shadow-only");
  assert.equal(plan.productionAuthority, "v3");
});

test("same explicit observations produce byte-identical Rust and JavaScript plans", () => {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "resume-plan",
      fixturePath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    JSON.parse(result.stdout),
    planV4StageCapsuleResume(request),
  );
});

test("Rust and JavaScript emit the same causal invalidation roots", () => {
  const changed = buildOnly(clone(request));
  changed.nodes[0].expectedIdentity.sourceRoot =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "resume-plan",
      "-",
    ],
    { cwd: root, encoding: "utf8", input: JSON.stringify(changed) },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(
    JSON.parse(result.stdout),
    planV4StageCapsuleResume(changed),
  );
});

test("identity and retention drift produce exact causal invalidations", () => {
  const changedRoot =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  const cases = [
    [
      "source-root",
      "source-changed",
      (node) => (node.expectedIdentity.sourceRoot = changedRoot),
    ],
    [
      "platform-root",
      "platform-changed",
      (node) => (node.expectedIdentity.platformRoot = changedRoot),
    ],
    [
      "toolchain-roots",
      "toolchain-changed",
      (node) => (node.expectedIdentity.toolchainRoots[0].root = changedRoot),
    ],
    [
      "runtime-root",
      "runtime-changed",
      (node) => (node.expectedIdentity.runtimeRoot = changedRoot),
    ],
    [
      "policy-root",
      "policy-changed",
      (node) => (node.expectedIdentity.policyRoot = changedRoot),
    ],
    [
      "declared-inputs",
      "input-changed",
      (node) => (node.expectedIdentity.declaredInputs[0].root = changedRoot),
    ],
    [
      "transformation-root",
      "transformation-changed",
      (node) => (node.expectedIdentity.transformationRoot = changedRoot),
    ],
    [
      "retention-promise",
      "retention-changed",
      (node) => (node.expectedRetentionPromise.class = "wave-three"),
    ],
  ];
  for (const [field, reasonCode, mutate] of cases) {
    const changed = buildOnly(clone(request));
    mutate(changed.nodes[0]);
    const plan = planV4StageCapsuleResume(changed);
    assert.equal(plan.decisions[0].decision, "rebuild", field);
    assert.equal(plan.decisions[0].reasonCode, reasonCode, field);
    assert.equal(plan.decisions[0].invalidationCauses[0].field, field);
    assert.deepEqual(plan.requiredStages, ["build"], field);
    assert.deepEqual(plan.requiredRestores, [], field);
  }
});

test("cross-platform, corrupt, root-mismatched, and insufficient evidence fail closed", () => {
  const cases = [
    [
      "cross-platform",
      (value) => (value.nodes[0].expectedIdentity.platform = "darwin-arm64"),
    ],
    [
      "corrupt",
      (value) => {
        const availability = value.nodes[0].candidate.availability;
        availability.status = "corrupt";
        availability.contentRoot = null;
        availability.qualificationRoot = null;
        availability.faultCode = "capsule-corrupt";
      },
    ],
    [
      "root-mismatch",
      (value) => {
        const availability = value.nodes[0].candidate.availability;
        availability.status = "root-mismatch";
        availability.contentRoot = null;
        availability.qualificationRoot = null;
        availability.faultCode = "capsule-root-mismatch";
      },
    ],
    [
      "evidence-insufficient",
      (value) =>
        (value.nodes[0].expectedIdentity.qualificationRoot =
          "sha256:0000000000000000000000000000000000000000000000000000000000000000"),
    ],
  ];
  for (const [reasonCode, mutate] of cases) {
    const changed = buildOnly(clone(request));
    mutate(changed);
    const plan = planV4StageCapsuleResume(changed);
    assert.equal(plan.decisions[0].decision, "reject", reasonCode);
    assert.equal(plan.decisions[0].execution, "rebuild", reasonCode);
    assert.equal(plan.decisions[0].reasonCode, reasonCode, reasonCode);
  }
});

test("provider and release-tail effects stay separate and readback-required", () => {
  const plan = planV4StageCapsuleResume(request);
  assert.deepEqual(plan.requiredEffects, request.effects);
  assert.equal(plan.requiredEffects[0].providerReadback, true);
  assert.equal(plan.requiredEffects[0].mutation, false);
  const unsafe = clone(request);
  unsafe.effects[0].mutation = true;
  assert.throws(
    () => planV4StageCapsuleResume(unsafe),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "invalid-stage-capsule-resume-effect",
  );
});

test("closed inputs reject ambient authority", () => {
  for (const field of ["cwd", "env", "network", "now", "providerToken"]) {
    const changed = clone(request);
    changed[field] = "ambient";
    assert.throws(
      () => planV4StageCapsuleResume(changed),
      (error) =>
        error instanceof V4ContractFault &&
        error.code === "invalid-stage-capsule-resume-shape",
      field,
    );
  }
});

test("architecture freezes a pure planner and zero v3 authority drift", () => {
  const architecture = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture/v4-stage-capsule-resume-planner.json"),
      "utf8",
    ),
  );
  assert.deepEqual(architecture.planner, {
    rust: "pure-domain-authority",
    typescript: "byte-identical-projection",
    ambientClock: false,
    filesystem: false,
    network: false,
    environment: false,
  });
  assert.equal(architecture.effects.separateFromCapsuleReuse, true);
  assert.equal(architecture.budgets.plannerSideEffects, 0);
  assert.equal(architecture.budgets.productionStageSkippingChanges, 0);
  assert.equal(architecture.budgets.v3AuthorityChanges, 0);
});

test("real-platform rehearsal projects the same deterministic core", () => {
  for (const platform of ["linux-x64", "macos-arm64", "windows-x64"]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/v4-stage-capsule-resume-rehearsal.mjs", "--platform", platform],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.platform, platform);
    assert.equal(evidence.planRoot, planV4StageCapsuleResume(request).planRoot);
    assert.equal(evidence.productionAuthority, "v3");
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT,
  BUILDCHAIN_CONTROLLER_REGISTRY_CONTRACT,
  aggregateControllerReceipts,
  createControllerPlan,
  createControllerReceipt,
  createControllerReceiptReference,
  createControllerRegistry,
  normalizeControllerReceiptReferences,
  validateControllerPlan,
  validateControllerReceipt,
  validateControllerReceiptReference,
} from "../packages/core/controller-evidence.js";
import {
  resolveControllerInputBoundary,
  selectWorkflowCallInputs,
} from "../scripts/controller-evidence.mjs";

const SOURCE_SHA = "a".repeat(40);
const RUNTIME_SHA = "b".repeat(40);
const CONTRACT_DIGEST = `sha256:${"c".repeat(64)}`;

function registry() {
  return createControllerRegistry({
    workflows: [
      { id: "check", path: ".github/workflows/check.yml", inputs: ["mode", "working-directory"] },
      {
        id: ".build",
        path: ".github/workflows/.build.yml",
        inputs: ["buildchain-ref", "build-command", "platforms-json", "working-directory"],
        secrets: ["BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN"],
      },
      { id: "build", path: ".github/workflows/build.yml", inputs: ["buildchain-channel"] },
      { id: ".gate-profile", path: ".github/workflows/.gate-profile.yml", inputs: ["profile"] },
      { id: ".web-surface", path: ".github/workflows/.web-surface.yml", inputs: ["build-command"] },
      { id: "publication-artifact", path: ".github/workflows/publication-artifact.yml", inputs: ["build-command"] },
      { id: "paper-release", path: ".github/workflows/paper-release.yml", inputs: ["build-command"] },
      { id: "release-candidate-promote", path: ".github/workflows/release-candidate-promote.yml", inputs: ["channel"] },
      { id: ".release-candidate-promote", path: ".github/workflows/.release-candidate-promote.yml", inputs: ["channel"] },
      { id: "release-propagation", path: ".github/workflows/release-propagation.yml", inputs: ["graph-json"] },
    ],
  });
}

function descriptor(id = "build-lifecycle") {
  const value = registry().controllers.find((entry) => entry.id === id);
  assert.ok(value, `missing controller descriptor ${id}`);
  return value;
}

function plan(overrides = {}) {
  return createControllerPlan({
    descriptor: descriptor(),
    source: { repository: "kungfu-systems/example", sha: SOURCE_SHA },
    runtime: { ref: "v2", sha: RUNTIME_SHA, contractDigest: CONTRACT_DIGEST },
    inputs: {
      "buildchain-ref": "v2",
      "build-command": "pnpm run build --token should-not-appear",
      "platforms-json": [{ id: "linux-x64", runner: "private-runner" }],
      "working-directory": ".",
    },
    ...overrides,
  });
}

test("controller registry freezes the first project-independent public inventory", () => {
  const value = registry();

  assert.equal(value.contract, BUILDCHAIN_CONTROLLER_REGISTRY_CONTRACT);
  assert.deepEqual(value.controllers.map((entry) => entry.id), [
    "source-check",
    "build-lifecycle",
    "build-channel-router",
    "shifu-gate-profile-envelope",
    "web-surface",
    "publication-artifact",
    "paper-release",
    "release-candidate-promotion",
    "release-propagation",
  ]);
  assert.equal(descriptor().inputs["working-directory"].classification, "digest-only");
  assert.equal(descriptor().inputs["build-command"].classification, "digest-only");
  assert.equal(descriptor().inputs["platforms-json"].classification, "digest-only");
  assert.equal(
    descriptor().inputs.BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN.classification,
    "redacted",
  );
});

test("controller plans are deterministic and never serialize redacted or digest-only values", () => {
  const first = plan();
  const second = plan();
  const serialized = JSON.stringify(first);

  assert.deepEqual(first, second);
  assert.equal(first.contract, BUILDCHAIN_CONTROLLER_EVIDENCE_CONTRACT);
  assert.equal(first.kind, "plan");
  assert.equal(first.source.sha, SOURCE_SHA);
  assert.equal(first.runtime.sha, RUNTIME_SHA);
  assert.equal(first.runtime.contractDigest, CONTRACT_DIGEST);
  assert.match(first.inputs["working-directory"].digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.inputs["build-command"].digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.inputs["platforms-json"].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.inputs.BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN.classification, "redacted");
  assert.doesNotMatch(serialized, /should-not-appear|private-runner/);
  assert.equal(validateControllerPlan(first).ok, true);
});

test("controller plans fail closed for undeclared inputs", () => {
  assert.throws(
    () => plan({ inputs: { "undeclared-input": true } }),
    /undeclared controller input/,
  );
});

test("workflow-call controller adapters exclude caller ambient inputs", () => {
  const workflowDescriptor = descriptor("web-surface");
  const inputs = selectWorkflowCallInputs(workflowDescriptor, {
    "build-command": "pnpm run build",
    buildchain_ref: RUNTIME_SHA,
  });

  assert.equal(resolveControllerInputBoundary(workflowDescriptor), "workflow-call");
  assert.equal(resolveControllerInputBoundary(workflowDescriptor, "strict"), "strict");
  assert.deepEqual(inputs, { "build-command": "pnpm run build" });
});

test("controller input boundaries remain strict without workflow-call provenance", () => {
  assert.equal(resolveControllerInputBoundary({
    inputs: {
      mode: { classification: "included", source: "environment" },
    },
  }), "strict");
  assert.throws(
    () => resolveControllerInputBoundary(descriptor("web-surface"), "ambient"),
    /unsupported controller input boundary/,
  );
});

test("controller receipts preserve pass, fail, skip, and partial outcomes", () => {
  const expectedPlan = plan();
  const passed = createControllerReceipt({
    plan: expectedPlan,
    stages: [
      { id: "resolve-runtime", status: "passed" },
      { id: "resolve-source", status: "passed" },
      { id: "build", status: "passed", evidence: [{ kind: "artifact", digest: `sha256:${"d".repeat(64)}` }] },
      { id: "verify", status: "passed" },
      { id: "aggregate", status: "passed" },
    ],
    evidence: [
      { kind: "platform-manifests", digest: `sha256:${"2".repeat(64)}` },
      { kind: "build-summary", digest: `sha256:${"3".repeat(64)}` },
    ],
  });
  const failed = createControllerReceipt({
    plan: expectedPlan,
    stages: [{ id: "resolve-runtime", status: "passed" }, { id: "resolve-source", status: "failed" }],
    reason: { code: "source-mismatch", summary: "source lock changed" },
  });
  const skipped = createControllerReceipt({
    plan: expectedPlan,
    stages: expectedPlan.expected.stages.map((stage) => ({ id: stage.id, status: "skipped" })),
    reason: { code: "policy-skip", summary: "controller did not apply" },
  });
  const partial = createControllerReceipt({
    plan: expectedPlan,
    stages: [{ id: "resolve-runtime", status: "passed" }, { id: "resolve-source", status: "passed" }],
    reason: { code: "cancelled", summary: "run was cancelled" },
  });

  assert.equal(passed.status, "passed");
  assert.equal(passed.qualifying, true);
  assert.equal(failed.status, "failed");
  assert.equal(skipped.status, "skipped");
  assert.equal(partial.status, "partial");
  assert.equal(validateControllerReceipt(passed, { plan: expectedPlan }).ok, true);
});

test("controller receipts allow optional stages to remain uninstantiated", () => {
  const expectedPlan = createControllerPlan({
    descriptor: descriptor("web-surface"),
    source: { repository: "kungfu-systems/example", sha: SOURCE_SHA },
    runtime: { ref: "v2", sha: RUNTIME_SHA, contractDigest: CONTRACT_DIGEST },
    inputs: {},
  });
  const receipt = createControllerReceipt({
    plan: expectedPlan,
    stages: expectedPlan.expected.stages
      .filter((stage) => stage.required)
      .map((stage) => ({ id: stage.id, status: "passed" })),
    evidence: [{ kind: "web-surface-plan", digest: `sha256:${"d".repeat(64)}` }],
  });

  assert.equal(receipt.status, "passed");
  assert.equal(receipt.qualifying, true);
  assert.equal(
    receipt.stages.find((stage) => stage.id === "publication-authority").status,
    "missing",
  );
  assert.equal(validateControllerReceipt(receipt, { plan: expectedPlan }).qualifying, true);
});

test("source, runtime, and plan mismatches invalidate receipts", () => {
  const expectedPlan = plan();
  const receipt = createControllerReceipt({
    plan: expectedPlan,
    stages: expectedPlan.expected.stages.map((stage) => ({ id: stage.id, status: "passed" })),
    evidence: [
      { kind: "platform-manifests", digest: `sha256:${"4".repeat(64)}` },
      { kind: "build-summary", digest: `sha256:${"5".repeat(64)}` },
    ],
  });
  const validation = validateControllerReceipt(receipt, {
    plan: expectedPlan,
    expectedSourceSha: "e".repeat(40),
    expectedRuntimeSha: "f".repeat(40),
    expectedPlanDigest: `sha256:${"0".repeat(64)}`,
  });

  assert.equal(validation.ok, false);
  assert.match(validation.issues.join("\n"), /source SHA mismatch/);
  assert.match(validation.issues.join("\n"), /runtime SHA mismatch/);
  assert.match(validation.issues.join("\n"), /plan digest mismatch/);
});

test("missing receipts are non-qualifying instead of green", () => {
  const expectedPlan = plan();
  const aggregate = aggregateControllerReceipts({ plans: [expectedPlan], receipts: [] });

  assert.equal(aggregate.status, "receipt-missing");
  assert.equal(aggregate.qualifying, false);
  assert.match(aggregate.issues.join("\n"), /receipt is missing/);
});

test("Shifu profile controller references the Gate aggregate without copying Gate semantics", () => {
  const gateDescriptor = descriptor("shifu-gate-profile-envelope");
  const gatePlan = createControllerPlan({
    descriptor: gateDescriptor,
    source: { repository: "kungfu-systems/example", sha: SOURCE_SHA },
    runtime: { ref: "v2", sha: RUNTIME_SHA, contractDigest: CONTRACT_DIGEST },
    inputs: { profile: "pr" },
  });
  const receipt = createControllerReceipt({
    plan: gatePlan,
    stages: gatePlan.expected.stages.map((stage) => ({ id: stage.id, status: "passed" })),
    evidence: [{ kind: "shifu-gate-aggregate", digest: `sha256:${"1".repeat(64)}` }],
  });
  const serialized = JSON.stringify(receipt);

  assert.match(serialized, /shifu-gate-aggregate/);
  assert.doesNotMatch(serialized, /gateId|gateResults|registry\.projectId/);
});

test("release passports can carry compact controller receipt references", () => {
  const expectedPlan = plan();
  const receipt = createControllerReceipt({
    plan: expectedPlan,
    stages: expectedPlan.expected.stages.map((stage) => ({ id: stage.id, status: "passed" })),
    evidence: [
      { kind: "platform-manifests", digest: `sha256:${"6".repeat(64)}` },
      { kind: "build-summary", digest: `sha256:${"7".repeat(64)}` },
    ],
  });
  const reference = createControllerReceiptReference(receipt);

  assert.deepEqual(Object.keys(reference).sort(), [
    "artifact",
    "controllerId",
    "planDigest",
    "receiptDigest",
    "runtimeSha",
    "sourceSha",
    "status",
  ]);
  assert.equal(reference.receiptDigest, receipt.digest);
  assert.equal(validateControllerReceiptReference(reference, {
    expectedSourceSha: SOURCE_SHA,
    expectedRuntimeSha: RUNTIME_SHA,
  }).ok, true);
  assert.deepEqual(normalizeControllerReceiptReferences({ receipts: [receipt] }), [reference]);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { V4StageCapsuleLocalStore } from "../packages/core/v4-stage-capsule-local-store.js";
import { v4StageCapsuleBlobRoot } from "../packages/core/v4-stage-capsule-store.js";
import {
  emitV4PlatformStageCheckpoint,
  restoreV4PlatformStageCheckpoint,
  validateV4PlatformStageCheckpointDeclaration,
} from "../packages/core/v4-platform-stage-checkpoints.js";

const root = path.resolve(import.meta.dirname, "..");
const declaration = validateV4PlatformStageCheckpointDeclaration(
  JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture/v4-platform-stage-checkpoints.json"),
      "utf8",
    ),
  ),
);
const recordedAt = "2026-08-08T00:00:00.000Z";

function temp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

function rooted(value) {
  return v4StageCapsuleBlobRoot(Buffer.from(`${value}\n`));
}

function buildRequest(directory, overrides = {}) {
  return {
    declaration,
    platformId: "linux-x64",
    stageId: "build",
    stageOutcome: "success",
    recordedAt,
    overheadMs: 3,
    inputs: {
      "dependency-layout": rooted("dependencies"),
      "source-tree": rooted("source"),
    },
    outputs: { "build-output": Buffer.from("production bytes\n") },
    productionOutputRoots: {
      "build-output": v4StageCapsuleBlobRoot(Buffer.from("production bytes\n")),
    },
    productionLifecycleResult: { outcome: "success", stage: "build" },
    shadowLifecycleResult: { outcome: "success", stage: "build" },
    environment: { "build-profile": "release" },
    toolchains: { node: rooted("node-24") },
    runtime: { engine: "node", version: "24" },
    transformation: { commandRoot: rooted("build-command") },
    qualification: { exactBytes: true },
    retentionPromise: {
      class: "wave-evidence",
      retainUntil: "2026-09-08T00:00:00.000Z",
    },
    store: new V4StageCapsuleLocalStore(path.join(directory, "store")),
    ...overrides,
  };
}

test("declaration freezes three isolated platforms and provider-free stage boundaries", () => {
  assert.deepEqual(
    declaration.platforms.map(({ id }) => id),
    ["linux-x64", "macos-arm64", "windows-x64"],
  );
  assert.deepEqual(
    declaration.stages.map(({ id }) => id),
    [
      "checkout-input",
      "install",
      "build",
      "verify",
      "package",
      "signing-preparation",
    ],
  );
  assert.equal(declaration.mode, "shadow-only");
  assert.equal(declaration.authority.productionStageSkipping, false);
  assert.equal(
    declaration.stages.every(
      ({ providerEffects }) => providerEffects === false,
    ),
    true,
  );
});

test("successful checkpoint emits immutable evidence and restores exact bytes", () => {
  const directory = temp("checkpoint");
  const emitted = emitV4PlatformStageCheckpoint(buildRequest(directory));
  assert.equal(emitted.emitted, true);
  assert.equal(emitted.report.productionBytesChanged, false);
  assert.equal(emitted.report.lifecycleResultChanged, false);
  assert.equal(emitted.report.overheadMs, 3);
  const restored = restoreV4PlatformStageCheckpoint({
    declaration,
    expectedPlatform: "linux-x64",
    expectedStage: "build",
    capsuleRoot: emitted.capsule.capsuleRoot,
    recordedAt,
    targetDirectory: path.join(directory, "clean-restore"),
    store: buildRequest(directory).store,
  });
  assert.equal(restored.report.exactRootVerified, true);
  assert.equal(restored.report.providerCredentialsUsed, false);
  assert.equal(
    fs.readFileSync(
      path.join(directory, "clean-restore/build/output.bin"),
      "utf8",
    ),
    "production bytes\n",
  );
});

test("failed stages emit no reusable capsule and prior successful capsules remain", () => {
  const directory = temp("failure-boundary");
  const successful = emitV4PlatformStageCheckpoint(buildRequest(directory));
  const failed = emitV4PlatformStageCheckpoint(
    buildRequest(directory, { stageId: "verify", stageOutcome: "failure" }),
  );
  assert.deepEqual(failed, { emitted: false, reason: "stage-not-successful" });
  assert.equal(
    buildRequest(directory).store.locate({
      capsuleRoot: successful.capsule.capsuleRoot,
      recordedAt,
    }).availability.status,
    "available",
  );
});

test("undeclared input, environment, output, and cross-platform restore fail closed", () => {
  const cases = [
    { inputs: { "source-tree": rooted("source") } },
    { environment: { "build-profile": "release", secret: "forbidden" } },
    {
      outputs: { "build-output": Buffer.from("ok"), extra: Buffer.from("no") },
    },
  ];
  for (const override of cases)
    assert.throws(
      () =>
        emitV4PlatformStageCheckpoint(
          buildRequest(temp("undeclared"), override),
        ),
      /keys do not match the declaration/,
    );
  const directory = temp("platform-mismatch");
  const emitted = emitV4PlatformStageCheckpoint(buildRequest(directory));
  assert.throws(
    () =>
      restoreV4PlatformStageCheckpoint({
        declaration,
        expectedPlatform: "windows-x64",
        expectedStage: "build",
        capsuleRoot: emitted.capsule.capsuleRoot,
        recordedAt,
        targetDirectory: path.join(directory, "wrong-platform"),
        store: buildRequest(directory).store,
      }),
    /restored platform or stage differs/,
  );
});

test("shadow comparison rejects production byte or lifecycle drift", () => {
  assert.throws(
    () =>
      emitV4PlatformStageCheckpoint(
        buildRequest(temp("byte-drift"), {
          productionOutputRoots: { "build-output": rooted("different") },
        }),
      ),
    /shadow checkpoint inputs differ/,
  );
  assert.throws(
    () =>
      emitV4PlatformStageCheckpoint(
        buildRequest(temp("lifecycle-drift"), {
          shadowLifecycleResult: { outcome: "failure", stage: "build" },
        }),
      ),
    /shadow checkpoint inputs differ/,
  );
});

test("clean-process rehearsal runs for each declared platform", () => {
  for (const { id } of declaration.platforms) {
    const directory = temp(`rehearsal-${id}`);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/v4-platform-stage-checkpoint-rehearsal.mjs",
        "rehearse",
        "--work-root",
        directory,
        "--platform",
        id,
        "--stage",
        "build",
        "--recorded-at",
        recordedAt,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.platform, id);
    assert.equal(evidence.exactRootVerified, true);
    assert.equal(evidence.productionBytesChanged, false);
    assert.equal(evidence.lifecycleResultChanged, false);
    assert.equal(evidence.providerCredentialsUsed, false);
  }
});

test("workflow, generated template, and Agent guidance project the declaration", () => {
  for (const file of [
    declaration.projections.protectedWorkflow,
    declaration.projections.generatedTemplate,
    declaration.projections.agentGuidance,
    declaration.projections.manual,
  ]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /architecture\/v4-platform-stage-checkpoints\.json/);
  }
});

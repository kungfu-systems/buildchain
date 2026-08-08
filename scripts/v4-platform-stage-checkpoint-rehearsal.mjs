#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { v4CanonicalBytes } from "../packages/core/v4-canonical-contracts.js";
import { V4StageCapsuleLocalStore } from "../packages/core/v4-stage-capsule-local-store.js";
import { v4StageCapsuleBlobRoot } from "../packages/core/v4-stage-capsule-store.js";
import {
  emitV4PlatformStageCheckpoint,
  restoreV4PlatformStageCheckpoint,
  validateV4PlatformStageCheckpointDeclaration,
} from "../packages/core/v4-platform-stage-checkpoints.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptPath = fileURLToPath(import.meta.url);

function option(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readDeclaration() {
  return validateV4PlatformStageCheckpointDeclaration(
    JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "architecture/v4-platform-stage-checkpoints.json"),
        "utf8",
      ),
    ),
  );
}

function stageFor(declaration, stageId) {
  const stage = declaration.stages.find((entry) => entry.id === stageId);
  if (!stage) throw new Error(`undeclared stage: ${stageId}`);
  return stage;
}

function rooted(label) {
  return v4StageCapsuleBlobRoot(Buffer.from(`${label}\n`, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, v4CanonicalBytes(value), { flag: "wx" });
}

function emit({ workRoot, platformId, stageId, recordedAt }) {
  const declaration = readDeclaration();
  const stage = stageFor(declaration, stageId);
  const inputs = Object.fromEntries(
    stage.inputs.map((name) => [
      name,
      rooted(`${platformId}:${stageId}:input:${name}`),
    ]),
  );
  const environment = Object.fromEntries(
    stage.environment.map((name) => [name, `${platformId}-${name}-declared`]),
  );
  const toolchains = Object.fromEntries(
    stage.toolchains.map((name) => [
      name,
      rooted(`${platformId}:toolchain:${name}`),
    ]),
  );
  const outputs = Object.fromEntries(
    stage.outputs.map(({ name }) => [
      name,
      Buffer.from(
        `${platformId}:${stageId}:${name}:production-bytes\n`,
        "utf8",
      ),
    ]),
  );
  const productionOutputRoots = Object.fromEntries(
    Object.entries(outputs).map(([name, bytes]) => [
      name,
      v4StageCapsuleBlobRoot(bytes),
    ]),
  );
  const store = new V4StageCapsuleLocalStore(path.join(workRoot, "store"));
  const result = emitV4PlatformStageCheckpoint({
    declaration,
    platformId,
    stageId,
    stageOutcome: "success",
    recordedAt,
    overheadMs: 0,
    inputs,
    outputs,
    productionOutputRoots,
    productionLifecycleResult: { outcome: "success", stage: stageId },
    shadowLifecycleResult: { outcome: "success", stage: stageId },
    environment,
    toolchains,
    runtime: { engine: "node", mode: "clean-process-rehearsal" },
    transformation: { command: "fixture-only", providerEffects: false },
    qualification: { exactBytes: true, productionBytesChanged: false },
    retentionPromise: {
      class: "wave-evidence",
      retainUntil: "2026-09-08T00:00:00.000Z",
    },
    store,
  });
  writeJson(path.join(workRoot, "emission.json"), {
    schema: "buildchain-v4-platform-stage-rehearsal-emission/v1",
    platform: platformId,
    stage: stageId,
    capsuleRoot: result.capsule.capsuleRoot,
    report: result.report,
    storeReceipt: result.receipt,
  });
}

function restore({ workRoot, platformId, stageId, recordedAt }) {
  const declaration = readDeclaration();
  const emission = JSON.parse(
    fs.readFileSync(path.join(workRoot, "emission.json"), "utf8"),
  );
  if (emission.platform !== platformId || emission.stage !== stageId)
    throw new Error("emission identity does not match restore request");
  const store = new V4StageCapsuleLocalStore(path.join(workRoot, "store"));
  const result = restoreV4PlatformStageCheckpoint({
    declaration,
    expectedPlatform: platformId,
    expectedStage: stageId,
    capsuleRoot: emission.capsuleRoot,
    recordedAt,
    targetDirectory: path.join(workRoot, "restored"),
    store,
  });
  writeJson(path.join(workRoot, "restore.json"), result.report);
}

function child(action, common) {
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      action,
      "--work-root",
      common.workRoot,
      "--platform",
      common.platformId,
      "--stage",
      common.stageId,
      "--recorded-at",
      common.recordedAt,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      `${action} child failed: ${(result.stderr || result.stdout).trim()}`,
    );
}

const action = process.argv[2] || "";
const common = {
  workRoot: path.resolve(required("work-root")),
  platformId: required("platform"),
  stageId: option("stage", "build"),
  recordedAt: required("recorded-at"),
};

if (action === "emit") emit(common);
else if (action === "restore") restore(common);
else if (action === "rehearse") {
  fs.mkdirSync(common.workRoot, { recursive: true });
  child("emit", common);
  child("restore", common);
  const emission = JSON.parse(
    fs.readFileSync(path.join(common.workRoot, "emission.json"), "utf8"),
  );
  const restored = JSON.parse(
    fs.readFileSync(path.join(common.workRoot, "restore.json"), "utf8"),
  );
  const evidence = {
    schema: "buildchain-v4-platform-stage-clean-process-rehearsal/v1",
    mode: "shadow-only",
    platform: common.platformId,
    stage: common.stageId,
    capsuleRoot: emission.capsuleRoot,
    emissionReportRoot: emission.report.reportRoot,
    restoreReportRoot: restored.reportRoot,
    exactRootVerified: restored.exactRootVerified,
    productionBytesChanged: emission.report.productionBytesChanged,
    lifecycleResultChanged: emission.report.lifecycleResultChanged,
    providerCredentialsUsed: restored.providerCredentialsUsed,
  };
  writeJson(path.join(common.workRoot, "evidence.json"), evidence);
  process.stdout.write(v4CanonicalBytes(evidence));
} else {
  throw new Error("action must be emit, restore, or rehearse");
}

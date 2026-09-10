import fs from "node:fs";
import path from "node:path";
import { domainCanonicalBytes } from "../../../contracts/canonical-contracts.js";
import { StageCapsuleLocalStore } from "../../stage-capsule-local-store.js";
import { stageCapsuleBlobRoot } from "../../stage-capsule-store.js";
import {
  emitPlatformStageCheckpoint,
  restorePlatformStageCheckpoint,
  validatePlatformStageCheckpointDeclaration,
} from "../../platform-stage-checkpoints.js";

import { readDeclaration, stageFor, rooted, writeJson } from "./files.js";
export function emitCheckpointRehearsal({
  workRoot,
  platformId,
  stageId,
  recordedAt,
  runtimeRoot,
}) {
  const declaration = readDeclaration(runtimeRoot);
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
      stageCapsuleBlobRoot(bytes),
    ]),
  );
  const store = new StageCapsuleLocalStore(path.join(workRoot, "store"));
  const result = emitPlatformStageCheckpoint({
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

export function restoreCheckpointRehearsal({
  workRoot,
  platformId,
  stageId,
  recordedAt,
  runtimeRoot,
}) {
  const declaration = readDeclaration(runtimeRoot);
  const emission = JSON.parse(
    fs.readFileSync(path.join(workRoot, "emission.json"), "utf8"),
  );
  if (emission.platform !== platformId || emission.stage !== stageId)
    throw new Error("emission identity does not match restore request");
  const store = new StageCapsuleLocalStore(path.join(workRoot, "store"));
  const result = restorePlatformStageCheckpoint({
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

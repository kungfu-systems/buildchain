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

export function readDeclaration(runtimeRoot) {
  return validatePlatformStageCheckpointDeclaration(
    JSON.parse(
      fs.readFileSync(
        path.join(runtimeRoot, "architecture/platform-stage-checkpoints.json"),
        "utf8",
      ),
    ),
  );
}

export function stageFor(declaration, stageId) {
  const stage = declaration.stages.find((entry) => entry.id === stageId);
  if (!stage) throw new Error(`undeclared stage: ${stageId}`);
  return stage;
}

export function rooted(label) {
  return stageCapsuleBlobRoot(Buffer.from(`${label}\n`, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, domainCanonicalBytes(value), { flag: "wx" });
}

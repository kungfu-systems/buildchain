import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeJson } from "./files.js";
export function rehearseStageCheckpoint(common) {
  fs.mkdirSync(common.workRoot, { recursive: true });
  const worker = path.join(
    common.runtimeRoot,
    "packages/core/build/stage-capsule/rehearsal/worker.js",
  );
  for (const phase of ["emit", "restore"]) {
    const result = spawnSync(process.execPath, [worker], {
      cwd: common.runtimeRoot,
      encoding: "utf8",
      input: JSON.stringify({ phase, request: common }),
    });
    if (result.error || result.status !== 0) {
      const error = new Error(
        `${phase} child failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
      );
      error.status = result.status || 1;
      throw error;
    }
  }
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
  return evidence;
}

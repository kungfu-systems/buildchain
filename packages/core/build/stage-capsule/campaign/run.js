import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
export function runStageCapsuleCampaign(context, { mode = "shadow" } = {}) {
  if (!["shadow", "disabled"].includes(mode))
    throw new Error("stage-capsule-mode must be shadow or disabled");
  if (mode === "disabled")
    return {
      schema: "buildchain-v4-stage-capsule-rollback/v1",
      switch: "stage-capsule-mode=disabled",
      productionAuthority: "v4-native",
      migrationRequired: false,
      retainedStateDestroyed: false,
      productionWrites: false,
    };
  fs.mkdirSync(context.workRoot, { recursive: true });
  const worker = path.join(
    context.repoRoot,
    "packages/core/build/stage-capsule/campaign/worker.js",
  );
  const request = {
    workRoot: context.workRoot,
    platform: context.platform,
    consumer: context.consumer,
    runtimeRef: context.runtimeRef,
    consumerSourceRevision: context.consumerSourceRevision,
    lifecycleEvidenceRoot: context.lifecycleEvidenceRoot,
    consumerRoot: context.consumerRoot,
  };
  let report;
  for (const phase of ["seed", "resume"]) {
    const result = spawnSync(process.execPath, [worker], {
      cwd: context.repoRoot,
      encoding: "utf8",
      input: JSON.stringify({ phase, request }),
    });
    if (result.error || result.status !== 0) {
      const error = new Error(
        `${phase} child failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
      );
      error.status = result.status || 1;
      throw error;
    }
    if (phase === "resume") report = JSON.parse(result.stdout);
  }
  return report;
}

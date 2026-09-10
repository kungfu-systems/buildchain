import fs from "node:fs";
import path from "node:path";
import { planStageCapsuleResume } from "../../stage-capsule-resume-planner.js";
export function rehearseStageResume({ runtimeRoot, platform }) {
  const declaration = JSON.parse(
    fs.readFileSync(
      path.join(runtimeRoot, "architecture/platform-stage-checkpoints.json"),
      "utf8",
    ),
  );
  if (!declaration.platforms.some(({ id }) => id === platform))
    throw new Error(`undeclared platform: ${platform}`);

  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(
        runtimeRoot,
        "contracts/fixtures/v4-stage-capsule-resume-v1/late-platform-failure.json",
      ),
      "utf8",
    ),
  );
  const first = planStageCapsuleResume(fixture);
  const second = planStageCapsuleResume(structuredClone(fixture));
  if (first.planRoot !== second.planRoot)
    throw new Error("resume planner is not deterministic");

  return {
    schema: "buildchain-v4-stage-capsule-resume-rehearsal/v1",
    mode: "shadow-only",
    platform,
    productionAuthority: first.productionAuthority,
    planRoot: first.planRoot,
    requiredRestores: first.requiredRestores,
    requiredStages: first.requiredStages,
    requiredEffects: first.requiredEffects,
  };
}

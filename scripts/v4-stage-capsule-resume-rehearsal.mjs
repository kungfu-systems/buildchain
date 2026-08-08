#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { v4CanonicalBytes } from "../packages/core/v4-canonical-contracts.js";
import { planV4StageCapsuleResume } from "../packages/core/v4-stage-capsule-resume-planner.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const platform = option("platform");
if (!platform) throw new Error("--platform is required");

const declaration = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "architecture/v4-platform-stage-checkpoints.json"),
    "utf8",
  ),
);
if (!declaration.platforms.some(({ id }) => id === platform))
  throw new Error(`undeclared platform: ${platform}`);

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(
      repoRoot,
      "contracts/fixtures/v4-stage-capsule-resume-v1/late-platform-failure.json",
    ),
    "utf8",
  ),
);
const first = planV4StageCapsuleResume(fixture);
const second = planV4StageCapsuleResume(structuredClone(fixture));
if (first.planRoot !== second.planRoot)
  throw new Error("resume planner is not deterministic");

process.stdout.write(
  v4CanonicalBytes({
    schema: "buildchain-v4-stage-capsule-resume-rehearsal/v1",
    mode: "shadow-only",
    platform,
    productionAuthority: first.productionAuthority,
    planRoot: first.planRoot,
    requiredRestores: first.requiredRestores,
    requiredStages: first.requiredStages,
    requiredEffects: first.requiredEffects,
  }),
);

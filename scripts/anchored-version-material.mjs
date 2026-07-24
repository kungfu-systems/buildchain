#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createAnchoredVersionMaterialEvidence } from "../packages/core/anchored-version-material.js";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function writeOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
}

try {
  const cwd = path.resolve(env("BUILDCHAIN_ANCHORED_SOURCE_CWD", process.cwd()));
  const outputPath = path.resolve(
    env(
      "BUILDCHAIN_ANCHORED_MATERIAL_OUTPUT",
      ".buildchain/artifacts/anchored-version-material.json",
    ),
  );
  const evidence = createAnchoredVersionMaterialEvidence({
    cwd,
    targetChannel: env("BUILDCHAIN_ANCHORED_TARGET_CHANNEL"),
    targetRef: env("BUILDCHAIN_ANCHORED_TARGET_REF"),
    alphaRef: env("BUILDCHAIN_ANCHORED_ALPHA_REF"),
    releaseRef: env("BUILDCHAIN_ANCHORED_RELEASE_REF", "HEAD"),
    runLifecycle: env("BUILDCHAIN_ANCHORED_RUN_LIFECYCLE", "true") !== "false",
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeOutput("anchored-version-material-applicable", evidence.applicable === true);
  writeOutput("anchored-version-material-digest", evidence.digest || "");
  writeOutput("anchored-version-material-path", outputPath);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  console.error(`anchored version material: ${error.message}`);
  process.exitCode = 1;
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRunnerEvidence,
  linuxCodeBuildPlan,
  verifyLinuxCodeBuildQualification,
} from "./aws-runner-burst-core.mjs";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function writeJson(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
}

function readJson(inputPath) {
  return JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
}

export function main() {
  const mode = process.argv[2] || "plan";
  if (mode === "plan") {
    const result = linuxCodeBuildPlan();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (mode === "evidence") {
    const result = createRunnerEvidence({
      provider: process.env.BUILDCHAIN_BURST_PROVIDER,
      project: process.env.BUILDCHAIN_BURST_PROJECT,
      repository: process.env.BUILDCHAIN_BURST_SOURCE_REPOSITORY,
      sourceSha: process.env.BUILDCHAIN_BURST_SOURCE_SHA,
      sourceRef: process.env.BUILDCHAIN_BURST_SOURCE_REF,
      runId: process.env.BUILDCHAIN_BURST_RUN_ID,
      runAttempt: process.env.BUILDCHAIN_BURST_RUN_ATTEMPT,
      job: process.env.BUILDCHAIN_BURST_JOB,
      codeBuildBuildId: process.env.CODEBUILD_BUILD_ID,
      codeBuildBuildArn: process.env.CODEBUILD_BUILD_ARN,
      codeBuildInitiator: process.env.CODEBUILD_INITIATOR,
    });
    const output = writeJson(
      process.env.BUILDCHAIN_BURST_EVIDENCE_PATH ||
        ".buildchain/aws-runner-burst.json",
      result,
    );
    process.stdout.write(`${output}\n`);
    return result;
  }
  if (mode === "verify-linux") {
    const inputPath = readArg("input");
    if (!inputPath) throw new Error("verify-linux requires --input");
    const result = verifyLinuxCodeBuildQualification(readJson(inputPath));
    const outputPath = readArg("output");
    if (outputPath) writeJson(outputPath, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.qualifying) process.exitCode = 1;
    return result;
  }
  throw new Error(`unsupported aws-runner-burst mode: ${mode}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message || error}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import { AWS_CODEBUILD_TOOLCHAIN } from "../toolchain/codebuild-policy.js";
import { prepareAwsCodeBuildToolchain } from "../toolchain/codebuild.js";
try {
  const mode = process.argv[2] || "plan";
  if (mode === "plan") console.log(JSON.stringify(AWS_CODEBUILD_TOOLCHAIN, null, 2));
  else if (mode === "prepare") {
    if (!process.env.GITHUB_PATH) throw new Error("GITHUB_PATH is required on the CodeBuild GitHub runner");
    const result = prepareAwsCodeBuildToolchain({ runnerTemp: process.env.RUNNER_TEMP || os.tmpdir(), evidencePath: process.env.BUILDCHAIN_BURST_TOOLCHAIN_EVIDENCE_PATH || ".buildchain/artifacts/linux-x64/aws-native-toolchain.json", buildId: process.env.CODEBUILD_BUILD_ID, environment: process.env });
    for (const directory of result.paths) fs.appendFileSync(process.env.GITHUB_PATH, `${directory}\n`);
    console.log(JSON.stringify(result.evidence, null, 2));
  } else throw new Error(`unsupported aws-codebuild-toolchain mode: ${mode}`);
} catch (error) { console.error(`::error::${error.message}`); process.exitCode = error.status || 1; }

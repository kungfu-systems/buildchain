#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createWindowsJitEvidence,
  renderWindowsJitBootstrap,
  verifyWindowsEc2JitQualification,
  windowsEc2JitPlan,
} from "./aws-windows-jit-core.mjs";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function writeJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
  return resolved;
}

export function main() {
  const mode = process.argv[2] || "plan";
  if (mode === "plan") {
    const result = windowsEc2JitPlan();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (mode === "evidence") {
    const result = createWindowsJitEvidence({
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha:
        process.env.BUILDCHAIN_EXPECTED_SOURCE_SHA || process.env.GITHUB_SHA,
      sourceRef:
        process.env.BUILDCHAIN_EXPECTED_SOURCE_REF || process.env.GITHUB_REF,
      githubRunId: process.env.GITHUB_RUN_ID,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      githubJob: process.env.GITHUB_JOB,
      runnerName: process.env.RUNNER_NAME,
      runnerLabels: JSON.parse(process.env.BUILDCHAIN_RUNNER_LABELS_JSON || "[]"),
      instanceId: process.env.AWS_EC2_INSTANCE_ID,
      instanceType: process.env.AWS_EC2_INSTANCE_TYPE,
      amiId: process.env.AWS_EC2_AMI_ID,
      amiName: process.env.AWS_EC2_AMI_NAME,
      availabilityZone: process.env.AWS_EC2_AVAILABILITY_ZONE,
      launchedAt: process.env.AWS_EC2_LAUNCHED_AT,
      runnerStartedAt: process.env.AWS_EC2_RUNNER_STARTED_AT,
      runnerExitedAt:
        process.env.AWS_EC2_RUNNER_EXITED_AT || new Date().toISOString(),
      terminatedAt: process.env.AWS_EC2_TERMINATED_AT,
      cleanupResult:
        process.env.AWS_EC2_CLEANUP_RESULT || "runner-exit-termination-pending",
      cacheMode: process.env.BUILDCHAIN_CHECKOUT_CACHE_MODE || "off",
    });
    const output = writeJson(
      process.env.BUILDCHAIN_WINDOWS_JIT_EVIDENCE_PATH ||
        ".buildchain/aws-windows-jit.json",
      result,
    );
    process.stdout.write(`${output}\n`);
    return result;
  }
  if (mode === "render-bootstrap") {
    const template = arg(
      "template",
      "infra/aws-us-elastic-runner-burst-plane/windows-jit-bootstrap.ps1",
    );
    const output = arg("output");
    if (!output) throw new Error("render-bootstrap requires --output");
    const result = renderWindowsJitBootstrap(
      fs.readFileSync(path.resolve(template), "utf8"),
      {
        region: arg("region", "us-east-1"),
        jitParameterName: arg("jit-parameter"),
        evidenceBucket: arg("evidence-bucket"),
        runnerLabel: arg("runner-label"),
        sourceSha: arg("source-sha"),
        githubRunId: arg("github-run-id"),
        githubRunAttempt: arg("github-run-attempt", "1"),
        amiId: arg("ami-id"),
        amiName: arg("ami-name"),
        instanceType: arg("instance-type", "c7i.4xlarge"),
        launchedAt: arg("launched-at"),
      },
    );
    const resolved = path.resolve(output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, result);
    process.stdout.write(`${resolved}\n`);
    return resolved;
  }
  if (mode === "verify") {
    const input = arg("input");
    if (!input) throw new Error("verify requires --input");
    const result = verifyWindowsEc2JitQualification(readJson(input));
    const output = arg("output");
    if (output) writeJson(output, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.qualifying) process.exitCode = 1;
    return result;
  }
  throw new Error(`unsupported aws-windows-jit mode: ${mode}`);
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

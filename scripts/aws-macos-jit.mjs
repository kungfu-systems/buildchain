#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMacosJitEvidence,
  macosEc2JitPlan,
  renderMacosJitBootstrap,
  verifyMacosEc2JitQualification,
} from "./aws-macos-jit-core.mjs";

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

export function writeMacosJitQualificationEnvironment(
  githubEnv = process.env.GITHUB_ENV,
) {
  if (!githubEnv) return false;
  fs.appendFileSync(
    path.resolve(githubEnv),
    "BUILDCHAIN_SIGNING_REQUESTS_ENABLED=false\n",
  );
  return true;
}

export function main() {
  const mode = process.argv[2] || "plan";
  if (mode === "plan") {
    const result = macosEc2JitPlan();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (mode === "evidence") {
    const result = createMacosJitEvidence({
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha:
        process.env.BUILDCHAIN_EXPECTED_SOURCE_SHA || process.env.GITHUB_SHA,
      sourceRef:
        process.env.BUILDCHAIN_EXPECTED_SOURCE_REF || process.env.GITHUB_REF,
      githubRunId: process.env.GITHUB_RUN_ID,
      githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
      githubJob: process.env.GITHUB_JOB,
      runnerName: process.env.RUNNER_NAME,
      runnerLabels: JSON.parse(
        process.env.BUILDCHAIN_RUNNER_LABELS_JSON || "[]",
      ),
      hostId: process.env.AWS_EC2_MAC_HOST_ID,
      instanceId: process.env.AWS_EC2_INSTANCE_ID,
      instanceType: process.env.AWS_EC2_INSTANCE_TYPE,
      amiId: process.env.AWS_EC2_AMI_ID,
      amiName: process.env.AWS_EC2_AMI_NAME,
      availabilityZone: process.env.AWS_EC2_AVAILABILITY_ZONE,
      hostAllocatedAt: process.env.AWS_EC2_MAC_HOST_ALLOCATED_AT,
      instanceLaunchedAt: process.env.AWS_EC2_LAUNCHED_AT,
      runnerStartedAt: process.env.AWS_EC2_RUNNER_STARTED_AT,
      runnerExitedAt:
        process.env.AWS_EC2_RUNNER_EXITED_AT || new Date().toISOString(),
      cacheMode: process.env.BUILDCHAIN_CHECKOUT_CACHE_MODE || "off",
    });
    const output = writeJson(
      process.env.BUILDCHAIN_MACOS_JIT_EVIDENCE_PATH ||
        ".buildchain/aws-macos-jit.json",
      result,
    );
    writeMacosJitQualificationEnvironment();
    process.stdout.write(`${output}\n`);
    return result;
  }
  if (mode === "render-bootstrap") {
    const template = arg(
      "template",
      "infra/aws-us-elastic-runner-burst-plane/macos-jit-bootstrap.sh",
    );
    const output = arg("output");
    if (!output) throw new Error("render-bootstrap requires --output");
    const result = renderMacosJitBootstrap(
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
        hostId: arg("host-id"),
        instanceType: arg("instance-type", "mac2.metal"),
        hostAllocatedAt: arg("host-allocated-at"),
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
    const result = verifyMacosEc2JitQualification(readJson(input));
    const output = arg("output");
    if (output) writeJson(output, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.qualifying) process.exitCode = 1;
    return result;
  }
  throw new Error(`unsupported aws-macos-jit mode: ${mode}`);
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

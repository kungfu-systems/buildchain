// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AWS_MACOS_JIT_CONTROLLER_CONTRACT } from "./aws-macos-jit-controller-core.mjs";
import {
  assertOwnership,
  awsArgs,
  commandResult,
  ghJson,
  jsonResult,
  requireSuccess,
} from "./aws-macos-jit-controller-runtime.mjs";
import { renderMacosJitBootstrap } from "./aws-macos-jit-core.mjs";

function assertExactJobPreflight(plan, profile) {
  const run = ghJson(
    ["api", `repos/${plan.repository}/actions/runs/${plan.github.runId}`],
    undefined,
    "GitHub run preflight",
  );
  if (
    run.event !== plan.github.event ||
    run.head_sha !== plan.source.sha ||
    run.head_repository?.full_name !== plan.repository ||
    !["queued", "in_progress"].includes(run.status)
  ) {
    throw new Error("GitHub run is not the trusted exact-source dispatch");
  }
  const job = ghJson(
    ["api", `repos/${plan.repository}/actions/jobs/${plan.github.jobId}`],
    undefined,
    "GitHub job preflight",
  );
  if (job.status !== "queued") {
    throw new Error(
      `GitHub job must be queued, observed ${job.status || "unknown"}`,
    );
  }
  if (
    !Array.isArray(job.labels) ||
    !plan.runner.labels.every((label) => job.labels.includes(label))
  ) {
    throw new Error("GitHub job labels do not match the macOS JIT job plan");
  }
  const host = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "describe-hosts",
        "--host-ids",
        plan.aws.hostId,
        "--output",
        "json",
      ]),
    ),
    "macOS campaign host preflight",
  ).Hosts?.[0];
  if (
    !host ||
    host.State !== "available" ||
    host.AvailabilityZone !== plan.aws.availabilityZone ||
    host.HostProperties?.InstanceType !== plan.aws.instanceType
  ) {
    throw new Error("macOS campaign host identity or state mismatch");
  }
  assertOwnership(host.Tags, plan);
  const instance = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "describe-instances",
        "--instance-ids",
        plan.aws.instanceId,
        "--output",
        "json",
      ]),
    ),
    "macOS campaign instance preflight",
  ).Reservations?.[0]?.Instances?.[0];
  if (
    !instance ||
    instance.State?.Name !== "running" ||
    instance.Placement?.HostId !== plan.aws.hostId ||
    instance.ImageId !== plan.aws.amiId ||
    instance.InstanceType !== plan.aws.instanceType
  ) {
    throw new Error("macOS campaign instance identity or state mismatch");
  }
  assertOwnership(instance.Tags, plan);
  const parameters = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ssm",
        "describe-parameters",
        "--parameter-filters",
        `Key=Name,Option=Equals,Values=${plan.aws.jitParameterName}`,
        "--output",
        "json",
      ]),
    ),
    "macOS JIT parameter preflight",
  );
  if ((parameters.Parameters || []).length !== 0) {
    throw new Error("macOS JIT parameter already exists");
  }
  return {
    runStatus: run.status,
    jobStatus: job.status,
    hostState: host.State,
    instanceState: instance.State.Name,
  };
}

function deleteRunnerRegistration(plan) {
  const runners = ghJson(
    ["api", `repos/${plan.repository}/actions/runners?per_page=100`],
    undefined,
    "GitHub runner cleanup lookup",
  ).runners;
  const runner = (runners || []).find(
    (entry) => entry.name === plan.runner.name,
  );
  if (!runner) return false;
  requireSuccess(
    commandResult("gh", [
      "api",
      "--method",
      "DELETE",
      `repos/${plan.repository}/actions/runners/${runner.id}`,
    ]),
    "GitHub runner cleanup",
  );
  return true;
}

function waitForSsmOnline(plan, profile, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = jsonResult(
      commandResult(
        "aws",
        awsArgs(plan, profile, [
          "ssm",
          "describe-instance-information",
          "--filters",
          `Key=InstanceIds,Values=${plan.aws.instanceId}`,
          "--output",
          "json",
        ]),
      ),
      "macOS SSM online preflight",
    );
    const found = (response.InstanceInformationList || []).find(
      (entry) =>
        entry.InstanceId === plan.aws.instanceId &&
        entry.PingStatus === "Online",
    );
    if (found) return found;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  throw new Error("macOS campaign instance did not become SSM Online in time");
}

function cleanupFailedCommand(plan, profile, parameterCreated) {
  const failures = [];
  const attempt = (cleanup) => {
    try {
      cleanup();
    } catch (error) {
      failures.push(error.message || String(error));
    }
  };
  if (parameterCreated) {
    attempt(() =>
      requireSuccess(
        commandResult(
          "aws",
          awsArgs(plan, profile, [
            "ssm",
            "delete-parameter",
            "--name",
            plan.aws.jitParameterName,
          ]),
        ),
        "macOS JIT parameter cleanup",
      ),
    );
  }
  attempt(() => deleteRunnerRegistration(plan));
  return failures;
}

function createJitParameter(plan, profile, parameterInputPath) {
  const jit = ghJson(
    [
      "api",
      "--method",
      "POST",
      `repos/${plan.repository}/actions/runners/generate-jitconfig`,
      "--input",
      "-",
    ],
    JSON.stringify({
      name: plan.runner.name,
      runner_group_id: 1,
      labels: plan.runner.labels,
      work_folder: "_work",
    }),
    "GitHub JIT configuration",
  ).encoded_jit_config;
  if (!jit || typeof jit !== "string") {
    throw new Error("GitHub JIT configuration was empty");
  }
  fs.writeFileSync(
    parameterInputPath,
    JSON.stringify({
      Name: plan.aws.jitParameterName,
      Description: `One-shot macOS GitHub Actions JIT config for ${plan.repository} run ${plan.github.runId}`,
      Type: "SecureString",
      Tier: "Advanced",
      Value: jit,
      Tags: [
        { Key: "kungfu:owner", Value: "buildchain" },
        { Key: "kungfu:plane", Value: "aws-us-elastic-runner-burst" },
        { Key: "kungfu:provider", Value: "macos-ec2-jit" },
        { Key: "kungfu:campaign-id", Value: plan.campaign.id },
        { Key: "kungfu:github-run-id", Value: plan.github.runId },
        { Key: "kungfu:qualification-id", Value: plan.github.qualificationId },
      ],
    }),
    { mode: 0o600 },
  );
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ssm",
        "put-parameter",
        "--cli-input-json",
        `file://${parameterInputPath}`,
        "--output",
        "json",
      ]),
    ),
    "macOS JIT parameter creation",
  );
}

function sendBootstrap(plan, profile, { bootstrapPath, commandInputPath }) {
  fs.writeFileSync(
    bootstrapPath,
    renderMacosJitBootstrap(
      fs.readFileSync(
        path.resolve(
          "infra/aws-us-elastic-runner-burst-plane/macos-jit-bootstrap.sh",
        ),
        "utf8",
      ),
      {
        region: plan.aws.region,
        jitParameterName: plan.aws.jitParameterName,
        evidenceBucket: plan.aws.evidenceBucket,
        runnerLabel: plan.runner.label,
        sourceSha: plan.source.sha,
        githubRunId: plan.github.runId,
        githubRunAttempt: plan.github.runAttempt,
        amiId: plan.aws.amiId,
        amiName: plan.aws.amiName,
        hostId: plan.aws.hostId,
        instanceType: plan.aws.instanceType,
        hostAllocatedAt: plan.aws.hostAllocatedAt,
      },
    ),
    { mode: 0o600 },
  );
  const ssm = waitForSsmOnline(plan, profile);
  const remotePath = `/private/tmp/kungfu-macos-jit-${plan.github.runId}-${plan.github.qualificationId}.sh`;
  const bootstrapBase64 = fs.readFileSync(bootstrapPath).toString("base64");
  fs.writeFileSync(
    commandInputPath,
    JSON.stringify({
      DocumentName: "AWS-RunShellScript",
      InstanceIds: [plan.aws.instanceId],
      Comment: `kungfu macOS JIT ${plan.campaign.id} ${plan.github.qualificationId}`,
      TimeoutSeconds: 10800,
      Parameters: {
        commands: [
          `printf '%s' '${bootstrapBase64}' | base64 --decode > '${remotePath}'`,
          `chmod 700 '${remotePath}'`,
          `sudo /bin/bash '${remotePath}'`,
          `status=$?; rm -f '${remotePath}'; exit $status`,
        ],
        executionTimeout: ["10800"],
      },
    }),
    { mode: 0o600 },
  );
  const sent = jsonResult(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ssm",
        "send-command",
        "--cli-input-json",
        `file://${commandInputPath}`,
        "--output",
        "json",
      ]),
    ),
    "macOS JIT SSM command",
  );
  const commandId = sent.Command?.CommandId;
  if (!/^[0-9a-f-]{36}$/.test(String(commandId || ""))) {
    throw new Error("SSM SendCommand returned no command identity");
  }
  return { commandId, ssmAgentVersion: ssm.AgentVersion };
}

function dispatchMacosJitJob(plan, profile, files, state) {
  createJitParameter(plan, profile, files.parameterInputPath);
  state.parameterCreated = true;
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "create-tags",
        "--resources",
        plan.aws.instanceId,
        "--tags",
        `Key=kungfu:jit-parameter,Value=${plan.aws.jitParameterName}`,
      ]),
    ),
    "macOS campaign instance JIT tag update",
  );
  return sendBootstrap(plan, profile, files);
}

export function executeMacosJitJob(plan, { profile = "" } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "job-run-plan"
  ) {
    throw new Error("macOS JIT job plan contract is invalid");
  }
  const preflight = assertExactJobPreflight(plan, profile);
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-macos-jit-controller-"),
  );
  fs.chmodSync(tempRoot, 0o700);
  const files = {
    parameterInputPath: path.join(tempRoot, "ssm-parameter.json"),
    bootstrapPath: path.join(tempRoot, "bootstrap.sh"),
    commandInputPath: path.join(tempRoot, "ssm-command.json"),
  };
  const state = { parameterCreated: false };
  try {
    const sent = dispatchMacosJitJob(plan, profile, files, state);
    return {
      schemaVersion: 1,
      contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
      kind: "job-command-result",
      status: "command-sent",
      campaign: plan.campaign,
      source: plan.source,
      github: plan.github,
      runner: plan.runner,
      aws: {
        region: plan.aws.region,
        hostId: plan.aws.hostId,
        instanceId: plan.aws.instanceId,
        ...sent,
        jitParameterName: plan.aws.jitParameterName,
      },
      preflight,
      planDigest: plan.digest,
    };
  } catch (error) {
    const failures = cleanupFailedCommand(
      plan,
      profile,
      state.parameterCreated,
    );
    if (failures.length) {
      throw new Error(
        `${error.message || error}; cleanup failed: ${failures.join("; ")}`,
      );
    }
    throw error;
  } finally {
    for (const file of Object.values(files)) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(tempRoot);
  }
}

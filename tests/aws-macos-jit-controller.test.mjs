// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AWS_MACOS_JIT_CONTROLLER_CONTRACT,
  createMacosJitCampaignPlan,
  createMacosJitClosePlan,
  createMacosJitJobPlan,
  macosAllocateHostsArgs,
  macosReleaseHostsArgs,
  macosRunInstancesArgs,
} from "../scripts/aws-macos-jit-controller-core.mjs";
import { materializeCommandShim } from "./helpers/command-shim.mjs";

const values = {
  repository: "kungfu-systems/kungfu",
  campaignId: "mac-20260802-f60591b3",
  sourceSha: "f60591b3565b3b75f1b9cfe402ab025e6beeb678",
  sourceRef: "refs/heads/ci/aws-macos-burst-qualification-20260802-f60591b3",
  region: "us-east-1",
  availabilityZone: "us-east-1a",
  instanceType: "mac2.metal",
  amiId: "ami-0a337ecd4cb8e307f",
  amiName: "amzn-ec2-macos-26.5.2-20260717-205726-arm64",
  subnetId: "subnet-fa5c77b7",
  securityGroupId: "sg-0123456789abcdef0",
  instanceProfileName: "kungfu-buildchain-macos-jit-RunnerInstanceProfile-test",
  evidenceBucket: "kungfu-buildchain-macos-jit-evidence-test",
};

function campaignPlan(overrides = {}) {
  return createMacosJitCampaignPlan({
    ...values,
    createdAt: "2026-08-02T01:00:00Z",
    ...overrides,
  });
}

function jobPlan(overrides = {}) {
  return createMacosJitJobPlan({
    ...values,
    runId: "30730000001",
    runAttempt: "1",
    jobId: "91450000001",
    qualificationId: "mac-smoke-01",
    runnerLabel: "aws-us-ec2-macos-jit-mac-smoke-01",
    runnerName: "kungfu-mac-smoke-01-30730000001-1",
    hostId: "h-0123456789abcdef0",
    instanceId: "i-0123456789abcdef0",
    hostAllocatedAt: "2026-08-02T01:05:00Z",
    ...overrides,
  });
}

test("macOS controller binds one campaign host and one reusable instance", () => {
  const plan = campaignPlan();
  assert.equal(plan.contract, AWS_MACOS_JIT_CONTROLLER_CONTRACT);
  assert.equal(plan.safety.activeHostCeiling, 1);
  assert.equal(plan.safety.activeInstanceCeiling, 1);
  assert.equal(plan.safety.minimumHostAllocationHours, 24);
  assert.equal(plan.safety.retainHostOnInstanceLaunchFailure, true);
  assert.ok(
    plan.aws.hostTags.some(
      (entry) =>
        entry.Key === "kungfu:campaign-id" &&
        entry.Value === "mac-20260802-f60591b3",
    ),
  );
});

test("macOS controller requires a unique exact qualification label per job", () => {
  const plan = jobPlan();
  assert.equal(
    plan.aws.jitParameterName,
    "/kungfu/burst/macos/mac-20260802-f60591b3/30730000001/1/mac-smoke-01",
  );
  assert.deepEqual(plan.runner.labels, [
    "self-hosted",
    "macOS",
    "ARM64",
    "aws-us-ec2-macos-jit-mac-smoke-01",
  ]);
  assert.throws(
    () =>
      jobPlan({
        runnerLabel: "aws-us-ec2-macos-jit-mac-smoke-02",
      }),
    /runnerLabel must be aws-us-ec2-macos-jit-mac-smoke-01/,
  );
});

test("macOS AllocateHosts and RunInstances enforce DryRun, host placement, and stop reuse", () => {
  const plan = campaignPlan();
  const allocate = macosAllocateHostsArgs(plan, { dryRun: true });
  assert.equal(allocate.includes("--dry-run"), true);
  assert.equal(allocate[allocate.indexOf("--quantity") + 1], "1");
  const launch = macosRunInstancesArgs(plan, {
    hostId: "h-0123456789abcdef0",
    dryRun: true,
  });
  assert.equal(launch.includes("--dry-run"), true);
  assert.deepEqual(JSON.parse(launch[launch.indexOf("--placement") + 1]), {
    HostId: "h-0123456789abcdef0",
    Tenancy: "host",
  });
  assert.equal(
    launch[launch.indexOf("--instance-initiated-shutdown-behavior") + 1],
    "stop",
  );
});

test("macOS close plan refuses release before the 24-hour provider minimum", () => {
  assert.throws(
    () =>
      createMacosJitClosePlan({
        ...values,
        hostId: "h-0123456789abcdef0",
        instanceId: "i-0123456789abcdef0",
        hostAllocatedAt: "2026-08-02T01:05:00Z",
        observedAt: "2026-08-03T01:04:59Z",
      }),
    /cannot be closed before 24 hours/,
  );
  const plan = createMacosJitClosePlan({
    ...values,
    hostId: "h-0123456789abcdef0",
    instanceId: "i-0123456789abcdef0",
    hostAllocatedAt: "2026-08-02T01:05:00Z",
    observedAt: "2026-08-03T01:05:01Z",
  });
  assert.equal(plan.lifecycle.allocationHours > 24, true);
  assert.equal(
    macosReleaseHostsArgs(plan, { dryRun: true }).includes("--dry-run"),
    true,
  );
});

function installFakes(tempRoot) {
  const fake = (name, source) => {
    const file = path.join(tempRoot, name);
    materializeCommandShim(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  };
  fake(
    "gh",
    String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ command: "gh", args }) + "\n");
const joined = args.join(" ");
if (joined.includes("commits/f60591b3565b3b75f1b9cfe402ab025e6beeb678")) {
  process.stdout.write(JSON.stringify({ sha: "f60591b3565b3b75f1b9cfe402ab025e6beeb678" }));
} else if (joined.includes("actions/runs/30730000001")) {
  process.stdout.write(JSON.stringify({ event: "workflow_dispatch", head_sha: "f60591b3565b3b75f1b9cfe402ab025e6beeb678", head_repository: { full_name: "kungfu-systems/kungfu" }, status: "queued" }));
} else if (joined.includes("actions/jobs/91450000001")) {
  process.stdout.write(JSON.stringify({ status: "queued", labels: ["self-hosted", "macOS", "ARM64", "aws-us-ec2-macos-jit-mac-smoke-01"] }));
} else if (joined.includes("generate-jitconfig")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({ encoded_jit_config: "secret-macos-jit-config" })));
} else if (joined.includes("actions/runners?per_page=100")) {
  process.stdout.write(JSON.stringify({ runners: [{ id: 99, name: "kungfu-mac-smoke-01-30730000001-1" }] }));
} else if (args.includes("DELETE")) {
  process.stdout.write("");
} else {
  process.stderr.write("unexpected gh command: " + joined);
  process.exitCode = 2;
}
`,
  );
  fake(
    "aws",
    String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const joined = args.join(" ");
let metadata = {};
if (joined.includes("--cli-input-json")) {
  const input = args[args.indexOf("--cli-input-json") + 1].replace(/^file:\/\//, "");
  metadata = { inputMode: fs.statSync(input).mode & 0o777 };
  if (joined.includes("ssm put-parameter")) {
    const payload = JSON.parse(fs.readFileSync(input, "utf8"));
    if (payload.Value !== "secret-macos-jit-config") process.exit(3);
  }
  if (joined.includes("ssm send-command")) {
    const payload = fs.readFileSync(input, "utf8");
    if (payload.includes("secret-macos-jit-config")) process.exit(4);
  }
}
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ command: "aws", args, ...metadata }) + "\n");
if (joined.includes("ec2 describe-hosts") && joined.includes("--host-ids")) {
  process.stdout.write(JSON.stringify({ Hosts: [{ HostId: "h-0123456789abcdef0", State: "available", AvailabilityZone: "us-east-1a", AllocationTime: "2026-08-02T01:05:00Z", HostProperties: { InstanceType: "mac2.metal" }, Tags: [
    { Key: "kungfu:owner", Value: "buildchain" }, { Key: "kungfu:plane", Value: "aws-us-elastic-runner-burst" }, { Key: "kungfu:provider", Value: "macos-ec2-jit" }, { Key: "kungfu:campaign-id", Value: "mac-20260802-f60591b3" }, { Key: "kungfu:source-sha", Value: "f60591b3565b3b75f1b9cfe402ab025e6beeb678" }
  ] }] }));
} else if (joined.includes("ec2 describe-hosts")) {
  process.stdout.write(JSON.stringify({ Hosts: [] }));
} else if (joined.includes("ec2 describe-instances") && joined.includes("--instance-ids")) {
  process.stdout.write(JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0123456789abcdef0", State: { Name: "running" }, Placement: { HostId: "h-0123456789abcdef0" }, ImageId: "ami-0a337ecd4cb8e307f", InstanceType: "mac2.metal", BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { VolumeId: "vol-0123456789abcdef0", DeleteOnTermination: true } }], Tags: [
    { Key: "kungfu:owner", Value: "buildchain" }, { Key: "kungfu:plane", Value: "aws-us-elastic-runner-burst" }, { Key: "kungfu:provider", Value: "macos-ec2-jit" }, { Key: "kungfu:campaign-id", Value: "mac-20260802-f60591b3" }, { Key: "kungfu:source-sha", Value: "f60591b3565b3b75f1b9cfe402ab025e6beeb678" }
  ] }] }] }));
} else if (joined.includes("ec2 describe-instances")) {
  process.stdout.write(JSON.stringify({ Reservations: [] }));
} else if (joined.includes("ec2 describe-images")) {
  process.stdout.write(JSON.stringify({ Images: [{ Name: "amzn-ec2-macos-26.5.2-20260717-205726-arm64", Architecture: "arm64_mac", State: "available", OwnerId: "amazon" }] }));
} else if (joined.includes("ec2 describe-subnets")) {
  process.stdout.write(JSON.stringify({ Subnets: [{ SubnetId: "subnet-fa5c77b7", AvailabilityZone: "us-east-1a" }] }));
} else if (joined.includes("ec2 describe-volumes")) {
  process.stdout.write(JSON.stringify({ Volumes: [{ VolumeId: "vol-0123456789abcdef0", Encrypted: true }] }));
} else if (joined.includes("ec2 allocate-hosts") && args.includes("--dry-run")) {
  process.stderr.write("DryRunOperation"); process.exitCode = 255;
} else if (joined.includes("ec2 allocate-hosts")) {
  process.stdout.write(JSON.stringify({ HostIds: ["h-0123456789abcdef0"] }));
} else if (joined.includes("ec2 run-instances") && args.includes("--dry-run")) {
  process.stderr.write("DryRunOperation"); process.exitCode = 255;
} else if (joined.includes("ec2 run-instances")) {
  process.stdout.write(JSON.stringify({ Instances: [{ InstanceId: "i-0123456789abcdef0", InstanceType: "mac2.metal", ImageId: "ami-0a337ecd4cb8e307f", LaunchTime: "2026-08-02T01:06:00Z" }] }));
} else if (joined.includes("ec2 wait instance-running") || joined.includes("ec2 wait instance-terminated") || joined.includes("ec2 create-tags")) {
  process.stdout.write("");
} else if (joined.includes("ssm describe-parameters")) {
  process.stdout.write(JSON.stringify({ Parameters: [] }));
} else if (joined.includes("ssm put-parameter")) {
  process.stdout.write(JSON.stringify({ Version: 1, Tier: "Advanced" }));
} else if (joined.includes("ssm describe-instance-information")) {
  process.stdout.write(JSON.stringify({ InstanceInformationList: [{ InstanceId: "i-0123456789abcdef0", PingStatus: "Online", AgentVersion: "3.3.3050.0" }] }));
} else if (joined.includes("ssm send-command")) {
  if (process.env.FAKE_SEND_FAILURE === "true") { process.stderr.write("simulated send failure"); process.exitCode = 255; }
  else process.stdout.write(JSON.stringify({ Command: { CommandId: "12345678-1234-1234-1234-123456789abc" } }));
} else if (joined.includes("ssm delete-parameter")) {
  process.stdout.write(JSON.stringify({ ok: true }));
} else if (joined.includes("ec2 terminate-instances")) {
  process.stdout.write(JSON.stringify({ TerminatingInstances: [{ InstanceId: "i-0123456789abcdef0" }] }));
} else if (joined.includes("ec2 release-hosts") && args.includes("--dry-run")) {
  process.stderr.write("DryRunOperation"); process.exitCode = 255;
} else if (joined.includes("ec2 release-hosts")) {
  process.stdout.write(JSON.stringify({ Successful: ["h-0123456789abcdef0"], Unsuccessful: [] }));
} else {
  process.stderr.write("unexpected aws command: " + joined);
  process.exitCode = 2;
}
`,
  );
}

function commonCliArgs() {
  return [
    "--campaign-id",
    values.campaignId,
    "--source-sha",
    values.sourceSha,
    "--source-ref",
    values.sourceRef,
    "--availability-zone",
    values.availabilityZone,
    "--ami-id",
    values.amiId,
    "--ami-name",
    values.amiName,
    "--subnet-id",
    values.subnetId,
    "--security-group-id",
    values.securityGroupId,
    "--instance-profile-name",
    values.instanceProfileName,
    "--evidence-bucket",
    values.evidenceBucket,
  ];
}

test("macOS controller launches only after exact-source preflight and both AWS DryRuns", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mac-jit-launch-test-"),
  );
  const commandLog = path.join(tempRoot, "commands.jsonl");
  installFakes(tempRoot);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/aws-macos-jit-controller.mjs",
        "launch-campaign",
        "--execute",
        "--confirm-source-sha",
        values.sourceSha,
        "--confirm-campaign-id",
        values.campaignId,
        "--created-at",
        "2026-08-02T01:00:00Z",
        ...commonCliArgs(),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
          FAKE_COMMAND_LOG: commandLog,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.aws.hostId, "h-0123456789abcdef0");
    assert.equal(output.aws.instanceId, "i-0123456789abcdef0");
    const commands = fs
      .readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const allocateIndexes = commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.args.includes("allocate-hosts"));
    const runIndexes = commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.args.includes("run-instances"));
    assert.equal(allocateIndexes.length, 2);
    assert.equal(runIndexes.length, 2);
    assert.equal(allocateIndexes[0].entry.args.includes("--dry-run"), true);
    assert.equal(allocateIndexes[1].entry.args.includes("--dry-run"), false);
    assert.equal(runIndexes[0].entry.args.includes("--dry-run"), true);
    assert.equal(runIndexes[1].entry.args.includes("--dry-run"), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true });
  }
});

function runJobWithFakes({ sendFailure = false } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mac-jit-job-test-"));
  const commandLog = path.join(tempRoot, "commands.jsonl");
  installFakes(tempRoot);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/aws-macos-jit-controller.mjs",
      "run-job",
      "--execute",
      "--confirm-source-sha",
      values.sourceSha,
      "--confirm-campaign-id",
      values.campaignId,
      "--confirm-run-id",
      "30730000001",
      "--run-id",
      "30730000001",
      "--job-id",
      "91450000001",
      "--qualification-id",
      "mac-smoke-01",
      "--runner-label",
      "aws-us-ec2-macos-jit-mac-smoke-01",
      "--runner-name",
      "kungfu-mac-smoke-01-30730000001-1",
      "--host-id",
      "h-0123456789abcdef0",
      "--instance-id",
      "i-0123456789abcdef0",
      "--host-allocated-at",
      "2026-08-02T01:05:00Z",
      ...commonCliArgs(),
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
        FAKE_COMMAND_LOG: commandLog,
        FAKE_SEND_FAILURE: sendFailure ? "true" : "false",
      },
    },
  );
  const commands = fs
    .readFileSync(commandLog, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  return { tempRoot, result, commands };
}

test("macOS controller keeps JIT secret out of argv and sends bootstrap through 0600 files", () => {
  const { tempRoot, result, commands } = runJobWithFakes();
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(JSON.stringify(commands), /secret-macos-jit-config/);
    const fileInputs = commands.filter(
      (entry) => entry.inputMode !== undefined,
    );
    assert.ok(fileInputs.length >= 2);
    if (process.platform !== "win32") {
      assert.ok(fileInputs.every((entry) => entry.inputMode === 0o600));
    }
    const sent = commands.find((entry) => entry.args.includes("send-command"));
    assert.ok(sent);
    assert.equal(JSON.parse(result.stdout).status, "command-sent");
  } finally {
    fs.rmSync(tempRoot, { recursive: true });
  }
});

test("macOS controller removes the JIT parameter and runner after SendCommand failure", () => {
  const { tempRoot, result, commands } = runJobWithFakes({ sendFailure: true });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /simulated send failure/);
    assert.ok(
      commands.some((entry) => entry.args.includes("delete-parameter")),
    );
    assert.ok(
      commands.some(
        (entry) => entry.command === "gh" && entry.args.includes("DELETE"),
      ),
    );
    assert.doesNotMatch(JSON.stringify(commands), /secret-macos-jit-config/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true });
  }
});

test("macOS controller terminates the exact instance before releasing the 24-hour host", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "mac-jit-close-test-"),
  );
  const commandLog = path.join(tempRoot, "commands.jsonl");
  installFakes(tempRoot);
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/aws-macos-jit-controller.mjs",
        "close-campaign",
        "--execute",
        "--confirm-source-sha",
        values.sourceSha,
        "--confirm-campaign-id",
        values.campaignId,
        "--host-id",
        "h-0123456789abcdef0",
        "--instance-id",
        "i-0123456789abcdef0",
        "--host-allocated-at",
        "2026-08-02T01:05:00Z",
        "--observed-at",
        "2026-08-03T01:05:01Z",
        ...commonCliArgs(),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
          FAKE_COMMAND_LOG: commandLog,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "released");
    const commands = fs
      .readFileSync(commandLog, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const terminate = commands.findIndex((entry) =>
      entry.args.includes("terminate-instances"),
    );
    const wait = commands.findIndex(
      (entry) =>
        entry.args.includes("wait") &&
        entry.args.includes("instance-terminated"),
    );
    const releases = commands
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.args.includes("release-hosts"));
    assert.ok(terminate >= 0);
    assert.ok(wait > terminate);
    assert.equal(releases.length, 2);
    assert.ok(releases[0].index > wait);
    assert.equal(releases[0].entry.args.includes("--dry-run"), true);
    assert.equal(releases[1].entry.args.includes("--dry-run"), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true });
  }
});

// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AWS_WINDOWS_JIT_CONTROLLER_CONTRACT,
  createWindowsJitLaunchPlan,
  windowsRunInstancesArgs,
} from "../scripts/aws-windows-jit-controller-core.mjs";
import {
  createWindowsJitCampaignArmPlan,
  windowsCampaignArmItems,
  windowsCampaignKillArgs,
  windowsCampaignReservationItems,
} from "../scripts/aws-windows-jit-campaign-core.mjs";
import { materializeCommandShim } from "./helpers/command-shim.mjs";

function launchPlan(overrides = {}) {
  return createWindowsJitLaunchPlan({
    repository: "kungfu-systems/kungfu",
    runId: "30679299189",
    runAttempt: "1",
    jobId: "91315129066",
    qualificationId: "win-full-01",
    campaignId: "win-20260802-ledger",
    runnerLabel: "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01",
    runnerName: "kungfu-win-full-01-30679299189-1",
    sourceSha: "a".repeat(40),
    sourceRef:
      "refs/heads/ci/aws-windows-burst-qualification-20260801-2d64b68a",
    region: "us-east-1",
    instanceType: "c7i.4xlarge",
    amiId: "ami-013acec81a2c8ff79",
    amiName: "Windows_Server-2025-English-Full-Base-2026.07.15",
    subnetId: "subnet-fa5c77b7",
    securityGroupId: "sg-0c6e6c9c6849e24f9",
    instanceProfileName:
      "kungfu-buildchain-windows-jit-RunnerInstanceProfile-aZfB20hvOmdz",
    evidenceBucket: "kungfu-buildchain-windows-jit-evidencebucket-3vq75oz26vmc",
    stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
    launchedAt: "2026-08-01T02:45:54Z",
    ...overrides,
  });
}

test("Windows controller binds exact run, source, JIT label, and IaC ownership", () => {
  const plan = launchPlan();
  assert.equal(plan.contract, AWS_WINDOWS_JIT_CONTROLLER_CONTRACT);
  assert.equal(plan.safety.applyMode, "dry-run");
  assert.equal(plan.safety.jitConfigInArgv, false);
  assert.equal(plan.safety.jitConfigInUserData, false);
  assert.equal(plan.safety.persistentCampaignLedgerRequired, true);
  assert.equal(plan.safety.campaignAcceptedInstanceCeiling, 5);
  assert.equal(plan.safety.campaignReservationUsd, 4.35);
  assert.equal(
    plan.github.displayTitle,
    "AWS Windows JIT win-20260802-ledger win-full-01",
  );
  assert.equal(
    plan.aws.jitParameterName,
    "/kungfu/burst/windows/30679299189/1/win-full-01",
  );
  assert.deepEqual(plan.runner.labels, [
    "self-hosted",
    "Windows",
    "X64",
    "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01",
  ]);
  assert.ok(
    plan.aws.instanceTags.some(
      (entry) =>
        entry.Key === "kungfu:provider" && entry.Value === "windows-ec2-jit",
    ),
  );
  assert.ok(
    plan.aws.instanceTags.some(
      (entry) =>
        entry.Key === "kungfu:jit-parameter" &&
        entry.Value === plan.aws.jitParameterName,
    ),
  );
  assert.ok(
    plan.aws.instanceTags.some(
      (entry) =>
        entry.Key === "kungfu:campaign-id" &&
        entry.Value === "win-20260802-ledger",
    ),
  );
});

test("Windows campaign is one-shot, source-bound, and atomically capped", () => {
  const campaign = createWindowsJitCampaignArmPlan({
    campaignId: "win-20260802-ledger",
    sourceSha: "a".repeat(40),
    stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
    armedAt: "2026-08-02T03:00:00Z",
    expiresAt: "2026-08-03T03:00:00Z",
    phaseSpendBaselineUsd: 51.98572625,
  });
  const arm = windowsCampaignArmItems(campaign);
  assert.equal(arm.length, 2);
  assert.equal(arm[0].Put.ConditionExpression, "attribute_not_exists(pk)");
  assert.equal(arm[1].Put.Item.accepted_instances.N, "0");
  assert.equal(arm[1].Put.Item.reserved_usd.N, "0");
  assert.equal(arm[1].Put.Item.phase_spend_baseline_usd.N, "51.98572625");
  assert.equal(arm[1].Put.Item.budget_limit_usd.N, "110");
  assert.equal(arm[1].Put.Item.campaign_reservation_ceiling_usd.N, "21.75");
  assert.equal(arm[1].Put.Item.campaign_safety_ceiling_usd.N, "26.1");

  const plan = launchPlan();
  const reservation = windowsCampaignReservationItems(
    plan,
    "2026-08-02T03:05:00Z",
  );
  assert.equal(reservation.length, 3);
  assert.match(
    reservation[0].ConditionCheck.ConditionExpression,
    /#state = :armed.*campaign_id = :campaign.*source_sha = :source.*expires_epoch >= :now/,
  );
  assert.match(
    reservation[2].Update.ConditionExpression,
    /accepted_instances < max_accepted_instances.*reserved_usd <= reservation_limit_usd/,
  );
  const kill = windowsCampaignKillArgs(
    plan.aws.stateTable,
    "operator-kill",
    "2026-08-02T03:06:00Z",
  );
  const killValues = JSON.parse(
    kill[kill.indexOf("--expression-attribute-values") + 1],
  );
  assert.equal(killValues[":killed"].S, "KILLED");
  assert.match(kill.join(" "), /operator-kill/);
});

test("Windows campaign cannot remain armed for more than 24 hours", () => {
  assert.throws(
    () =>
      createWindowsJitCampaignArmPlan({
        campaignId: "win-20260802-ledger",
        sourceSha: "a".repeat(40),
        stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
        armedAt: "2026-08-02T03:00:00Z",
        expiresAt: "2026-08-03T03:00:01Z",
        phaseSpendBaselineUsd: 51.98572625,
      }),
    /within 24 hours/,
  );
});

test("Windows campaign narrows its paid slot ceiling without widening the phase cap", () => {
  const campaign = createWindowsJitCampaignArmPlan({
    campaignId: "win-20260802-bounded",
    sourceSha: "a".repeat(40),
    stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
    armedAt: "2026-08-02T03:00:00Z",
    expiresAt: "2026-08-03T03:00:00Z",
    phaseSpendBaselineUsd: 60,
    maxAcceptedInstances: 1,
  });
  const arm = windowsCampaignArmItems(campaign);
  assert.equal(campaign.limits.maxAcceptedInstances, 1);
  assert.equal(campaign.limits.campaignReservationCeilingUsd, 4.35);
  assert.equal(campaign.limits.campaignSafetyCeilingUsd, 8.7);
  assert.equal(arm[1].Put.Item.max_accepted_instances.N, "1");
  assert.throws(
    () =>
      createWindowsJitCampaignArmPlan({
        campaignId: "win-20260802-bounded",
        sourceSha: "a".repeat(40),
        stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
        armedAt: "2026-08-02T03:00:00Z",
        expiresAt: "2026-08-03T03:00:00Z",
        phaseSpendBaselineUsd: 60,
        maxAcceptedInstances: 6,
      }),
    /maxAcceptedInstances must be an integer from 1 through 5/,
  );
});

test("Windows campaign admits the USD 110 two-allocation timeout envelope", () => {
  const campaign = createWindowsJitCampaignArmPlan({
    campaignId: "win-timeout-110",
    sourceSha: "a".repeat(40),
    stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
    armedAt: "2026-08-03T02:00:00Z",
    expiresAt: "2026-08-04T02:00:00Z",
    phaseSpendBaselineUsd: 88.52290745,
    maxAcceptedInstances: 2,
  });
  assert.equal(campaign.limits.maxAcceptedInstances, 2);
  assert.equal(campaign.limits.campaignReservationCeilingUsd, 8.7);
  assert.equal(campaign.limits.campaignSafetyCeilingUsd, 13.05);
  assert.equal(
    windowsCampaignArmItems(campaign)[1].Put.Item.remaining_phase_budget_usd.N,
    "21.47709255",
  );
  assert.equal(
    campaign.limits.phaseSpendBaselineUsd +
      campaign.limits.campaignSafetyCeilingUsd,
    101.57290745,
  );
});

test("Windows campaign requires a prior-spend baseline and rejects an exhausted cap", () => {
  const values = {
    campaignId: "win-20260802-ledger",
    sourceSha: "a".repeat(40),
    stateTable: "kungfu-buildchain-windows-jit-CampaignState-example",
    armedAt: "2026-08-02T03:00:00Z",
    expiresAt: "2026-08-03T03:00:00Z",
  };
  assert.throws(
    () => createWindowsJitCampaignArmPlan(values),
    /phaseSpendBaselineUsd is required/,
  );
  assert.throws(
    () =>
      createWindowsJitCampaignArmPlan({
        ...values,
        phaseSpendBaselineUsd: 84,
      }),
    /safety envelope must remain below the remaining Windows phase budget/,
  );
});

test("Windows campaign CLI plans without mutating AWS", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/aws-windows-jit-campaign.mjs",
      "plan-arm",
      "--campaign-id",
      "win-20260802-ledger",
      "--source-sha",
      "a".repeat(40),
      "--state-table",
      "kungfu-buildchain-windows-jit-CampaignState-example",
      "--armed-at",
      "2026-08-02T03:00:00Z",
      "--expires-at",
      "2026-08-03T03:00:00Z",
      "--phase-spend-baseline-usd",
      "51.98572625",
      "--max-accepted-instances",
      "1",
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.kind, "campaign-arm-plan");
  assert.equal(plan.limits.maxAcceptedInstances, 1);
  assert.equal(plan.limits.phaseSpendBaselineUsd, 51.98572625);
  assert.equal(plan.limits.remainingPhaseBudgetUsd, 58.01427375);
  assert.equal(plan.limits.campaignSafetyCeilingUsd, 8.7);
});

test("Windows campaign kill persists state before publishing cleanup", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-windows-jit-kill-test-"),
  );
  const log = path.join(tempRoot, "aws.jsonl");
  materializeCommandShim(
    path.join(tempRoot, "aws"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(args) + "\\n");
process.stdout.write(JSON.stringify(args.includes("publish") ? { MessageId: "message-1" } : {}));
`,
    { mode: 0o700 },
  );
  try {
    const common = [
      "--campaign-id",
      "win-20260802-ledger",
      "--confirm-campaign-id",
      "win-20260802-ledger",
      "--source-sha",
      "a".repeat(40),
      "--confirm-source-sha",
      "a".repeat(40),
      "--state-table",
      "kungfu-buildchain-windows-jit-CampaignState-example",
      "--confirm-state-table",
      "kungfu-buildchain-windows-jit-CampaignState-example",
      "--kill-switch-topic",
      "arn:aws:sns:us-east-1:123456789012:kungfu-buildchain-windows-jit-KillSwitchTopic-example",
      "--confirm-kill-switch-topic",
      "arn:aws:sns:us-east-1:123456789012:kungfu-buildchain-windows-jit-KillSwitchTopic-example",
    ];
    const result = spawnSync(
      process.execPath,
      ["scripts/aws-windows-jit-campaign.mjs", "kill-campaign", ...common],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
          FAKE_COMMAND_LOG: log,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).notificationMessageId, "message-1");
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls[0].includes("update-item"), true);
    assert.equal(calls[1].includes("publish"), true);
  } finally {
    for (const file of fs.readdirSync(tempRoot))
      fs.unlinkSync(path.join(tempRoot, file));
    fs.rmdirSync(tempRoot);
  }
});

test("Windows controller rejects a mismatched qualification label", () => {
  assert.throws(
    () =>
      launchPlan({
        runnerLabel: "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-02",
      }),
    /runnerLabel must be aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01/,
  );
});

test("Windows RunInstances args use one raw fileb user-data boundary and reaper tags", () => {
  const plan = launchPlan();
  const args = windowsRunInstancesArgs(plan, {
    bootstrapPath: "/private/tmp/bootstrap.ps1",
    dryRun: true,
  });
  const userDataIndex = args.indexOf("--user-data");
  assert.equal(args[userDataIndex + 1], "fileb:///private/tmp/bootstrap.ps1");
  const windowsArgs = windowsRunInstancesArgs(plan, {
    bootstrapPath: "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bootstrap.ps1",
  });
  assert.equal(
    windowsArgs[windowsArgs.indexOf("--user-data") + 1],
    "fileb://C:\\Users\\runneradmin\\AppData\\Local\\Temp\\bootstrap.ps1",
  );
  assert.equal(args.includes("--dry-run"), true);
  assert.equal(
    args[args.indexOf("--client-token") + 1],
    "kungfu-30679299189-1-win-full-01",
  );
  assert.equal(args.includes("--cli-binary-format"), false);
  assert.equal(
    args.some((entry) => /IyBTUERY/.test(entry)),
    false,
  );
  const tagSpecifications = JSON.parse(
    args[args.indexOf("--tag-specifications") + 1],
  );
  const instanceTags = tagSpecifications.find(
    (entry) => entry.ResourceType === "instance",
  ).Tags;
  assert.ok(
    instanceTags.some(
      (entry) =>
        entry.Key === "kungfu:plane" &&
        entry.Value === "aws-us-elastic-runner-burst",
    ),
  );
});

test("Windows controller terminates an exact tagged instance after an ambiguous launch failure", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-windows-jit-controller-failure-test-"),
  );
  const commandLog = path.join(tempRoot, "commands.jsonl");
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
if (joined.includes("actions/runs/30679299189")) {
  process.stdout.write(JSON.stringify({ event: "workflow_dispatch", display_title: "AWS Windows JIT win-20260802-ledger win-full-01", head_sha: "a".repeat(40), head_repository: { full_name: "kungfu-systems/kungfu" }, status: "queued" }));
} else if (joined.includes("actions/jobs/91315129066")) {
  process.stdout.write(JSON.stringify({ status: "queued", labels: ["self-hosted", "Windows", "X64", "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01"] }));
} else if (joined.includes("generate-jitconfig")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({ encoded_jit_config: "secret-jit-config" })));
} else if (joined.includes("actions/runners?per_page=100")) {
  process.stdout.write(JSON.stringify({ runners: [{ id: 81, name: "kungfu-win-full-01-30679299189-1" }] }));
} else if (args.includes("DELETE")) {
  process.stdout.write("");
} else {
  process.stderr.write("unexpected gh command");
  process.exitCode = 2;
}
`,
  );
  fake(
    "aws",
    String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const previous = fs.existsSync(process.env.FAKE_COMMAND_LOG) ? fs.readFileSync(process.env.FAKE_COMMAND_LOG, "utf8") : "";
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ command: "aws", args }) + "\n");
const joined = args.join(" ");
if (joined.includes("sts get-caller-identity")) {
  process.stdout.write(JSON.stringify({ Account: "123456789012" }));
} else if (joined.includes("cloudformation describe-stacks")) {
  if (args.includes("--query")) process.stdout.write("arn:aws:sns:us-east-1:123456789012:windows-budget-topic");
  else process.stdout.write(JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: "KillSwitchTopic", OutputValue: "arn:aws:sns:us-east-1:123456789012:windows-budget-topic" }] }] }));
} else if (joined.includes("budgets describe-budget")) {
  process.stdout.write(JSON.stringify({ Budget: { BudgetName: "kungfu-buildchain-windows-jit-actual-spend", BudgetLimit: { Amount: "110", Unit: "USD" }, BudgetType: "COST", Metrics: ["UnblendedCost"], FilterExpression: { And: [{ Dimensions: { Key: "USAGE_TYPE", Values: ["BoxUsage:c7i.4xlarge"], MatchOptions: ["EQUALS"] } }, { Dimensions: { Key: "OPERATION", Values: ["RunInstances:0002"], MatchOptions: ["EQUALS"] } }, { Dimensions: { Key: "REGION", Values: ["us-east-1"], MatchOptions: ["EQUALS"] } }] } } }));
} else if (joined.includes("budgets describe-notifications-for-budget")) {
  process.stdout.write(JSON.stringify({ Notifications: [
    { ComparisonOperator: "GREATER_THAN", NotificationType: "ACTUAL", Threshold: 80 },
    { ComparisonOperator: "GREATER_THAN", NotificationType: "ACTUAL", Threshold: 95 }
  ] }));
} else if (joined.includes("budgets describe-subscribers-for-notification")) {
  process.stdout.write(JSON.stringify({ Subscribers: [{ SubscriptionType: "SNS", Address: "arn:aws:sns:us-east-1:123456789012:windows-budget-topic" }] }));
} else if (joined.includes("ssm get-parameter")) {
  process.stderr.write("ParameterNotFound");
  process.exitCode = 254;
} else if (joined.includes("ec2 describe-instances")) {
  const afterLaunch = previous.includes('"run-instances"') && !previous.includes('"--dry-run"}');
  process.stdout.write(JSON.stringify(afterLaunch ? { Reservations: [{ Instances: [{ InstanceId: "i-0123456789abcdef0" }] }] } : { Reservations: [] }));
} else if (joined.includes("ssm describe-parameters")) {
  process.stdout.write(JSON.stringify({ Parameters: [] }));
} else if (joined.includes("ec2 describe-images")) {
  process.stdout.write(JSON.stringify({ Images: [{ Name: "Windows_Server-2025-English-Full-Base-2026.07.15", Architecture: "x86_64", State: "available", OwnerId: "amazon" }] }));
} else if (joined.includes("ssm put-parameter")) {
  process.stdout.write(JSON.stringify({ Version: 1, Tier: "Advanced" }));
} else if (joined.includes("ec2 run-instances") && args.includes("--dry-run")) {
  process.stderr.write("DryRunOperation");
  process.exitCode = 255;
} else if (joined.includes("ec2 run-instances")) {
  process.stderr.write("simulated ambiguous transport failure");
  process.exitCode = 255;
} else if (joined.includes("dynamodb transact-write-items")) {
  process.stdout.write(JSON.stringify({}));
} else if (joined.includes("ec2 terminate-instances") || joined.includes("ssm delete-parameter")) {
  process.stdout.write(JSON.stringify({ ok: true }));
} else {
  process.stderr.write("unexpected aws command");
  process.exitCode = 2;
}
`,
  );
  try {
    const args = [
      "scripts/aws-windows-jit-controller.mjs",
      "--execute",
      "--confirm-source-sha",
      "a".repeat(40),
      "--confirm-run-id",
      "30679299189",
      "--confirm-campaign-id",
      "win-20260802-ledger",
      "--confirm-state-table",
      "kungfu-buildchain-windows-jit-CampaignState-example",
      "--run-id",
      "30679299189",
      "--job-id",
      "91315129066",
      "--qualification-id",
      "win-full-01",
      "--campaign-id",
      "win-20260802-ledger",
      "--runner-label",
      "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01",
      "--runner-name",
      "kungfu-win-full-01-30679299189-1",
      "--source-sha",
      "a".repeat(40),
      "--source-ref",
      "refs/heads/ci/aws-windows-burst-qualification-20260801-2d64b68a",
      "--ami-id",
      "ami-013acec81a2c8ff79",
      "--ami-name",
      "Windows_Server-2025-English-Full-Base-2026.07.15",
      "--subnet-id",
      "subnet-fa5c77b7",
      "--security-group-id",
      "sg-0c6e6c9c6849e24f9",
      "--instance-profile-name",
      "kungfu-buildchain-windows-jit-RunnerInstanceProfile-aZfB20hvOmdz",
      "--evidence-bucket",
      "kungfu-buildchain-windows-jit-evidencebucket-3vq75oz26vmc",
      "--state-table",
      "kungfu-buildchain-windows-jit-CampaignState-example",
      "--launched-at",
      "2026-08-01T02:45:54Z",
    ];
    const result = spawnSync(process.execPath, args, {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempRoot}${path.delimiter}${process.env.PATH}`,
        FAKE_COMMAND_LOG: commandLog,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /simulated ambiguous transport failure/);
    const log = fs.readFileSync(commandLog, "utf8");
    assert.doesNotMatch(log, /secret-jit-config/);
    const commands = log.trim().split("\n").map(JSON.parse);
    assert.ok(
      commands.some(
        (entry) =>
          entry.command === "aws" && entry.args.includes("terminate-instances"),
      ),
    );
    assert.ok(
      commands.some(
        (entry) =>
          entry.command === "aws" && entry.args.includes("delete-parameter"),
      ),
    );
    assert.ok(
      commands.some(
        (entry) => entry.command === "gh" && entry.args.includes("DELETE"),
      ),
    );
  } finally {
    for (const entry of fs.readdirSync(tempRoot)) {
      fs.unlinkSync(path.join(tempRoot, entry));
    }
    fs.rmdirSync(tempRoot);
  }
});

test("Windows controller execute keeps JIT material out of argv and launches only after DryRun", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-windows-jit-controller-test-"),
  );
  const commandLog = path.join(tempRoot, "commands.jsonl");
  const fake = (name, source) => {
    const file = path.join(tempRoot, name);
    materializeCommandShim(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
    return file;
  };
  fake(
    "gh",
    String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ command: "gh", args }) + "\n");
const joined = args.join(" ");
if (joined.includes("actions/runs/30679299189")) {
  process.stdout.write(JSON.stringify({ event: "workflow_dispatch", display_title: "AWS Windows JIT win-20260802-ledger win-full-01", head_sha: "a".repeat(40), head_repository: { full_name: "kungfu-systems/kungfu" }, status: "queued" }));
} else if (joined.includes("actions/jobs/91315129066")) {
  process.stdout.write(JSON.stringify({ status: "queued", labels: ["self-hosted", "Windows", "X64", "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01"] }));
} else if (joined.includes("generate-jitconfig")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({ encoded_jit_config: "secret-jit-config" })));
} else if (joined.includes("actions/runners?per_page=100")) {
  process.stdout.write(JSON.stringify({ runners: [] }));
} else {
  process.stderr.write("unexpected gh command");
  process.exitCode = 2;
}
`,
  );
  fake(
    "aws",
    String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify({ command: "aws", args }) + "\n");
const joined = args.join(" ");
if (joined.includes("sts get-caller-identity")) {
  process.stdout.write(JSON.stringify({ Account: "123456789012" }));
} else if (joined.includes("cloudformation describe-stacks")) {
  if (args.includes("--query")) process.stdout.write("arn:aws:sns:us-east-1:123456789012:windows-budget-topic");
  else process.stdout.write(JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: "KillSwitchTopic", OutputValue: "arn:aws:sns:us-east-1:123456789012:windows-budget-topic" }] }] }));
} else if (joined.includes("budgets describe-budget")) {
  process.stdout.write(JSON.stringify({ Budget: { BudgetName: "kungfu-buildchain-windows-jit-actual-spend", BudgetLimit: { Amount: "110", Unit: "USD" }, BudgetType: "COST", Metrics: ["UnblendedCost"], FilterExpression: { And: [{ Dimensions: { Key: "USAGE_TYPE", Values: ["BoxUsage:c7i.4xlarge"], MatchOptions: ["EQUALS"] } }, { Dimensions: { Key: "OPERATION", Values: ["RunInstances:0002"], MatchOptions: ["EQUALS"] } }, { Dimensions: { Key: "REGION", Values: ["us-east-1"], MatchOptions: ["EQUALS"] } }] } } }));
} else if (joined.includes("budgets describe-notifications-for-budget")) {
  process.stdout.write(JSON.stringify({ Notifications: [
    { ComparisonOperator: "GREATER_THAN", NotificationType: "ACTUAL", Threshold: 80, ThresholdType: "PERCENTAGE" },
    { ComparisonOperator: "GREATER_THAN", NotificationType: "ACTUAL", Threshold: 95, ThresholdType: "PERCENTAGE" }
  ] }));
} else if (joined.includes("budgets describe-subscribers-for-notification")) {
  process.stdout.write(JSON.stringify({ Subscribers: [{ SubscriptionType: "SNS", Address: "arn:aws:sns:us-east-1:123456789012:windows-budget-topic" }] }));
} else if (joined.includes("ssm get-parameter")) {
  process.stderr.write("ParameterNotFound");
  process.exitCode = 254;
} else if (joined.includes("ec2 describe-instances")) {
  process.stdout.write(JSON.stringify({ Reservations: [] }));
} else if (joined.includes("ssm describe-parameters")) {
  process.stdout.write(JSON.stringify({ Parameters: [] }));
} else if (joined.includes("ec2 describe-images")) {
  process.stdout.write(JSON.stringify({ Images: [{ Name: "Windows_Server-2025-English-Full-Base-2026.07.15", Architecture: "x86_64", State: "available", OwnerId: "amazon" }] }));
} else if (joined.includes("ssm put-parameter")) {
  const input = args[args.indexOf("--cli-input-json") + 1].replace(/^file:\/\//, "");
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  if (payload.Value !== "secret-jit-config") process.exit(3);
  process.stdout.write(JSON.stringify({ Version: 1, Tier: "Advanced" }));
} else if (joined.includes("ec2 run-instances") && args.includes("--dry-run")) {
  process.stderr.write("DryRunOperation");
  process.exitCode = 255;
} else if (joined.includes("ec2 run-instances")) {
  process.stdout.write(JSON.stringify({ Instances: [{ InstanceId: "i-0123456789abcdef0", ImageId: "ami-013acec81a2c8ff79", InstanceType: "c7i.4xlarge", LaunchTime: "2026-08-01T02:45:54Z" }] }));
} else if (joined.includes("dynamodb transact-write-items") || joined.includes("dynamodb update-item")) {
  process.stdout.write(JSON.stringify({}));
} else {
  process.stderr.write("unexpected aws command");
  process.exitCode = 2;
}
`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/aws-windows-jit-controller.mjs",
        "--execute",
        "--confirm-source-sha",
        "a".repeat(40),
        "--confirm-run-id",
        "30679299189",
        "--confirm-campaign-id",
        "win-20260802-ledger",
        "--confirm-state-table",
        "kungfu-buildchain-windows-jit-CampaignState-example",
        "--run-id",
        "30679299189",
        "--job-id",
        "91315129066",
        "--qualification-id",
        "win-full-01",
        "--campaign-id",
        "win-20260802-ledger",
        "--runner-label",
        "aws-us-ec2-windows-jit-win-20260802-ledger-win-full-01",
        "--runner-name",
        "kungfu-win-full-01-30679299189-1",
        "--source-sha",
        "a".repeat(40),
        "--source-ref",
        "refs/heads/ci/aws-windows-burst-qualification-20260801-2d64b68a",
        "--ami-id",
        "ami-013acec81a2c8ff93",
        "--ami-name",
        "Windows_Server-2025-English-Full-Base-2026.07.15",
        "--subnet-id",
        "subnet-fa5c77b7",
        "--security-group-id",
        "sg-0c6e6c9c6849e24f9",
        "--instance-profile-name",
        "kungfu-buildchain-windows-jit-RunnerInstanceProfile-aZfB20hvOmdz",
        "--evidence-bucket",
        "kungfu-buildchain-windows-jit-evidencebucket-3vq75oz26vmc",
        "--state-table",
        "kungfu-buildchain-windows-jit-CampaignState-example",
        "--launched-at",
        "2026-08-01T02:45:54Z",
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
    assert.equal(output.status, "launched");
    assert.equal(output.dryRun, "DryRunOperation");
    const log = fs.readFileSync(commandLog, "utf8");
    assert.doesNotMatch(log, /secret-jit-config/);
    const commands = log.trim().split("\n").map(JSON.parse);
    const budgetGateIndex = commands.findIndex(
      (entry) => entry.command === "aws" && entry.args.includes("describe-budget"),
    );
    const jitConfigIndex = commands.findIndex(
      (entry) =>
        entry.command === "gh" &&
        entry.args.some((argument) => argument.includes("generate-jitconfig")),
    );
    const dryRunIndex = commands.findIndex(
      (entry) =>
        entry.command === "aws" &&
        entry.args.includes("run-instances") &&
        entry.args.includes("--dry-run"),
    );
    const launchIndex = commands.findIndex(
      (entry) =>
        entry.command === "aws" &&
        entry.args.includes("run-instances") &&
        !entry.args.includes("--dry-run"),
    );
    const reservationIndex = commands.findIndex(
      (entry) =>
        entry.command === "aws" && entry.args.includes("transact-write-items"),
    );
    const markIndex = commands.findIndex(
      (entry) => entry.command === "aws" && entry.args.includes("update-item"),
    );
    assert.ok(
      budgetGateIndex >= 0 &&
        jitConfigIndex > budgetGateIndex &&
        dryRunIndex > jitConfigIndex &&
        reservationIndex > dryRunIndex &&
        launchIndex > reservationIndex &&
        markIndex > launchIndex,
    );
  } finally {
    for (const entry of fs.readdirSync(tempRoot)) {
      fs.unlinkSync(path.join(tempRoot, entry));
    }
    fs.rmdirSync(tempRoot);
  }
});

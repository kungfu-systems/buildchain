// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const common = [
  "--account-id",
  "123456789012",
  "--campaign-id",
  "win-operator01",
  "--source-sha",
  "a".repeat(40),
  "--source-ref",
  "refs/heads/dev/v4/v4.0",
  "--observed-at",
  "2026-08-03T06:30:00Z",
  "--expires-at",
  "2026-08-04T06:00:00Z",
  "--cost-start",
  "2026-07-29",
  "--cost-end",
  "2026-08-04",
  "--max-accepted-instances",
  "1",
  "--workflow-id",
  "322620360",
  "--vpc-id",
  "vpc-5243f72f",
  "--subnet-id",
  "subnet-fa5c77b7",
  "--oidc-provider-arn",
  "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
];

function operator(mode, extra = [], env = process.env) {
  return spawnSync(
    "/bin/bash",
    ["scripts/aws-windows-jit-operator.sh", mode, ...common, ...extra],
    { cwd: root, encoding: "utf8", env },
  );
}

function exactConfirmations(env, { budget = false } = {}) {
  const planned = operator("plan", [], env);
  assert.equal(planned.status, 0, planned.stderr);
  const args = [
    "--execute",
    "--confirm-plan-digest",
    JSON.parse(planned.stdout).digest,
    "--confirm-account-id",
    "123456789012",
    "--confirm-campaign-id",
    "win-operator01",
    "--confirm-source-sha",
    "a".repeat(40),
  ];
  if (budget)
    args.push(
      "--confirm-budget-name",
      "kungfu-buildchain-windows-jit-actual-spend",
    );
  return args;
}

function executable(directory, name, body) {
  fs.writeFileSync(path.join(directory, name), body, { mode: 0o755 });
}

test("Windows JIT operator emits one deterministic disabled plan", () => {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "windows-jit-plan-"));
  const forbidden = "#!/bin/sh\necho provider-call-forbidden >&2\nexit 99\n";
  try {
    for (const command of ["aws", "gh"]) {
      const commandPath = path.join(fakeBin, command);
      fs.writeFileSync(commandPath, forbidden, { mode: 0o755 });
    }
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const first = operator("plan", [], env);
    const second = operator("plan", [], env);
    const defaultMode = spawnSync(
      "/bin/bash",
      ["scripts/aws-windows-jit-operator.sh", ...common],
      { cwd: root, encoding: "utf8", env },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(defaultMode.status, 0, defaultMode.stderr);
    const plan = JSON.parse(first.stdout);
    assert.equal(
      plan.contract,
      "kungfu-buildchain-aws-windows-jit-operator/v1",
    );
    assert.equal(plan.digest, JSON.parse(second.stdout).digest);
    assert.equal(plan.digest, JSON.parse(defaultMode.stdout).digest);
    assert.equal(
      plan.aws.campaignStackName,
      "kungfu-buildchain-windows-jit-win-operator01",
    );
    assert.equal(plan.aws.budgetGuard.stackName.endsWith("budget-guard"), true);
    assert.equal(plan.safety.defaultAction, "plan-only");
    assert.equal(plan.safety.workflowEnabledDuringPrepare, false);
    assert.equal(plan.safety.dispatchDuringPrepare, false);
    assert.equal(plan.safety.paidCapacityDuringPrepare, false);
    assert.deepEqual(plan.cost.dimensionFilter, {
      usageType: "BoxUsage:c7i.4xlarge",
      operation: "RunInstances:0002",
      region: "us-east-1",
    });
    assert.deepEqual(plan.cost.resourceOwnershipTag, {
      key: "kungfu:provider",
      value: "windows-ec2-jit",
    });
    assert.equal(plan.safety.budgetDimensionVisibilityRequired, true);
    assert.match(plan.aws.campaignTemplate.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(plan.aws.budgetTemplate.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(plan.digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Windows JIT operator rejects malformed identities before provider calls", () => {
  const result = operator("plan", [
    "--campaign-id",
    "win-too-long-for-operator-contract",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--campaign-id is invalid/);
});

test("Windows JIT operator refuses every mutation without execute and exact confirmations", () => {
  for (const mode of ["install-budget", "prepare", "close"]) {
    const result = operator(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--execute is required for mutation/);
  }
});

test("Windows JIT prepare rejects a campaign stack collision before paid-capacity calls", () => {
  const fakeBin = fs.mkdtempSync(
    path.join(os.tmpdir(), "windows-jit-collision-"),
  );
  const log = path.join(fakeBin, "commands.jsonl");
  try {
    executable(
      fakeBin,
      "aws",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(["aws", ...args]) + "\\n");
if (args.includes("get-caller-identity")) process.stdout.write('{"Account":"123456789012"}');
else if (args.includes("describe-stacks")) process.stdout.write('{"Stacks":[{"StackName":"collision"}]}');
else process.exit(91);
`,
    );
    executable(
      fakeBin,
      "gh",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(["gh", ...args]) + "\\n");
process.stdout.write('{"id":322620360,"state":"disabled_manually"}');
`,
    );
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_COMMAND_LOG: log,
    };
    const result = operator(
      "prepare",
      exactConfirmations(env, { budget: true }),
      env,
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /campaign stack already exists; reuse is forbidden/,
    );
    const calls = fs.readFileSync(log, "utf8");
    assert.doesNotMatch(
      calls,
      /run-instances|create-registration-token|get-cost-and-usage| deploy/,
    );
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Windows JIT prepare reads fresh cost with exact account-native Windows dimensions", () => {
  const fakeBin = fs.mkdtempSync(
    path.join(os.tmpdir(), "windows-jit-cost-filter-"),
  );
  const log = path.join(fakeBin, "commands.jsonl");
  try {
    executable(
      fakeBin,
      "aws",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(["aws", ...args]) + "\\n");
const joined = args.join(" ");
if (joined.includes("sts get-caller-identity")) process.stdout.write('{"Account":"123456789012"}');
else if (joined.includes("cloudformation describe-stacks") && joined.includes("win-operator01")) { process.stderr.write("Stack does not exist"); process.exit(255); }
else if (joined.includes("cloudformation describe-stacks") && args.includes("--query")) process.stdout.write("arn:aws:sns:us-east-1:123456789012:budget-topic");
else if (joined.includes("cloudformation describe-stacks")) process.stdout.write('{"Stacks":[{"StackName":"budget-guard"}]}');
else if (joined.includes("budgets describe-budget")) process.stdout.write('{"Budget":{"BudgetName":"kungfu-buildchain-windows-jit-actual-spend","BudgetLimit":{"Amount":"110","Unit":"USD"},"BudgetType":"COST","Metrics":["UnblendedCost"],"FilterExpression":{"And":[{"Dimensions":{"Key":"USAGE_TYPE","Values":["BoxUsage:c7i.4xlarge"],"MatchOptions":["EQUALS"]}},{"Dimensions":{"Key":"OPERATION","Values":["RunInstances:0002"],"MatchOptions":["EQUALS"]}},{"Dimensions":{"Key":"REGION","Values":["us-east-1"],"MatchOptions":["EQUALS"]}}]}}}');
else if (joined.includes("ce get-dimension-values")) process.stdout.write(JSON.stringify({DimensionValues:[{Value:args[args.indexOf("--search-string")+1]}]}));
else if (joined.includes("describe-notifications-for-budget")) process.stdout.write('{"Notifications":[{"NotificationType":"ACTUAL","Threshold":80},{"NotificationType":"ACTUAL","Threshold":95}]}');
else if (joined.includes("describe-subscribers-for-notification")) process.stdout.write('{"Subscribers":[{"SubscriptionType":"SNS","Address":"arn:aws:sns:us-east-1:123456789012:budget-topic"}]}');
else if (joined.includes("ssm get-parameter")) { process.stderr.write("ParameterNotFound"); process.exit(255); }
else if (joined.includes("ec2 describe-instances")) process.stdout.write('{"Reservations":[]}');
else if (joined.includes("ec2 describe-volumes")) process.stdout.write('{"Volumes":[]}');
else if (joined.includes("ssm describe-instance-information")) process.stdout.write('{"InstanceInformationList":[]}');
else if (joined.includes("ssm describe-parameters")) process.stdout.write('{"Parameters":[]}');
else if (joined.includes("ce get-cost-and-usage")) { process.stderr.write("intentional stop after cost query"); process.exit(86); }
else process.exit(91);
`,
    );
    executable(
      fakeBin,
      "gh",
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
process.stdout.write(args.includes("actions/runners") ? '{"runners":[]}' : '{"id":322620360,"state":"disabled_manually"}');
`,
    );
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_COMMAND_LOG: log,
    };
    const result = operator(
      "prepare",
      exactConfirmations(env, { budget: true }),
      env,
    );
    assert.equal(result.status, 86);
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const costCall = calls.find((entry) =>
      entry.includes("get-cost-and-usage"),
    );
    assert.ok(costCall, "Cost Explorer query was not made");
    const filter = JSON.parse(costCall[costCall.indexOf("--filter") + 1]);
    assert.deepEqual(filter, {
      And: [
        {
          Dimensions: {
            Key: "USAGE_TYPE",
            Values: ["BoxUsage:c7i.4xlarge"],
            MatchOptions: ["EQUALS"],
          },
        },
        {
          Dimensions: {
            Key: "OPERATION",
            Values: ["RunInstances:0002"],
            MatchOptions: ["EQUALS"],
          },
        },
        {
          Dimensions: {
            Key: "REGION",
            Values: ["us-east-1"],
            MatchOptions: ["EQUALS"],
          },
        },
      ],
    });
    assert.equal(
      calls.some(
        (entry) => entry.includes("deploy") || entry.includes("run-instances"),
      ),
      false,
    );
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Windows JIT install fails closed when an account-native billing dimension is absent", () => {
  const fakeBin = fs.mkdtempSync(
    path.join(os.tmpdir(), "windows-jit-dimension-gate-"),
  );
  const log = path.join(fakeBin, "commands.jsonl");
  try {
    executable(
      fakeBin,
      "aws",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(args) + "\\n");
const joined = args.join(" ");
if (joined.includes("sts get-caller-identity")) process.stdout.write('{"Account":"123456789012"}');
else if (joined.includes("ce get-dimension-values")) {
  const value = args[args.indexOf("--search-string") + 1];
  process.stdout.write(JSON.stringify({DimensionValues:value === "RunInstances:0002" ? [] : [{Value:value}]}));
} else process.exit(91);
`,
    );
    executable(
      fakeBin,
      "gh",
      "#!/bin/sh\necho '{\"id\":322620360,\"state\":\"disabled_manually\"}'\n",
    );
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_COMMAND_LOG: log,
    };
    const result = operator(
      "install-budget",
      exactConfirmations(env, { budget: true }),
      env,
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /account-native Windows billing dimensions are not visible/,
    );
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /cloudformation.*deploy/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Windows JIT launch gate fails closed before JIT when the Budget guard is absent", () => {
  const fakeBin = fs.mkdtempSync(
    path.join(os.tmpdir(), "windows-jit-budget-gate-"),
  );
  const log = path.join(fakeBin, "commands.jsonl");
  try {
    executable(
      fakeBin,
      "aws",
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_COMMAND_LOG, JSON.stringify(args) + "\\n");
if (args.includes("get-caller-identity")) process.stdout.write('{"Account":"123456789012"}');
else if (args.includes("describe-stacks")) { process.stderr.write("Stack does not exist"); process.exit(255); }
else process.exit(91);
`,
    );
    executable(fakeBin, "gh", "#!/bin/sh\necho forbidden >&2\nexit 99\n");
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_COMMAND_LOG: log,
    };
    const result = operator("launch-gate", [], env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /provider Budget guard stack is missing/);
    assert.doesNotMatch(
      fs.readFileSync(log, "utf8"),
      /run-instances|jitconfig|registration-token/,
    );
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Windows JIT close is terminal and repeatable after the campaign stack is absent", () => {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "windows-jit-close-"));
  try {
    executable(
      fakeBin,
      "aws",
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.includes("sts get-caller-identity")) process.stdout.write('{"Account":"123456789012"}');
else if (args.includes("cloudformation describe-stacks")) { process.stderr.write("Stack does not exist"); process.exit(255); }
else if (args.includes("ec2 describe-instances")) process.stdout.write('{"Reservations":[]}');
else if (args.includes("ec2 describe-volumes")) process.stdout.write('{"Volumes":[]}');
else if (args.includes("ssm describe-instance-information")) process.stdout.write('{"InstanceInformationList":[]}');
else if (args.includes("ssm describe-parameters")) process.stdout.write('{"Parameters":[]}');
else process.exit(91);
`,
    );
    executable(
      fakeBin,
      "gh",
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args.includes("workflow disable")) process.exit(0);
process.stdout.write(args.includes("actions/runners") ? '{"runners":[]}' : '{"id":322620360,"state":"disabled_manually"}');
`,
    );
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const confirmations = exactConfirmations(env);
    const first = operator("close", confirmations, env);
    const second = operator("close", confirmations, env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(first.stdout).campaignStackPresent, false);
    assert.equal(JSON.parse(second.stdout).status, "closed-zero-residue");
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

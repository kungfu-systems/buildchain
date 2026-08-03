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
    assert.match(plan.aws.campaignTemplate.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(plan.aws.budgetTemplate.digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(plan.digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Windows JIT operator rejects malformed identities before provider calls", () => {
  const result = operator("plan", ["--campaign-id", "win-too-long-for-operator-contract"]);
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

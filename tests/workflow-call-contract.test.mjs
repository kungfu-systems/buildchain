import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { evaluateWorkflowCallContract } from "../packages/core/workflow-call-contract.js";
import { parseReusableWorkflowInterface } from "../packages/core/workflow-yaml-contract.js";
import { checkWorkflowCall } from "../scripts/workflow-call-contract.mjs";

const SHA = "a".repeat(40);

function callee({ defaultDryRun = "false", requiredChannel = true } = {}) {
  return `name: Promote
on:
  workflow_call:
    inputs:
      channel:
        type: string
        required: ${requiredChannel}
      dry-run:
        type: boolean
        default: ${defaultDryRun}
        required: false
    secrets:
      PROMOTION_TOKEN:
        required: true
    outputs:
      promoted-sha:
        value: \${{ jobs.promote.outputs.sha }}
permissions:
  contents: write
  issues: read
jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;
}

function caller({
  ref = SHA,
  extraInput = "",
  channel = '"alpha"',
  dryRun = "false",
  secret = "PROMOTION_TOKEN: ${{ secrets.TOKEN }}",
  contents = "write",
  events = "  workflow_dispatch:\n  pull_request:\n    types: [closed]",
} = {}) {
  return `name: Release
on:
${events}
permissions:
  contents: read
jobs:
  promote:
    permissions:
      contents: ${contents}
      issues: write
    uses: kungfu-systems/buildchain/.github/workflows/release-candidate-promote.yml@${ref}
    with:
      channel: ${channel}
      dry-run: ${dryRun}${extraInput}
    secrets:
      ${secret}
`;
}

function evaluate(overrides = {}) {
  return evaluateWorkflowCallContract({
    callerText: caller(),
    calleeText: callee(),
    callerRepository: "kungfu-systems/kungfu",
    callerWorkflowPath: ".github/workflows/release-new-version.yml",
    callerSha: "b".repeat(40),
    callerTree: "c".repeat(40),
    calleeRepository: "kungfu-systems/buildchain",
    calleeWorkflowPath: ".github/workflows/release-candidate-promote.yml",
    calleeSha: SHA,
    jobId: "promote",
    trustedEventClasses: ["workflow_dispatch", "pull_request:closed"],
    ...overrides,
  });
}

function codes(report) {
  return report.failures.map((entry) => entry.code);
}

test("shared workflow parser preserves legacy indentation and code-unit ordering", () => {
  const parsed = parseReusableWorkflowInterface(`on:
    workflow_call:
      inputs:
        lower:
          type: string
        Upper:
          type: string
      secrets:
        lower-secret:
          required: false
        UPPER_SECRET:
          required: false
`);
  assert.equal(parsed.reusable, true);
  assert.deepEqual(
    parsed.inputs.map((entry) => entry.name),
    ["Upper", "lower"],
  );
  assert.deepEqual(
    parsed.secrets.map((entry) => entry.name),
    ["UPPER_SECRET", "lower-secret"],
  );
});

test("exact reusable workflow call emits an immutable source-bound receipt", () => {
  const report = evaluate();
  assert.equal(report.ok, true);
  assert.equal(report.receiptReusable, true);
  assert.match(report.contractRoot, /^sha256:[0-9a-f]{64}$/);
  assert.match(report.receiptRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(report.receipt.caller.tree, "c".repeat(40));
  assert.equal(report.receipt.callee.sha, SHA);
  assert.deepEqual(report.receipt.eventClasses, [
    "pull_request:closed",
    "workflow_dispatch",
  ]);
});

test("captured platforms-json mismatch fails before dispatch", () => {
  const report = evaluate({
    callerText: caller({ extraInput: "\n      platforms-json: '[]'" }),
  });
  assert.equal(report.ok, false);
  assert.ok(codes(report).includes("undeclared-input"));
  assert.match(
    report.failures.map((entry) => entry.message).join("\n"),
    /platforms-json/,
  );
});

test("required inputs and literal input types fail closed", () => {
  const missing = evaluate({
    callerText: caller().replace(/\n      channel: "alpha"/, ""),
  });
  assert.ok(codes(missing).includes("missing-required-input"));

  const wrongType = evaluate({ callerText: caller({ dryRun: '"false"' }) });
  assert.ok(codes(wrongType).includes("input-type-drift"));
});

test("callee default drift invalidates the accepted contract root", () => {
  const accepted = evaluate();
  const drift = evaluate({
    calleeText: callee({ defaultDryRun: "true" }),
    expectedContractRoot: accepted.contractRoot,
  });
  assert.ok(codes(drift).includes("contract-root-mismatch"));
  assert.notEqual(drift.contractRoot, accepted.contractRoot);
});

test("secret, permission, and trusted-event drift are classified", () => {
  const secret = evaluate({
    callerText: caller({ secret: "WRONG_TOKEN: ${{ secrets.TOKEN }}" }),
  });
  assert.ok(codes(secret).includes("undeclared-secret"));
  assert.ok(codes(secret).includes("missing-required-secret"));

  const permission = evaluate({ callerText: caller({ contents: "read" }) });
  assert.ok(codes(permission).includes("permission-drift"));

  const event = evaluate({
    callerText: caller({ events: "  push:\n  workflow_dispatch:" }),
  });
  assert.ok(codes(event).includes("untrusted-event-drift"));
});

test("floating and stale callee refs fail closed", () => {
  const floating = evaluate({ callerText: caller({ ref: "v3" }) });
  assert.ok(codes(floating).includes("floating-callee-ref"));
  assert.ok(codes(floating).includes("stale-pinned-ref"));

  const stale = evaluate({ callerText: caller({ ref: "d".repeat(40) }) });
  assert.ok(codes(stale).includes("stale-pinned-ref"));
});

test("receipt invalidation is minimal across caller source coordinates", () => {
  const first = evaluate();
  const second = evaluate({ callerTree: "d".repeat(40) });
  assert.equal(first.contractRoot, second.contractRoot);
  assert.notEqual(first.receiptRoot, second.receiptRoot);
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

function initRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Workflow Contract Test");
  git(root, "config", "user.email", "workflow-contract@example.invalid");
}

test("consumer command verifies clean exact checkouts and marks dirty runs diagnostic", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-workflow-call-"),
  );
  const calleeRoot = path.join(workspace, "buildchain");
  const callerRoot = path.join(workspace, "kungfu");
  const calleePath = ".github/workflows/release-candidate-promote.yml";
  const callerPath = ".github/workflows/release-new-version.yml";
  initRepository(calleeRoot);
  fs.mkdirSync(path.join(calleeRoot, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(calleeRoot, calleePath), callee());
  git(calleeRoot, "add", ".");
  git(calleeRoot, "commit", "-m", "test: add callee");
  const calleeSha = git(calleeRoot, "rev-parse", "HEAD");

  initRepository(callerRoot);
  fs.mkdirSync(path.join(callerRoot, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(callerRoot, callerPath),
    caller({ ref: calleeSha }),
  );
  git(callerRoot, "add", ".");
  git(callerRoot, "commit", "-m", "test: add caller");

  const options = {
    callerRoot,
    callerWorkflow: callerPath,
    callerRepository: "kungfu-systems/kungfu",
    job: "promote",
    calleeRoot,
    calleeWorkflow: calleePath,
    calleeRepository: "kungfu-systems/buildchain",
    trustedEvents: ["workflow_dispatch", "pull_request:closed"],
  };
  const clean = checkWorkflowCall(options);
  assert.equal(clean.ok, true);
  assert.equal(clean.receiptReusable, true);

  fs.appendFileSync(path.join(callerRoot, callerPath), "# diagnostic change\n");
  assert.throws(() => checkWorkflowCall(options), /caller checkout is dirty/);
  const dirty = checkWorkflowCall({ ...options, allowDirty: true });
  assert.equal(dirty.ok, true);
  assert.equal(dirty.receiptReusable, false);
  assert.equal(dirty.receipt.caller.sourceState, "diagnostic-dirty");

  fs.appendFileSync(path.join(calleeRoot, calleePath), "# callee drift\n");
  assert.throws(
    () => checkWorkflowCall({ ...options, allowDirty: true }),
    /callee checkout is dirty/,
  );
});

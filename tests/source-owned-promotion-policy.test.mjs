import { createBuildchainContractWorld, evaluateBuildchainContractLock } from "../packages/core/contracts/buildchain-contract.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import {
  scanFloatingConsumerPolicy,
  consumerPolicyScannerRoot,
  floatingConsumerDocumentRoot,
  verifyFloatingConsumerPolicyReceipt,
} from "../packages/core/consumer/floating-consumer-policy.js";
import { certifyCommand } from "../packages/core/consumer/commands/consumer-policy.mjs";
const repository = "kungfu-systems/buildchain",
  workflow = ".github/workflows/public-release-promote.yml";
const policy = JSON.parse(
  fs.readFileSync("architecture/floating-consumer-policy.json", "utf8"),
);
const rootValue = `sha256:${"e".repeat(64)}`;
function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "source-owned-promotion-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const caller = path.join(root, "consumer"),
    invocation = path.join(root, "invocation");
  fs.mkdirSync(path.join(caller, ".buildchain"), { recursive: true });
  fs.mkdirSync(path.join(invocation, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(invocation, workflow),
    "name: public\non:\n  workflow_call:\njobs: {}\n",
  );
  fs.writeFileSync(
    path.join(invocation, ".github/workflows/self.yml"),
    `jobs:\n  promote:\n    uses: ./${workflow}\n`,
  );
  const git = (...args) =>
    execFileSync("git", ["-C", invocation, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  const sha = git("rev-parse", "HEAD");
  for (const [ref, file] of [
    ["v4", "contract-lock.json"],
    ["v4-alpha", "alpha-contract-lock.json"],
  ])
    fs.writeFileSync(
      path.join(caller, ".buildchain", file),
      JSON.stringify({
        schemaVersion: 1,
        contract: "kungfu-buildchain-contract-lock",
        buildchain: {
          ref,
          resolvedSha: sha,
          contract: "kungfu-buildchain-runtime-contract-world",
          contractDigest: rootValue,
          compatibilityDigest: rootValue,
          majorLine: "v4",
          compatibilityPolicy: "major-compatible",
          acceptedAt: "2026-09-09T00:00:00.000Z",
          surfaces: [],
        },
      }),
    );
  const args = {
    root: caller,
    invocationRoot: invocation,
    repository,
    sourceSha: "b".repeat(40),
    invokedWorkflow: workflow,
    invocationSourcePath: ".github/workflows/self.yml",
    expectedInvocationChannel: "alpha",
    resolvedWorkflowSha: sha,
    resolvedRuntimeSha: sha,
    definitionRepository: repository,
    definitionSha: sha,
    policy,
    scannerRoot: rootValue,
  };
  return {
    root,
    caller,
    invocation,
    args,
    scan: (change) => scanFloatingConsumerPolicy({ ...args, ...change }),
  };
}
test("same-commit public promotion authenticates a definition independent of the product source", (t) => {
  const f = fixture(t),
    result = f.scan();
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.receipt.invocation.selectorClass, "repository-local");
  assert.notEqual(
    result.receipt.caller.sourceSha,
    result.receipt.invocation.definition.commitSha,
  );
  const validate = new Ajv2020({ strict: false }).compile(
    JSON.parse(
      fs.readFileSync(
        "contracts/v4-floating-consumer-policy-receipt-v1.schema.json",
        "utf8",
      ),
    ),
  );
  assert.equal(validate(result.receipt), true, JSON.stringify(validate.errors));
  assert.equal(
    verifyFloatingConsumerPolicyReceipt({
      receipt: result.receipt,
      receiptRoot: result.receiptRoot,
      expectedReceiptRoot: result.receiptRoot,
    }).ok,
    true,
  );
  for (const definition of [
    undefined,
    { ...result.receipt.invocation.definition, repository: "evil/repo" },
    { ...result.receipt.invocation.definition, commitSha: "a".repeat(40) },
  ]) {
    const receipt = structuredClone(result.receipt);
    if (definition) receipt.invocation.definition = definition;
    else delete receipt.invocation.definition;
    assert.equal(
      verifyFloatingConsumerPolicyReceipt({
        receipt,
        receiptRoot: floatingConsumerDocumentRoot(receipt),
        expectedReceiptRoot: result.receiptRoot,
      }).ok,
      false,
    );
  }
});
test("source-owned admission rejects foreign identity, wrong commits and private or Stage Capsule entrypoints", (t) => {
  const f = fixture(t);
  for (const change of [
    { repository: "evil/repo" },
    { definitionRepository: "evil/repo" },
    { definitionSha: "a".repeat(40) },
    { resolvedWorkflowSha: "a".repeat(40) },
    { definitionSha: "" },
    { invokedWorkflow: ".github/workflows/.release-promote.yml" },
    {
      invokedWorkflow:
        ".github/workflows/public-build-stage-capsule-canary.yml",
    },
  ])
    assert.equal(f.scan(change).ok, false, JSON.stringify(change));
});
test("definition proof rejects modified and untracked workflow source before passing admission", (t) => {
  const f = fixture(t),
    file = path.join(f.invocation, ".github/workflows/self.yml"),
    original = fs.readFileSync(file);
  fs.appendFileSync(file, "# dirty\n");
  assert.ok(
    f.scan().failures.some((v) => v.code === "invocation-definition-invalid"),
  );
  fs.writeFileSync(file, original);
  fs.writeFileSync(
    path.join(f.invocation, ".github/workflows/injected.yml"),
    "jobs: {}\n",
  );
  assert.ok(
    f.scan().failures.some((v) => v.code === "invocation-definition-invalid"),
  );
});
test("external certification reconstructs source-owned proof and cannot trust the receipt alone", (t) => {
  const f = fixture(t),
    result = f.scan({ scannerRoot: consumerPolicyScannerRoot() });
  const input = path.join(f.root, "receipt.json"),
    output = path.join(f.root, "certification.json");
  fs.writeFileSync(input, JSON.stringify(result));
  const options = {
    input,
    output,
    callerRoot: f.caller,
    invocationRoot: f.invocation,
    repository,
    sourceSha: f.args.sourceSha,
    invokedWorkflow: workflow,
    resolvedRuntimeSha: f.args.resolvedRuntimeSha,
    definitionRepository: repository,
    definitionSha: f.args.definitionSha,
  };
  assert.equal(certifyCommand(options).ok, true);
  assert.equal(
    certifyCommand({ ...options, definitionSha: "a".repeat(40) }).ok,
    false,
  );
});
test("all Buildchain promotion callers use the current public request API at their own commit", () => {
  for (const name of [
    "self-release-promote",
    "self-release-tail-dogfood",
    "self-ops-promotion-recovery",
  ]) {
    const document = YAML.parse(
      fs.readFileSync(`.github/workflows/${name}.yml`, "utf8"),
    );
    const jobs = Object.values(document.jobs).filter(
      (job) => job.uses === `./${workflow}`,
    );
    assert.equal(jobs.length, 1, name);
    assert.deepEqual(Object.keys(jobs[0].with), ["request-json"]);
    assert.match(
      jobs[0].with["request-json"],
      /"schema": "buildchain.promotion-request\/v1"/,
    );
  }
});

test("old published lock incompatibility is bypassed only after exact local definition proof", (t) => {
  const f = fixture(t);
  const lock = JSON.parse(fs.readFileSync(path.join(f.caller, ".buildchain/alpha-contract-lock.json")));
  const current = createBuildchainContractWorld({ root: process.cwd() });
  lock.buildchain.surfaces = [{ ...current.surfaces[0], breakingDigest: rootValue }];
  fs.writeFileSync(path.join(f.caller, ".buildchain/alpha-contract-lock.json"), JSON.stringify(lock));
  const compatibility = evaluateBuildchainContractLock({
    lock, current,
    runtimeRef: "v4-alpha", runtimeSha: f.args.resolvedWorkflowSha,
    runtimeClass: "alpha", workflowShellRef: "v4-alpha", expectedChannel: "alpha", expectedMajor: "v4",
  });
  assert.equal(compatibility.ok, false);
  assert.equal(f.scan().ok, true);
  const unproved = f.scan({ definitionSha: "a".repeat(40) });
  assert.equal(unproved.ok, false);
  assert.ok(unproved.failures.some(failure => failure.code === "invocation-definition-invalid"));
});

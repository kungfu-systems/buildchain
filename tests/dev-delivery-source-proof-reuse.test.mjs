import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  createControllerPlan,
  createControllerReceipt,
} from "../packages/core/controller-evidence.js";
import {
  materializeReuseLifecycleEvidence,
  sealSourceQualificationProof,
  verifySourceQualificationReuse,
} from "../scripts/dev-delivery-source-proof-reuse.mjs";

const RUNTIME_SHA = "b".repeat(40);
const CONTRACT_DIGEST = `sha256:${"e".repeat(64)}`;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture() {
  const cwd = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-source-proof-"),
  );
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "Buildchain Test");
  git(cwd, "config", "user.email", "test@example.com");
  write(
    cwd,
    ".buildchain/buildchain.toml",
    '[lifecycle.check]\ncommand = "node check.mjs"\n',
  );
  write(cwd, ".github/workflows/required.yml", "name: required\n");
  write(cwd, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(cwd, "check.mjs", "process.exit(0);\n");
  write(cwd, "src/value.mjs", "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  write(cwd, "src/value.mjs", "export const value = 2;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "source");
  const head = git(cwd, "rev-parse", "HEAD");
  const mergeGroupTree = git(cwd, "rev-parse", `${head}^{tree}`);
  const mergeGroupHead = git(
    cwd,
    "commit-tree",
    mergeGroupTree,
    "-p",
    base,
    "-p",
    head,
    "-m",
    "merge group",
  );

  const registry = JSON.parse(
    fs.readFileSync(
      path.join(PROJECT_ROOT, "dist/site/controller-registry.json"),
      "utf8",
    ),
  );
  const descriptor = registry.controllers.find(
    (entry) => entry.id === "source-check",
  );
  const plan = createControllerPlan({
    descriptor,
    source: { repository: "kungfu-systems/example", sha: head },
    runtime: {
      ref: RUNTIME_SHA,
      sha: RUNTIME_SHA,
      contractDigest: CONTRACT_DIGEST,
    },
    inputs: { mode: "source", "working-directory": "." },
  });
  const receipt = createControllerReceipt({
    plan,
    stages: plan.expected.stages.map((stage) => ({
      id: stage.id,
      status: "passed",
    })),
    evidence: [
      { kind: "lifecycle-manifest", digest: `sha256:${"1".repeat(64)}` },
      { kind: "lifecycle-summary", digest: `sha256:${"2".repeat(64)}` },
    ],
  });
  const receiptPath = path.join(cwd, "receipt.json");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  const common = {
    cwd,
    repository: "kungfu-systems/example",
    protectedBase: "dev/v3/v3.0",
    qualifiedBase: base,
    currentBase: base,
    sourceHead: head,
    sourceWorkflowRunId: 1234,
    runtimeRef: RUNTIME_SHA,
    runtimeSha: RUNTIME_SHA,
    contractDigest: CONTRACT_DIGEST,
    nodeVersion: "24",
    workingDirectory: ".",
    policyPaths: '[".github/workflows/required.yml"]',
    closurePaths: '[".buildchain/buildchain.toml","check.mjs"]',
    dependencyPaths: '["pnpm-lock.yaml"]',
    requiredContexts: '["Candidate source acceptance / check"]',
    controllerReceiptPath: receiptPath,
    qualifiedAt: "2026-08-14T00:00:00Z",
    verifiedAt: "2026-08-14T00:01:00Z",
    mergeGroupHead,
    mergeGroupTree,
  };
  const proof = sealSourceQualificationProof(common);
  const proofPath = path.join(cwd, "proof.json");
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  return {
    cwd,
    base,
    head,
    common: { ...common, sourceProofPath: proofPath },
    proof,
    receiptPath,
  };
}

test("exact source proof reuse binds every semantic predicate and merge-group coordinate", () => {
  const value = fixture();
  try {
    const decision = verifySourceQualificationReuse(value.common);
    assert.equal(decision.reusable, true);
    assert.equal(decision.sourceProofRoot, value.proof.proofRoot);
    assert.equal(decision.sourceHead, value.head);
    assert.equal(decision.currentBase, value.base);
    assert.equal(decision.mergeGroupHead, value.common.mergeGroupHead);
    assert.equal(decision.mergeGroupTree, value.common.mergeGroupTree);
    assert.deepEqual(decision.mergeGroupParents, [value.base, value.head]);
    assert.equal(decision.warrantBinding, "sourceProofRoot");
    assert.match(decision.decisionRoot, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    fs.rmSync(value.cwd, { recursive: true, force: true });
  }
});

test("source proof reuse rejects an inexact merge-group composition", () => {
  const value = fixture();
  try {
    const thirdParent = git(
      value.cwd,
      "commit-tree",
      value.common.mergeGroupTree,
      "-p",
      value.head,
      "-m",
      "third parent",
    );
    const extraParent = git(
      value.cwd,
      "commit-tree",
      value.common.mergeGroupTree,
      "-p",
      thirdParent,
      "-p",
      value.head,
      "-p",
      value.base,
      "-m",
      "grouped merge",
    );
    const extraDecision = verifySourceQualificationReuse({
      ...value.common,
      mergeGroupHead: extraParent,
    });
    assert.equal(extraDecision.reusable, false);
    assert.equal(extraDecision.reason, "merge-group-parent-mismatch");

    const treeDecision = verifySourceQualificationReuse({
      ...value.common,
      mergeGroupTree: value.base,
    });
    assert.equal(treeDecision.reusable, false);
    assert.equal(treeDecision.reason, "merge-group-tree-mismatch");
  } finally {
    fs.rmSync(value.cwd, { recursive: true, force: true });
  }
});

test("source proof reuse fails closed for base, source, toolchain, policy, dependency, and context drift", () => {
  const value = fixture();
  try {
    const cases = [
      [{ currentBase: "f".repeat(40) }, "qualifiedBase-mismatch"],
      [
        { sourceHead: value.base },
        "producer-controller-receipt-not-qualifying",
      ],
      [{ runtimeRef: "v3-other" }, "toolchainRoot-changed-or-unknown"],
      [
        { policyPaths: '[".github/workflows/required.yml","check.mjs"]' },
        "planRoot-changed-or-unknown",
      ],
      [
        { dependencyPaths: '["pnpm-lock.yaml","check.mjs"]' },
        "planRoot-changed-or-unknown",
      ],
      [
        {
          requiredContexts:
            '["Candidate source acceptance / check","affected-native / linux"]',
        },
        "planRoot-changed-or-unknown",
      ],
    ];
    for (const [overrides, reason] of cases) {
      const decision = verifySourceQualificationReuse({
        ...value.common,
        ...overrides,
      });
      assert.equal(decision.reusable, false, JSON.stringify(overrides));
      assert.equal(decision.action, "rerun-full-source-qualification");
      assert.equal(decision.reason, reason);
    }
  } finally {
    fs.rmSync(value.cwd, { recursive: true, force: true });
  }
});

test("a stale or tampered producer receipt cannot satisfy source proof reuse", () => {
  const value = fixture();
  try {
    const receipt = JSON.parse(fs.readFileSync(value.receiptPath, "utf8"));
    receipt.qualifying = false;
    fs.writeFileSync(value.receiptPath, JSON.stringify(receipt));
    const decision = verifySourceQualificationReuse(value.common);
    assert.equal(decision.reusable, false);
    assert.equal(decision.reason, "producer-controller-receipt-not-qualifying");
  } finally {
    fs.rmSync(value.cwd, { recursive: true, force: true });
  }
});

test("a reusable decision materializes honest non-executed lifecycle evidence", () => {
  const value = fixture();
  try {
    const decision = verifySourceQualificationReuse(value.common);
    const decisionPath = path.join(value.cwd, "reuse-decision.json");
    const manifestPath = path.join(
      value.cwd,
      ".buildchain/artifacts/check-manifest.json",
    );
    const summaryPath = path.join(
      value.cwd,
      ".buildchain/artifacts/check-summary.json",
    );
    fs.writeFileSync(decisionPath, JSON.stringify(decision));
    const evidence = materializeReuseLifecycleEvidence({
      decision,
      sourceProofPath: value.common.sourceProofPath,
      decisionPath,
      manifestPath,
      summaryPath,
      workspace: value.cwd,
      repository: value.common.repository,
      sourceRef: "refs/heads/gh-readonly-queue/dev/v3/v3.0/pr-1-test",
      runId: "5678",
      runAttempt: "1",
      platformId: "Linux",
    });
    assert.equal(evidence.manifest.lifecycle.stage, "check");
    assert.equal(evidence.manifest.lifecycle.executed, false);
    assert.equal(
      evidence.manifest.lifecycle.commandSource,
      "exact-source-proof-reuse",
    );
    assert.equal(
      evidence.manifest.qualification.sourceProofRoot,
      value.proof.proofRoot,
    );
    assert.equal(
      evidence.summary.contract,
      "kungfu-buildchain-artifact-summary",
    );
    assert.equal(evidence.summary.fileCount, 2);
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(fs.existsSync(summaryPath), true);
  } finally {
    fs.rmSync(value.cwd, { recursive: true, force: true });
  }
});

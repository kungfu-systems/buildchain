import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { verifyLifecycleSubstageEvidence } from "../packages/core/build/lifecycle/substage-evidence.js";
import { runLifecycle } from "../packages/core/build/lifecycle/transaction.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function rooted(value) {
  return { ...value, evidenceRoot: digest(value) };
}

function fixture(overrides = {}) {
  const substage = rooted({
    stage: "gate",
    startedAt: "2026-08-03T00:00:00.000Z",
    completedAt: "2026-08-03T00:00:01.000Z",
    durationSeconds: 1,
    status: 0,
    conclusion: "passed",
    executionMode: "platform-native",
    concurrencyGroup: "parallel-gate",
  });
  return rooted({
    schema: "kungfu.lifecycle-substage-evidence/v1",
    lifecycleStage: "verify",
    generatedAt: "2026-08-03T00:00:01.000Z",
    startedAt: "2026-08-03T00:00:00.000Z",
    completedAt: "2026-08-03T00:00:01.000Z",
    conclusion: "passed",
    source: { sha: "a".repeat(40), tree: "b".repeat(40) },
    platform: { id: "linux-x64", os: "linux", arch: "x64" },
    roots: { qualificationPolicy: `sha256:${"c".repeat(64)}` },
    execution: {
      policy: "bounded",
      maxParallelism: 2,
      groups: ["parallel-gate"],
    },
    durationSeconds: 1,
    substages: [substage],
    ...overrides,
  });
}

test("lifecycle substage evidence binds exact source, platform, and rooted rows", () => {
  const evidence = fixture();
  assert.equal(
    verifyLifecycleSubstageEvidence(evidence, {
      lifecycleStage: "verify",
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      platformId: "linux-x64",
    }).evidenceRoot,
    evidence.evidenceRoot,
  );
  assert.throws(
    () =>
      verifyLifecycleSubstageEvidence(evidence, {
        sourceSha: "d".repeat(40),
      }),
    /source SHA mismatch/,
  );
});

test("lifecycle substage evidence fails closed on a hidden sibling failure", () => {
  const failedRow = rooted({
    ...fixture().substages[0],
    status: 1,
    conclusion: "failed",
    evidenceRoot: undefined,
  });
  const inconsistent = fixture({ substages: [failedRow] });
  assert.throws(
    () => verifyLifecycleSubstageEvidence(inconsistent),
    /aggregate conclusion is inconsistent/,
  );
});

test("a failed aggregate distinguishes substage failure from budget exhaustion", () => {
  const budgetExceeded = fixture({
    conclusion: "failed",
    failureReason: "budget-exceeded",
  });
  assert.equal(
    verifyLifecycleSubstageEvidence(budgetExceeded).failureReason,
    "budget-exceeded",
  );
  const failedRow = rooted({
    ...fixture().substages[0],
    status: 1,
    conclusion: "failed",
    evidenceRoot: undefined,
  });
  const failed = fixture({
    conclusion: "failed",
    failureReason: "substage-failed",
    substages: [failedRow],
  });
  assert.equal(
    verifyLifecycleSubstageEvidence(failed).failureReason,
    "substage-failed",
  );
});

test("runLifecycle embeds independently verified consumer substages", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-substages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = fixture({
    source: {
      sha: process.env.BUILDCHAIN_SOURCE_SHA || "a".repeat(40),
      tree: process.env.BUILDCHAIN_SOURCE_TREE_SHA || "b".repeat(40),
    },
  });
  fs.writeFileSync(
    path.join(root, "substage.json"),
    `${JSON.stringify({ substageEvidence: evidence }, null, 2)}\n`,
  );
  const manifest = runLifecycle({
    cwd: root,
    workspace: root,
    stageName: "verify",
    command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
    required: true,
    platformId: "linux-x64",
    artifactPaths: [],
    manifestPath: "manifest.json",
    summaryPath: "summary.json",
    substageEvidencePath: "substage.json",
    logPath: "events.jsonl",
  });
  assert.equal(
    manifest.lifecycle.substageEvidence.evidenceRoot,
    evidence.evidenceRoot,
  );
  assert.equal(manifest.observability.substages.conclusion, "passed");
  assert.equal(fs.existsSync(path.join(root, "verify-substages.json")), true);
});

test("TOML verification evidence reaches lifecycle validation and failure transport", () => {
  const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
  const stage = read("packages/core/build/plan/lifecycle.js");
  const transport = read("packages/core/build/artifact/upload.js");
  assert.match(stage, /substageEvidencePath:\s*stage === "verify"\s*\? plan.build.verification.substage_evidence_path/u);
  assert.match(transport, /plan.build.verification.substage_evidence_path/u);
  assert.match(read("packages/core/build/lifecycle/artifacts.js"), /substageEvidencePath: context.substageEvidencePath/u);
  assert.match(read("packages/core/build/plan/environment.js"), /BUILDCHAIN_SOURCE_TREE_SHA: plan.source.tree_sha/u);
  assert.match(read("actions/build/lifecycle/run/action.yml"), /^  substage-evidence-path:/mu);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReleaseTransaction,
  defaultPublishEvidencePath,
  defaultReleaseStatePath,
  planArtifactPublish,
  planTransactionRecovery,
  readReleaseTransaction,
  transitionReleaseTransaction,
  validatePublishEvidence,
  writeReleaseTransaction,
} from "../packages/core/publish-transaction.js";

const SHA = "a".repeat(40);
const RELEASE_SHA = "b".repeat(40);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-transaction-"));
}

function evidence(overrides = {}) {
  return {
    schema: 1,
    version: "1.0.0",
    channel: "release",
    source_sha: SHA,
    release_sha: RELEASE_SHA,
    target_ref: "release/v1/v1.0",
    release_material_sha: RELEASE_SHA,
    publish_tooling_sha: RELEASE_SHA,
    artifacts: [
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-systems/example",
        ref: "1.0.0",
        digest: "sha256:npm",
      },
      {
        group: "image",
        kind: "oci",
        name: "ghcr.io/kungfu-systems/example",
        ref: "1.0.0",
        digest: "sha256:image",
      },
    ],
    ...overrides,
  };
}

test("publish evidence validates common fields and required multi-artifact units", () => {
  const validation = validatePublishEvidence({
    evidence: evidence(),
    version: "1.0.0",
    channel: "release",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "release/v1/v1.0",
    releaseMaterialSha: RELEASE_SHA,
    publishToolingSha: RELEASE_SHA,
    requiredArtifacts: [
      { kind: "npm", name: "@kungfu-systems/example", ref: "1.0.0", digest: "sha256:npm" },
      { kind: "oci", name: "ghcr.io/kungfu-systems/example", ref: "1.0.0", digest: "sha256:image" },
    ],
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.evidence.artifacts.length, 2);
});

test("publish evidence fails closed on material drift and missing required artifacts", () => {
  const validation = validatePublishEvidence({
    evidence: evidence({ release_material_sha: "c".repeat(40), artifacts: [] }),
    version: "1.0.0",
    channel: "release",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "release/v1/v1.0",
    releaseMaterialSha: RELEASE_SHA,
    requiredArtifacts: [
      { kind: "npm", name: "@kungfu-systems/example", ref: "1.0.0", digest: "sha256:npm" },
    ],
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("\n"), /release_material_sha mismatch/);
  assert.match(validation.errors.join("\n"), /required artifact missing/);
});

test("artifact publish plan resumes missing artifacts and requires repair on conflicts", () => {
  const plan = planArtifactPublish({
    requiredArtifacts: [
      { kind: "npm", name: "pkg-a", ref: "1.0.0", digest: "sha256:a" },
      { kind: "oci", name: "image-a", ref: "1.0.0", digest: "sha256:b" },
      { kind: "binary", name: "darwin-arm64", ref: "1.0.0", digest: "sha256:c" },
    ],
    existingArtifacts: [
      { kind: "npm", name: "pkg-a", ref: "1.0.0", digest: "sha256:a" },
      { kind: "oci", name: "image-a", ref: "1.0.0", digest: "sha256:wrong" },
    ],
  });
  assert.deepEqual(plan.accepted.map((artifact) => artifact.name), ["pkg-a"]);
  assert.deepEqual(plan.publish.map((artifact) => artifact.name), ["darwin-arm64"]);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.repairRequired, true);
});

test("transaction recovery blocks repair and abandoned states unless override is explicit", () => {
  const record = transitionReleaseTransaction(
    createReleaseTransaction({
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      exactTag: "v1.0.0",
      channel: "release",
      sourceSha: SHA,
      targetRef: "release/v1/v1.0",
      releaseSha: RELEASE_SHA,
    }),
    "publishing",
  );
  const repair = transitionReleaseTransaction(record, "repair_required", {
    failure: "artifact digest mismatch",
  });
  assert.deepEqual(planTransactionRecovery({ transaction: repair }), {
    action: "blocked",
    blocked: true,
    reason: "transaction requires explicit repair",
  });
  assert.equal(
    planTransactionRecovery({ transaction: repair, explicitOverride: true }).action,
    "publish",
  );

  const abandoned = transitionReleaseTransaction(repair, "abandoned", {
    supersededBy: "v1.0.1",
  });
  assert.equal(planTransactionRecovery({ transaction: abandoned }).blocked, true);
  assert.equal(
    planTransactionRecovery({ transaction: abandoned, explicitOverride: true }).blocked,
    false,
  );
});

test("release-transaction CLI can inspect, recover, and finalize a valid local transaction", () => {
  const cwd = tempDir();
  const statePath = defaultReleaseStatePath("v1.0.0", cwd);
  const evidencePath = defaultPublishEvidencePath("v1.0.0", cwd);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence(), null, 2)}\n`);
  const record = transitionReleaseTransaction(
    createReleaseTransaction({
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      exactTag: "v1.0.0",
      channel: "release",
      sourceSha: SHA,
      targetRef: "release/v1/v1.0",
      releaseSha: RELEASE_SHA,
      statePath,
      evidencePath,
    }),
    "publishing",
  );
  writeReleaseTransaction(statePath, transitionReleaseTransaction(record, "published"));

  const cli = path.join(process.cwd(), "scripts/release-transaction.mjs");
  const recover = spawnSync(process.execPath, [
    cli,
    "recover",
    "--version",
    "v1.0.0",
    "--state-path",
    statePath,
    "--evidence-path",
    evidencePath,
  ], { cwd, encoding: "utf8" });
  assert.equal(recover.status, 0, recover.stderr);
  assert.match(recover.stdout, /"action": "finalize"/);

  const finalize = spawnSync(process.execPath, [
    cli,
    "finalize",
    "--version",
    "v1.0.0",
    "--state-path",
    statePath,
    "--evidence-path",
    evidencePath,
  ], { cwd, encoding: "utf8" });
  assert.equal(finalize.status, 0, finalize.stderr);
  assert.equal(readReleaseTransaction(statePath).state, "complete");
});

test("publish-transaction-shaped fixture writes valid generic evidence", () => {
  const fixture = path.join(process.cwd(), "fixtures/publish-transaction-shaped");
  const cwd = tempDir();
  fs.cpSync(fixture, cwd, { recursive: true });
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json");
  const run = spawnSync(process.execPath, ["scripts/publish.mjs"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      BUILDCHAIN_VERSION: "1.0.0",
      BUILDCHAIN_CHANNEL: "release",
      BUILDCHAIN_SOURCE_SHA: SHA,
      BUILDCHAIN_RELEASE_SHA: RELEASE_SHA,
      BUILDCHAIN_RELEASE_MATERIAL_SHA: RELEASE_SHA,
      BUILDCHAIN_PUBLISH_TOOLING_SHA: "c".repeat(40),
      BUILDCHAIN_TARGET_REF: "release/v1/v1.0",
      BUILDCHAIN_EVIDENCE_DIR: path.dirname(evidencePath),
      BUILDCHAIN_PUBLISH_EVIDENCE: evidencePath,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const validation = validatePublishEvidence({
    evidence: JSON.parse(fs.readFileSync(evidencePath, "utf8")),
    version: "1.0.0",
    channel: "release",
    sourceSha: SHA,
    releaseSha: RELEASE_SHA,
    targetRef: "release/v1/v1.0",
    releaseMaterialSha: RELEASE_SHA,
    publishToolingSha: "c".repeat(40),
    requiredArtifacts: [
      {
        kind: "npm",
        name: "@kungfu-systems/publish-transaction-shaped",
        ref: "1.0.0",
        digest: JSON.parse(fs.readFileSync(evidencePath, "utf8")).artifacts[0].digest,
      },
      {
        kind: "oci",
        name: "ghcr.io/kungfu-systems/publish-transaction-shaped",
        ref: "1.0.0",
        digest: JSON.parse(fs.readFileSync(evidencePath, "utf8")).artifacts[1].digest,
      },
      {
        kind: "archive",
        name: "publish-transaction-shaped-darwin-arm64",
        ref: "1.0.0",
        digest: JSON.parse(fs.readFileSync(evidencePath, "utf8")).artifacts[2].digest,
      },
    ],
  });
  assert.equal(validation.valid, true);
});

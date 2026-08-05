import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { devDeliveryProofCliOptions, runDevDeliveryProofCommand } from "../scripts/dev-delivery-proof.mjs";

const ROOT = `sha256:${"1".repeat(64)}`;
const ROOT_2 = `sha256:${"2".repeat(64)}`;
const SHA = "a".repeat(40);
const SHA_2 = "b".repeat(40);

function sourceOptions(overrides = {}) {
  return {
    command: "source",
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    sourceIdentityRoot: ROOT,
    sourceHead: SHA,
    sourcePatchRoot: ROOT,
    planRoot: ROOT,
    closureRoot: ROOT,
    dependencyRoot: ROOT,
    toolchainRoot: ROOT,
    affectedPaths: '["framework/core/a.cc"]',
    shardEvidenceRoots: `["${ROOT_2}"]`,
    qualifiedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("source proof command creates and verifies a content-addressed proof", () => {
  const proof = runDevDeliveryProofCommand(sourceOptions());
  assert.match(proof.proofRoot, /^sha256:[0-9a-f]{64}$/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-proof-"));
  const proofPath = path.join(directory, "source.json");
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  try {
    assert.deepEqual(
      runDevDeliveryProofCommand({
        command: "verify-source",
        sourceProofPath: proofPath,
      }),
      { ok: true, reason: "exact-source-proof", proofRoot: proof.proofRoot },
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("classifier CLI defaults unknown dependency attribution to full requalification", () => {
  const proof = runDevDeliveryProofCommand(sourceOptions());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-proof-"));
  const proofPath = path.join(directory, "source.json");
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  try {
    const result = runDevDeliveryProofCommand({
      ...sourceOptions({ command: "classify" }),
      sourceProofPath: proofPath,
      graphKnown: false,
      changedPaths: "[]",
    });
    assert.equal(result.action, "rerun-full-source-qualification");
    assert.equal(result.reason, "dependency-attribution-unknown");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("integration command binds the active Warrant and exact merge-group tree", () => {
  const source = runDevDeliveryProofCommand(sourceOptions());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-proof-"));
  const sourcePath = path.join(directory, "source.json");
  const warrantPath = path.join(directory, "warrant.json");
  fs.writeFileSync(sourcePath, JSON.stringify(source));
  fs.writeFileSync(
    warrantPath,
    JSON.stringify({
      schema: "kungfu.buildchain.dev-delivery-command-result/v1",
      warrant: {
        schema: "kungfu.buildchain.dev-delivery-warrant/v1",
        candidateId: ROOT,
        fencingToken: ROOT_2,
        generation: 3,
      },
    }),
  );
  try {
    const proof = runDevDeliveryProofCommand({
      command: "integration",
      repository: "kungfu-systems/kungfu",
      protectedBase: "dev/v4/v4.0",
      sourceProofPath: sourcePath,
      warrantResultPath: warrantPath,
      currentBase: SHA,
      replayTree: SHA_2,
      mergeGroupHead: SHA_2,
      mergeGroupTree: SHA,
      requiredContextRoots: `["${ROOT}"]`,
      verifiedAt: "2026-08-04T01:00:00.000Z",
    });
    assert.equal(proof.warrantGeneration, 3);
    assert.equal(proof.mergeGroupTree, SHA);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("proof CLI parses JSON-list and graph inputs without ambient mutation", () => {
  const options = devDeliveryProofCliOptions(["classify", "--source-proof", "source.json", "--changed-paths-json", '["a.cc"]', "--graph-known", "true"], {});
  assert.equal(options.command, "classify");
  assert.equal(options.sourceProofPath, "source.json");
  assert.equal(options.graphKnown, true);
});

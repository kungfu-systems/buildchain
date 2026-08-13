import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeTailResealRequest,
  restoreTailResealManifestRunIdentity,
  tailResealFailureMode,
  sealTailResealReceipt,
  verifyTailResealPlatform,
} from "../scripts/release-candidate-tail-reseal.mjs";

const SOURCE_SHA = "a".repeat(40);
const SOURCE_TREE = "b".repeat(40);
const RUNTIME_SHA = "c".repeat(40);
const CONTROLLER_SHA = "d".repeat(40);
const CONTROLLER_TREE = "e".repeat(40);
const AUTHORITY_SHA = "f".repeat(40);
const ROOT = `sha256:${"1".repeat(64)}`;
const IDS = ["linux-arm64", "linux-x64", "macos-arm64", "windows-x64"];

function request() {
  return {
    contract: "kungfu-buildchain-release-candidate-tail-reseal/v1",
    repository: "owner/product",
    source: {
      runId: 123,
      runAttempt: 1,
      sha: SOURCE_SHA,
      tree: SOURCE_TREE,
      workflowFile: "build.yml",
      workflowName: "Build",
    },
    target: {
      channel: "alpha",
      ref: "alpha/v4/v4.0",
      baseSha: "9".repeat(40),
      version: "4.0.0-alpha.2",
    },
    candidateRuntime: {
      repository: "kungfu-systems/buildchain",
      ref: "v3-alpha",
      sha: RUNTIME_SHA,
      contractDigest: ROOT,
    },
    consumerController: {
      repository: "owner/product",
      sha: CONTROLLER_SHA,
      tree: CONTROLLER_TREE,
    },
    failure: {
      jobId: 456,
      jobName: "build / Finalize signed artifact macOS ARM64",
      stepName: "Recompute manifest over final signed bytes",
    },
    authority: {
      repository: "kungfu-systems/buildchain",
      runId: 789,
      runtimeSha: AUTHORITY_SHA,
      resultArtifact: "signed-result",
      resultArtifactDigest: ROOT,
    },
    controllerPlanArtifact: "controller-plan",
    platforms: IDS.map((id) => ({
      id,
      name: id,
      runner: id === "macos-arm64" ? '["macos-15"]' : '["ubuntu-24.04"]',
      artifactName: `product-${id}-${SOURCE_SHA}`,
      artifactDigest: ROOT,
      manifestArtifactName: `product-manifest-${id}-${SOURCE_SHA}`,
      manifestArtifactDigest: ROOT,
      artifactPaths: "product/release\n.buildchain/artifacts",
    })),
  };
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writePlatform(root, platformId) {
  const payload = path.join(root, "product", platformId, "payload.bin");
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, platformId);
  const manifest = {
    contract: "kungfu-buildchain-artifact",
    artifactName: `product-${platformId}-${SOURCE_SHA}`,
    git: {
      repository: "owner/product",
      sha: SOURCE_SHA,
      runId: "123",
      runAttempt: "1",
    },
    platform: { id: platformId, name: platformId },
    files: [{ path: path.relative(root, payload), size: fs.statSync(payload).size, sha256: digest(payload) }],
    summary: { fileCount: 1, totalBytes: fs.statSync(payload).size },
  };
  const manifestFile = path.join(root, "manifests", platformId, "manifest.json");
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestFile;
}

function withEnvironment(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("tail reseal request requires one exact four-platform candidate", () => {
  const normalized = normalizeTailResealRequest(request());
  assert.deepEqual(normalized.platforms.map(({ id }) => id), [...IDS].sort());
  assert.equal(normalized.candidateRuntime.ref, "v3-alpha");
  assert.throws(
    () => normalizeTailResealRequest({ ...request(), platforms: request().platforms.slice(1) }),
    /exactly four platform bindings/u,
  );
});

test("tail reseal admits only the two exact macOS failure boundaries", () => {
  assert.equal(tailResealFailureMode(request()), "macos-finalization");
  assert.equal(tailResealFailureMode({
    ...request(),
    failure: {
      jobId: 456,
      jobName: "build / Control detached signing macOS ARM64",
      stepName: "Enforce qualifying detached signing settlement",
    },
  }), "macos-signing-control");
  assert.throws(() => tailResealFailureMode({
    ...request(),
    failure: {
      jobId: 456,
      jobName: "build / Linux x64",
      stepName: "Build",
    },
  }), /outside the two exact macOS recovery boundaries/u);
});

test("platform verification rejects changed retained bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-tail-platform-"));
  const requestFile = path.join(root, "request.json");
  fs.writeFileSync(requestFile, `${JSON.stringify(request())}\n`);
  writePlatform(root, "linux-x64");
  withEnvironment({
    BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: requestFile,
    BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID: "linux-x64",
    BUILDCHAIN_TAIL_RESEAL_ARTIFACT_ROOT: root,
  }, () => verifyTailResealPlatform());
  fs.writeFileSync(path.join(root, "product", "linux-x64", "payload.bin"), "changed");
  assert.throws(
    () => withEnvironment({
      BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: requestFile,
      BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID: "linux-x64",
      BUILDCHAIN_TAIL_RESEAL_ARTIFACT_ROOT: root,
    }, () => verifyTailResealPlatform()),
    /size mismatch|digest mismatch/u,
  );
});

test("signed macOS manifest recomputation restores only the original build run identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-tail-manifest-run-"));
  const requestFile = path.join(root, "request.json");
  fs.writeFileSync(requestFile, `${JSON.stringify(request())}\n`);
  const manifestFile = writePlatform(root, "macos-arm64");
  const preSigningManifestFile = path.join(root, "manifest-pre-signing.json");
  fs.copyFileSync(manifestFile, preSigningManifestFile);
  const recomputed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  recomputed.git.runId = "999";
  recomputed.git.runAttempt = "2";
  recomputed.files[0].signed = true;
  fs.writeFileSync(manifestFile, `${JSON.stringify(recomputed, null, 2)}\n`);

  const restored = withEnvironment({
    BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: requestFile,
    BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID: "macos-arm64",
    BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH: manifestFile,
    BUILDCHAIN_TAIL_RESEAL_PRE_SIGNING_MANIFEST_PATH: preSigningManifestFile,
    GITHUB_RUN_ID: "999",
    GITHUB_RUN_ATTEMPT: "2",
  }, () => restoreTailResealManifestRunIdentity());

  assert.equal(restored.git.runId, "123");
  assert.equal(restored.git.runAttempt, "1");
  assert.equal(restored.files[0].signed, true);
  withEnvironment({
    BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: requestFile,
    BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID: "macos-arm64",
    BUILDCHAIN_TAIL_RESEAL_ARTIFACT_ROOT: root,
  }, () => verifyTailResealPlatform());
});

test("signed macOS manifest run restoration rejects unrelated recomputation identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-tail-manifest-run-reject-"));
  const requestFile = path.join(root, "request.json");
  fs.writeFileSync(requestFile, `${JSON.stringify(request())}\n`);
  const manifestFile = writePlatform(root, "macos-arm64");
  const preSigningManifestFile = path.join(root, "manifest-pre-signing.json");
  fs.copyFileSync(manifestFile, preSigningManifestFile);
  const recomputed = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  recomputed.git.runId = "777";
  fs.writeFileSync(manifestFile, `${JSON.stringify(recomputed, null, 2)}\n`);

  assert.throws(() => withEnvironment({
    BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: requestFile,
    BUILDCHAIN_TAIL_RESEAL_PLATFORM_ID: "macos-arm64",
    BUILDCHAIN_TAIL_RESEAL_MANIFEST_PATH: manifestFile,
    BUILDCHAIN_TAIL_RESEAL_PRE_SIGNING_MANIFEST_PATH: preSigningManifestFile,
    GITHUB_RUN_ID: "999",
    GITHUB_RUN_ATTEMPT: "1",
  }, () => restoreTailResealManifestRunIdentity()), /neither the original build nor the current tail run/u);
});

test("tail reseal receipt records skipped build and current tooling separately", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-tail-receipt-"));
  const requestFile = path.join(root, "request.json");
  fs.writeFileSync(requestFile, `${JSON.stringify(request())}\n`);
  for (const id of IDS) writePlatform(root, id);
  const receiptFile = path.join(root, "receipt.json");
  const receipt = withEnvironment({
    BUILDCHAIN_TAIL_RESEAL_REQUEST_PATH: requestFile,
    BUILDCHAIN_TAIL_RESEAL_MANIFESTS_ROOT: path.join(root, "manifests"),
    BUILDCHAIN_TAIL_RESEAL_TOOLING_REF: "v3-alpha",
    BUILDCHAIN_TAIL_RESEAL_TOOLING_SHA: "8".repeat(40),
    BUILDCHAIN_TAIL_RESEAL_RECEIPT_PATH: receiptFile,
    GITHUB_RUN_ID: "999",
    GITHUB_RUN_ATTEMPT: "1",
  }, () => sealTailResealReceipt());
  assert.equal(receipt.action, "reused-tail-reseal");
  assert.equal(receipt.candidateRuntime.sha, RUNTIME_SHA);
  assert.equal(receipt.recoveryTooling.sha, "8".repeat(40));
  assert.deepEqual(receipt.skippedStages, ["install", "build", "verify", "platform-matrix"]);
  assert.match(receipt.root, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.parse(fs.readFileSync(receiptFile, "utf8")).root, receipt.root);
});

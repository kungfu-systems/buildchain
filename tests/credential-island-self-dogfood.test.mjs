import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyCredentialIslandSelfDogfood } from "../scripts/verify-credential-island-self-dogfood.mjs";

const SOURCE_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const RUNTIME_SHA = "3".repeat(40);
const ARTIFACT_NAME = `buildchain-v3-credential-island-self-dogfood-macos-credential-${SOURCE_SHA}`;
const MANIFEST_ARTIFACT_NAME = `buildchain-v3-credential-island-self-dogfood-manifest-macos-credential-${SOURCE_SHA}`;

function sha256(filePath, prefix = "") {
  return `${prefix}${crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")}`;
}

function credentialFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-self-dogfood-test-"),
  );
  const payloadRoot = path.join(root, "payload");
  const manifestRoot = path.join(root, "manifest");
  const releaseRoot = path.join(payloadRoot, "product", "release");
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.mkdirSync(manifestRoot, { recursive: true });
  const dmg = path.join(releaseRoot, "Buildchain-1.0.0-macos-arm64.dmg");
  const zip = path.join(releaseRoot, "Buildchain-1.0.0-macos-arm64.zip");
  const evidencePath = path.join(
    releaseRoot,
    "credential-island-evidence.json",
  );
  fs.writeFileSync(dmg, "signed-and-notarized-dmg");
  fs.writeFileSync(zip, "signed-and-notarized-app-zip");
  const evidence = {
    schema: "buildchain.macos-credential-island-evidence/v1",
    status: "accepted",
    source: {
      repository: "kungfu-systems/buildchain",
      sha: SOURCE_SHA,
      treeSha: TREE_SHA,
    },
    buildchain: { runtimeSha: RUNTIME_SHA },
    app: {
      bundleId: "dev.libkungfu.buildchain.credential-island",
      architecture: "arm64",
    },
    identity: {
      certificateSha1: "a".repeat(40),
      certificateSubject: "Developer ID Application: Example (ABCDE12345)",
      teamId: "ABCDE12345",
    },
    notarization: {
      application: {
        id: "11111111-2222-3333-4444-555555555555",
        status: "Accepted",
      },
      diskImage: {
        id: "66666666-7777-8888-9999-aaaaaaaaaaaa",
        status: "Accepted",
      },
    },
    verification: {
      codesignStrict: true,
      hardenedRuntime: true,
      appStaple: true,
      appGatekeeper: true,
      dmgStaple: true,
      dmgGatekeeper: true,
    },
    artifacts: [
      {
        kind: "zip",
        name: path.basename(zip),
        bytes: fs.statSync(zip).size,
        sha256: sha256(zip, "sha256:"),
      },
      {
        kind: "dmg",
        name: path.basename(dmg),
        bytes: fs.statSync(dmg).size,
        sha256: sha256(dmg, "sha256:"),
      },
    ],
    runner: { os: "darwin", arch: "arm64", image: "macos-15" },
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  const files = [dmg, evidencePath, zip]
    .map((filePath) => ({
      path: path.relative(payloadRoot, filePath).split(path.sep).join("/"),
      size: fs.statSync(filePath).size,
      sha256: sha256(filePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName: ARTIFACT_NAME,
    platform: {
      id: "macos-hosted-credential",
      name: "macos-hosted credential island",
      os: "macos",
      arch: "arm64",
    },
    git: {
      repository: "kungfu-systems/buildchain",
      sha: SOURCE_SHA,
      ref: "refs/heads/dev/v3/v3.0",
    },
    lifecycle: {
      stage: "credential-island",
      commandSource: "buildchain-action",
      executed: true,
    },
    expectedArtifacts: {
      ok: true,
      source: "buildchain.macos-credential-island-evidence/v1",
    },
    files,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(payloadRoot, "manifest.json"), manifestBytes);
  fs.writeFileSync(path.join(manifestRoot, "manifest.json"), manifestBytes);
  return { root, payloadRoot, manifestRoot, dmg };
}

function verify(value, overrides = {}) {
  return verifyCredentialIslandSelfDogfood({
    jobResult: "success",
    payloadRoot: value.payloadRoot,
    manifestRoot: value.manifestRoot,
    expectedRepository: "kungfu-systems/buildchain",
    expectedSourceSha: SOURCE_SHA,
    expectedRuntimeSha: RUNTIME_SHA,
    expectedArtifactName: ARTIFACT_NAME,
    expectedManifestArtifactName: MANIFEST_ARTIFACT_NAME,
    ...overrides,
  });
}

test("credential-island self-dogfood accepts exact retained production evidence", () => {
  const value = credentialFixture();
  try {
    const result = verify(value);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.failures, []);
    assert.equal(result.observed.sourceSha, SOURCE_SHA);
    assert.equal(result.observed.runtimeSha, RUNTIME_SHA);
    assert.equal(result.observed.fileCount, 3);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("credential-island self-dogfood rejects a tampered retained payload", () => {
  const value = credentialFixture();
  try {
    fs.appendFileSync(value.dmg, "tamper");
    const result = verify(value);
    assert.equal(result.status, "failed");
    assert.ok(
      result.failures.some((failure) =>
        failure.includes("credential payload SHA-256 mismatch"),
      ),
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("credential-island self-dogfood rejects skipped protected execution", () => {
  const value = credentialFixture();
  try {
    const result = verify(value, { jobResult: "skipped" });
    assert.equal(result.status, "failed");
    assert.ok(
      result.failures.includes("credential-island job result is skipped"),
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("credential-island self-dogfood rejects a detached manifest artifact", () => {
  const value = credentialFixture();
  try {
    fs.appendFileSync(path.join(value.manifestRoot, "manifest.json"), "\n");
    const result = verify(value);
    assert.equal(result.status, "failed");
    assert.ok(
      result.failures.includes(
        "authoritative manifest artifact does not byte-match the payload manifest",
      ),
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

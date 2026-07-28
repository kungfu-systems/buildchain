import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_SIGNING_RECEIPT_CONTRACT,
  ARTIFACT_SIGNING_REQUEST_CONTRACT,
  createArtifactSigningReceipt,
  createArtifactSigningRequest,
  listArtifactSigningProfiles,
  resolveArtifactSigningProfile,
  validateArtifactSigningReceipt,
  validateArtifactSigningRequest,
} from "../packages/core/artifact-signing.js";

const SOURCE_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const RUNTIME_SHA = "3".repeat(40);
const INPUT_DIGEST = `sha256:${"4".repeat(64)}`;
const OUTPUT_DIGEST = `sha256:${"5".repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${"6".repeat(64)}`;
const SIGNATURE_DIGEST = `sha256:${"7".repeat(64)}`;

function request(overrides = {}) {
  return createArtifactSigningRequest({
    source: {
      repository: "kungfu-systems/kungfu",
      sha: SOURCE_SHA,
      treeSha: TREE_SHA,
    },
    runtime: {
      repository: "kungfu-systems/buildchain",
      sha: RUNTIME_SHA,
    },
    artifact: {
      id: "kungfu-engine",
      path: "dist/kungfu-engine",
      kind: "mach-o",
      platform: "macos",
      bytes: 1024,
      digest: INPUT_DIGEST,
    },
    signature: { profile: "auto" },
    ...overrides,
  });
}

test("artifact signing is a generic Buildchain request, not an app contract", () => {
  const value = request();
  assert.equal(value.contract, ARTIFACT_SIGNING_REQUEST_CONTRACT);
  assert.equal(value.artifact.kind, "mach-o");
  assert.equal(value.signature.profile, "apple-developer-id");
  assert.equal(value.signature.semantics, "native-platform-signature");
  assert.equal(value.authority.id, "kungfu-systems/buildchain");
  assert.deepEqual(validateArtifactSigningRequest(value), {
    ok: true,
    issues: [],
  });
  assert.doesNotMatch(
    JSON.stringify(value),
    /certificate|notary|password|team.?id|environment/iu,
  );
});

test("auto profile covers arbitrary non-native binary artifacts honestly", () => {
  const value = request({
    artifact: {
      id: "linux-cli",
      path: "dist/buildchain",
      kind: "binary",
      platform: "linux",
      bytes: 2048,
      digest: INPUT_DIGEST,
    },
  });
  assert.equal(value.signature.profile, "detached-signature-v1");
  assert.equal(value.signature.semantics, "detached-cryptographic-signature");
  assert.ok(
    listArtifactSigningProfiles().some(
      (profile) => profile.id === "detached-signature-v1",
    ),
  );
});

test("auto profile requires native Authenticode for Windows PE artifacts", () => {
  const value = request({
    artifact: {
      id: "windows-cli",
      path: "dist/buildchain.exe",
      kind: "pe",
      platform: "windows",
      bytes: 4096,
      digest: INPUT_DIGEST,
    },
  });
  assert.equal(value.signature.profile, "windows-authenticode");
  assert.equal(value.signature.provider, "microsoft-authenticode");
  assert.equal(value.signature.semantics, "native-platform-signature");
  assert.throws(
    () =>
      resolveArtifactSigningProfile({
        profile: "detached-signature-v1",
        platform: "windows",
        artifactKind: "pe",
      }),
    /does not support artifact kind pe/,
  );
});

test("native profiles fail closed for incompatible artifacts and platforms", () => {
  assert.throws(
    () =>
      resolveArtifactSigningProfile({
        profile: "apple-developer-id",
        platform: "windows",
        artifactKind: "binary",
      }),
    /does not support platform windows/,
  );
  assert.throws(
    () =>
      resolveArtifactSigningProfile({
        profile: "apple-developer-id",
        platform: "macos",
        artifactKind: "archive",
      }),
    /does not support artifact kind archive/,
  );
});

test("consumer requests reject credential and environment configuration", () => {
  assert.throws(
    () =>
      request({
        signature: {
          profile: "apple-developer-id",
          certificate: "consumer-owned",
        },
      }),
    /credential configuration/,
  );
  assert.throws(
    () =>
      request({
        delivery: {
          mode: "buildchain-authority",
          environment: "consumer-environment",
        },
      }),
    /credential configuration/,
  );
});

test("signing receipts bind the exact request, runtime, result, and evidence", () => {
  const input = request();
  const receipt = createArtifactSigningReceipt({
    request: input,
    result: {
      artifactDigest: OUTPUT_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST,
    },
    signatures: [{ kind: "codesign", digest: SIGNATURE_DIGEST }],
  });
  assert.equal(receipt.contract, ARTIFACT_SIGNING_RECEIPT_CONTRACT);
  assert.equal(receipt.requestDigest, input.digest);
  assert.deepEqual(
    validateArtifactSigningReceipt(receipt, { request: input }),
    {
      ok: true,
      issues: [],
    },
  );

  const substituted = structuredClone(receipt);
  substituted.requestDigest = `sha256:${"8".repeat(64)}`;
  const check = validateArtifactSigningReceipt(substituted, { request: input });
  assert.equal(check.ok, false);
  assert.ok(check.issues.includes("receipt digest mismatch"));
  assert.ok(check.issues.includes("receipt request digest mismatch"));
});

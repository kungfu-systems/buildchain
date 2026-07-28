import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import {
  DETACHED_ARTIFACT_SIGNATURE_CONTRACT,
  signDetachedArtifactRequest,
  verifyDetachedArtifactSignature,
} from "../packages/core/detached-artifact-signature.js";

function request() {
  return createArtifactSigningRequest({
    source: {
      repository: "kungfu-systems/consumer",
      sha: "1".repeat(40),
      treeSha: "2".repeat(40),
    },
    runtime: { sha: "3".repeat(40) },
    artifact: {
      id: "linux-cli",
      path: "dist/cli",
      kind: "binary",
      platform: "linux",
      bytes: 100,
      digest: `sha256:${"4".repeat(64)}`,
    },
  });
}

test("Buildchain authority signs arbitrary binary requests with detached Ed25519", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const input = request();
  const signed = signDetachedArtifactRequest({
    request: input,
    privateKey,
    keyId: "buildchain-detached-test-v1",
  });
  assert.equal(signed.envelope.contract, DETACHED_ARTIFACT_SIGNATURE_CONTRACT);
  assert.equal(signed.receipt.status, "passed");
  assert.equal(signed.receipt.result.artifactDigest, input.artifact.digest);
  assert.deepEqual(
    verifyDetachedArtifactSignature({
      request: input,
      envelope: signed.envelope,
      publicKey,
    }),
    { ok: true, issues: [] },
  );

  const substituted = structuredClone(signed.envelope);
  substituted.artifactDigest = `sha256:${"9".repeat(64)}`;
  assert.equal(
    verifyDetachedArtifactSignature({
      request: input,
      envelope: substituted,
      publicKey,
    }).ok,
    false,
  );
});

test("detached authority rejects native platform requests", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const nativeRequest = createArtifactSigningRequest({
    source: {
      repository: "kungfu-systems/consumer",
      sha: "1".repeat(40),
      treeSha: "2".repeat(40),
    },
    runtime: { sha: "3".repeat(40) },
    artifact: {
      id: "mac-cli",
      path: "dist/cli",
      kind: "mach-o",
      platform: "macos",
      bytes: 100,
      digest: `sha256:${"4".repeat(64)}`,
    },
  });
  assert.throws(
    () =>
      signDetachedArtifactRequest({
        request: nativeRequest,
        privateKey,
        keyId: "buildchain-detached-test-v1",
      }),
    /requires detached-signature-v1/,
  );
});

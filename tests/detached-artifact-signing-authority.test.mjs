import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import { verifyDetachedArtifactSignature } from "../packages/core/detached-artifact-signature.js";
import { signDetachedArtifactRequests } from "../scripts/sign-detached-artifact-requests.mjs";
import { verifyArtifactSigningResults } from "../scripts/verify-artifact-signing-results.mjs";

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

test("detached authority signs only the exact sealed binary payload", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-detached-authority-"),
  );
  try {
    const inputRoot = path.join(root, "input");
    const requestRoot = path.join(inputRoot, "cli");
    fs.mkdirSync(requestRoot, { recursive: true });
    const payload = Buffer.from("sealed-binary\n");
    const payloadPath = path.join(requestRoot, "consumer-cli");
    fs.writeFileSync(payloadPath, payload);
    const request = createArtifactSigningRequest({
      source: {
        repository: "kungfu-systems/consumer",
        sha: "1".repeat(40),
        treeSha: "2".repeat(40),
      },
      runtime: { sha: "3".repeat(40) },
      artifact: {
        id: "cli",
        path: "dist/consumer-cli",
        kind: "binary",
        platform: "linux",
        bytes: payload.length,
        digest: digest(payload),
        transport: {
          file: "cli/consumer-cli",
          format: "exact-file",
          bytes: payload.length,
          digest: digest(payload),
        },
      },
    });
    fs.writeFileSync(
      path.join(requestRoot, "request.json"),
      JSON.stringify(request),
    );
    fs.writeFileSync(
      path.join(inputRoot, "index.json"),
      JSON.stringify({
        contract: "kungfu-buildchain-artifact-signing-request-index/v1",
        requests: [
          { id: "cli", digest: request.digest, path: "cli/request.json" },
        ],
      }),
    );
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const outputRoot = path.join(root, "output");
    const result = signDetachedArtifactRequests({
      inputRoot,
      outputRoot,
      privateKeyBase64: privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      keyId: "buildchain-test-v1",
    });
    assert.equal(result.results.length, 1);
    const envelope = JSON.parse(
      fs.readFileSync(
        path.join(outputRoot, result.results[0].envelope),
        "utf8",
      ),
    );
    assert.equal(
      verifyDetachedArtifactSignature({ request, envelope, publicKey }).ok,
      true,
    );
    const verification = verifyArtifactSigningResults({
      requestRoot: inputRoot,
      resultRoot: outputRoot,
    });
    assert.equal(verification.ok, true);
    const copiedPayload = path.join(outputRoot, result.results[0].payload);
    assert.deepEqual(fs.readFileSync(copiedPayload), payload);
    fs.appendFileSync(copiedPayload, "result-tamper");
    assert.throws(
      () =>
        verifyArtifactSigningResults({
          requestRoot: inputRoot,
          resultRoot: outputRoot,
        }),
      /result payload byte count mismatch|result payload digest mismatch/,
    );

    fs.appendFileSync(payloadPath, "tamper");
    assert.throws(
      () =>
        signDetachedArtifactRequests({
          inputRoot,
          outputRoot: path.join(root, "tampered-output"),
          privateKeyBase64: privateKey
            .export({ format: "der", type: "pkcs8" })
            .toString("base64"),
          keyId: "buildchain-test-v1",
        }),
      /does not match the sealed request/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

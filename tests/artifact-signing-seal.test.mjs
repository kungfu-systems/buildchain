import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sealArtifactSigningRequests } from "../scripts/seal-artifact-signing-requests.mjs";

const SOURCE_SHA = "1".repeat(40);
const TREE_SHA = "2".repeat(40);
const RUNTIME_SHA = "3".repeat(40);

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

test("declared binary artifacts become sealed generic authority requests", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-signing-seal-"),
  );
  try {
    const project = path.join(workspace, "consumer");
    const artifact = path.join(project, "dist", "consumer-cli");
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, "portable-binary\n");
    fs.writeFileSync(
      path.join(project, "buildchain.toml"),
      `schema = 1

[[signing.artifacts]]
id = "consumer-cli"
path = "dist/consumer-cli"
profile = "auto"
kind = "binary"
`,
    );
    const manifestPath = path.join(workspace, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        contract: "kungfu-buildchain-artifact",
        platform: { id: "linux-x64", os: "linux", arch: "x64" },
        files: [
          {
            path: "consumer/dist/consumer-cli",
            size: fs.statSync(artifact).size,
            sha256: sha256(artifact),
          },
        ],
      })}\n`,
    );
    const outputRoot = path.join(
      workspace,
      ".buildchain",
      "signing",
      "linux-x64",
    );
    const index = sealArtifactSigningRequests({
      workspace,
      cwd: "consumer",
      manifestPath: "manifest.json",
      outputRoot,
      repository: "kungfu-systems/consumer",
      sourceSha: SOURCE_SHA,
      sourceTreeSha: TREE_SHA,
      runtimeSha: RUNTIME_SHA,
      platformId: "linux-x64",
    });
    assert.equal(index.requests.length, 1);
    const request = JSON.parse(
      fs.readFileSync(path.join(outputRoot, index.requests[0].path), "utf8"),
    );
    assert.equal(request.artifact.kind, "binary");
    assert.equal(request.signature.profile, "detached-signature-v1");
    assert.equal(
      request.signature.semantics,
      "detached-cryptographic-signature",
    );
    assert.equal(request.artifact.transport.format, "exact-file");
    assert.equal(
      fs.readFileSync(
        path.join(outputRoot, request.artifact.transport.file),
        "utf8",
      ),
      "portable-binary\n",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("signing request sealing fails when lifecycle evidence is stale", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-signing-stale-"),
  );
  try {
    const artifact = path.join(workspace, "dist", "consumer-cli");
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, "current\n");
    fs.writeFileSync(
      path.join(workspace, "buildchain.toml"),
      `schema = 1

[[signing.artifacts]]
path = "dist/consumer-cli"
`,
    );
    fs.writeFileSync(
      path.join(workspace, "manifest.json"),
      `${JSON.stringify({
        platform: { id: "linux-x64", os: "linux" },
        files: [
          {
            path: "dist/consumer-cli",
            size: fs.statSync(artifact).size,
            sha256: "0".repeat(64),
          },
        ],
      })}\n`,
    );
    assert.throws(
      () =>
        sealArtifactSigningRequests({
          workspace,
          manifestPath: "manifest.json",
          outputRoot: ".buildchain/signing/linux-x64",
          repository: "kungfu-systems/consumer",
          sourceSha: SOURCE_SHA,
          sourceTreeSha: TREE_SHA,
          runtimeSha: RUNTIME_SHA,
          platformId: "linux-x64",
        }),
      /does not match lifecycle manifest/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

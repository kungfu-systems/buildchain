import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createArtifactSigningRequest } from "../packages/core/artifact-signing.js";
import { finalizeNativeArtifactSigningResult } from "../scripts/finalize-native-artifact-signing-result.mjs";
import { inspectArtifactSigningRequests } from "../scripts/inspect-artifact-signing-requests.mjs";
import { importArtifactSigningResults } from "../scripts/import-artifact-signing-results.mjs";
import { materializeArtifactSigningRequest } from "../scripts/materialize-artifact-signing-request.mjs";
import { verifyArtifactSigningResults } from "../scripts/verify-artifact-signing-results.mjs";

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function fixture({ platform = "windows", kind = "pe" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-native-signing-"));
  const input = path.join(root, "input");
  const item = path.join(input, "agent");
  fs.mkdirSync(item, { recursive: true });
  const payload = Buffer.from("unsigned-native-binary\n");
  fs.writeFileSync(path.join(item, "agent.exe"), payload);
  const request = createArtifactSigningRequest({
    source: { repository: "kungfu-systems/agent-hub-demo", sha: "1".repeat(40), treeSha: "2".repeat(40) },
    runtime: { sha: "3".repeat(40) },
    artifact: {
      id: "agent-hub-demo",
      path: "dist/agent.exe",
      platform,
      kind,
      bytes: payload.length,
      digest: digest(payload),
      transport: { file: "agent/agent.exe", format: "exact-file", bytes: payload.length, digest: digest(payload) },
    },
  });
  fs.writeFileSync(path.join(item, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
  fs.writeFileSync(path.join(input, "index.json"), `${JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-signing-request-index/v1",
    requests: [{ id: request.artifact.id, digest: request.digest, path: "agent/request.json", required: true }],
  }, null, 2)}\n`);
  return { root, input, request, payload };
}

test("native authority materializes only the sealed PE and binds final signed bytes", () => {
  const value = fixture();
  try {
    const work = path.join(value.root, "work", "signed.exe");
    materializeArtifactSigningRequest({
      requestRoot: value.input,
      requestPath: "agent/request.json",
      expectedProfile: "windows-authenticode",
      outputPath: work,
    });
    assert.deepEqual(fs.readFileSync(work), value.payload);
    fs.appendFileSync(work, "authenticode-signature");
    const evidencePath = path.join(value.root, "work", "evidence.json");
    fs.writeFileSync(evidencePath, `${JSON.stringify({
      contract: "kungfu-buildchain-windows-authenticode-evidence/v1",
      status: "passed",
      provider: "microsoft-authenticode",
      checks: ["signtool-policy", "rfc3161-timestamp"],
    })}\n`);
    const output = path.join(value.root, "output");
    const index = finalizeNativeArtifactSigningResult({
      requestRoot: value.input,
      requestPath: "agent/request.json",
      signedPayload: work,
      evidencePath,
      outputRoot: output,
      checks: "signtool-policy,rfc3161-timestamp,publisher-fingerprint",
    });
    assert.equal(index.results.length, 1);
    assert.equal(verifyArtifactSigningResults({ requestRoot: value.input, resultRoot: output }).ok, true);
    const consumer = path.join(value.root, "consumer");
    fs.mkdirSync(path.join(consumer, "dist"), { recursive: true });
    fs.writeFileSync(path.join(consumer, "dist", "agent.exe"), value.payload);
    const imported = importArtifactSigningResults({
      workspace: consumer,
      cwd: ".",
      requestRoot: value.input,
      resultRoot: output,
      evidenceRoot: ".buildchain/artifacts/signing/windows-x64",
    });
    assert.equal(imported.imported.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(consumer, "dist", "agent.exe")), fs.readFileSync(work));
    fs.appendFileSync(path.join(output, index.results[0].payload), "tamper");
    assert.throws(
      () => verifyArtifactSigningResults({ requestRoot: value.input, resultRoot: output }),
      /result payload byte count mismatch|result payload digest mismatch/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("authority intake routes native profiles without accepting source substitution", () => {
  const value = fixture();
  try {
    const matrices = inspectArtifactSigningRequests({
      inputRoot: value.input,
      expectedRepository: "kungfu-systems/agent-hub-demo",
      expectedRuntimeSha: "3".repeat(40),
    });
    assert.equal(matrices.windows.length, 1);
    assert.equal(matrices.macos.length, 0);
    assert.equal(matrices.detached.length, 0);
    assert.throws(
      () => inspectArtifactSigningRequests({ inputRoot: value.input, expectedRepository: "other/repository" }),
      /source repository mismatch/,
    );
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("Buildchain authority owns native credentials and performs provider verification", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/artifact-signing-authority.yml"), "utf8");
  const macos = fs.readFileSync(path.join(root, "scripts/sign-macos-mach-o-request.sh"), "utf8");
  const windows = fs.readFileSync(path.join(root, "scripts/sign-windows-authenticode-request.ps1"), "utf8");
  assert.match(workflow, /environment: buildchain-artifact-signing/);
  assert.match(workflow, /secrets\.BUILDCHAIN_MACOS_CERTIFICATE_P12_BASE64/);
  assert.match(workflow, /secrets\.BUILDCHAIN_MACOS_NOTARY_API_KEY_P8_BASE64/);
  assert.match(workflow, /vars\.BUILDCHAIN_MACOS_EXPECTED_TEAM_ID/);
  assert.doesNotMatch(workflow, /secrets\.BUILDCHAIN_APPLE_/);
  assert.match(workflow, /secrets\.BUILDCHAIN_WINDOWS_CERTIFICATE_PFX_BASE64/);
  assert.match(macos, /-T \/usr\/bin\/codesign -T \/usr\/bin\/security/);
  assert.match(macos, /set-key-partition-list -S apple-tool:,apple:,codesign:/);
  assert.doesNotMatch(macos, /set-key-partition-list[^\n]+ -s /);
  assert.match(macos, /list-keychains -d user -s "\$\{keychain_path\}"/);
  assert.match(macos, /Buildchain macOS authority: sign exact Mach-O payload/);
  assert.match(macos, /codesign --verify --strict/);
  assert.match(macos, /notarytool submit/);
  assert.match(macos, /spctl --assess --type execute/);
  assert.match(macos, /standalone Mach-O executables do not support stapled/);
  assert.match(windows, /signtool verify \/pa \/all \/v/);
  assert.match(windows, /TimeStamperCertificate/);
  assert.match(windows, /SignatureStatus\]::Valid/);
});

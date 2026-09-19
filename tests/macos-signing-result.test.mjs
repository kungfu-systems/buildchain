import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeNativeArtifactSigningResult } from "../packages/core/build/signing/native-result.js";
import { importArtifactSigningResults } from "../packages/core/build/signing/import-results.js";
import { verifyArtifactSigningResults } from "../packages/core/build/signing/verify-results.js";
import { appSigningFixture } from "./helpers/macos-signing-fixture.mjs";

test("native authority binds and projects a notarized app release payload", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-native-app-signing-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { input, zip, dmg, evidencePath, credential } = appSigningFixture(root);
  const output = path.join(root, "output");
  finalizeNativeArtifactSigningResult({
    requestRoot: input,
    requestPath: "app/request.json",
    signedPayload: zip,
    evidencePath,
    credentialArtifactRoot: credential,
    outputRoot: output,
    expectedRunId: "1000",
    expectedRunAttempt: "2",
  });
  assert.equal(
    verifyArtifactSigningResults({ requestRoot: input, resultRoot: output }).ok,
    true,
  );
  const acceptedEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const mutations = [
    (doc) => {
      doc.app.bundleId = "io.other.app";
    },
    (doc) => {
      doc.buildchain.runtimeSha = "9".repeat(40);
    },
    (doc) => {
      doc.dmgAssembly.binding.runtimeSha = "9".repeat(40);
    },
    (doc) => {
      doc.input.archiveSha256 = `sha256:${"9".repeat(64)}`;
    },
    (doc) => {
      doc.input.archiveBytes += 1;
    },
    ...Object.keys(acceptedEvidence.verification).map((key) => (doc) => {
      doc.verification[key] = false;
    }),
    (doc) => {
      doc.artifacts[1].sha256 = `sha256:${"9".repeat(64)}`;
    },
    (doc) => {
      doc.artifacts.pop();
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const invalid = structuredClone(acceptedEvidence);
    mutate(invalid);
    fs.writeFileSync(evidencePath, JSON.stringify(invalid));
    assert.throws(
      () =>
        finalizeNativeArtifactSigningResult({
          requestRoot: input,
          requestPath: "app/request.json",
          signedPayload: zip,
          evidencePath,
          credentialArtifactRoot: credential,
          outputRoot: path.join(root, `invalid-evidence-${index}`),
          expectedRunId: "1000",
          expectedRunAttempt: "2",
        }),
      /does not prove|final bytes|both final ZIP/u,
      `must reject mismatched credential evidence ${index}`,
    );
  }
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(acceptedEvidence, null, 2)}\n`,
  );
  const substituted = path.join(root, "substituted", path.basename(zip));
  fs.mkdirSync(path.dirname(substituted));
  fs.writeFileSync(substituted, "different bytes with the same filename");
  assert.throws(
    () =>
      finalizeNativeArtifactSigningResult({
        requestRoot: input,
        requestPath: "app/request.json",
        signedPayload: substituted,
        evidencePath,
        credentialArtifactRoot: credential,
        outputRoot: path.join(root, "substituted-output"),
        expectedRunId: "1000",
        expectedRunAttempt: "2",
      }),
    /signed payload does not match/u,
  );
  assert.throws(
    () =>
      finalizeNativeArtifactSigningResult({
        requestRoot: input,
        requestPath: "app/request.json",
        signedPayload: zip,
        evidencePath,
        credentialArtifactRoot: credential,
        outputRoot: path.join(root, "cross-run-output"),
        expectedRunId: "1001",
        expectedRunAttempt: "2",
      }),
    /does not prove the requested native signature/u,
  );

  const consumer = path.join(root, "consumer");
  fs.mkdirSync(path.join(consumer, "product", "release"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(consumer, "product", "release", "existing.txt"),
    "existing",
  );
  const imported = importArtifactSigningResults({
    workspace: consumer,
    requestRoot: input,
    resultRoot: output,
    evidenceRoot: ".buildchain/artifacts/signing/macos-arm64",
  });
  assert.equal(imported.credentialArtifacts.length, 1);
  assert.equal(
    fs.readFileSync(
      path.join(consumer, "product", "release", path.basename(dmg)),
      "utf8",
    ),
    "signed-stapled-dmg",
  );
  fs.appendFileSync(
    path.join(
      output,
      "credential-artifact",
      "product",
      "release",
      path.basename(dmg),
    ),
    "tamper",
  );
  assert.throws(
    () =>
      verifyArtifactSigningResults({
        requestRoot: input,
        resultRoot: output,
      }),
    /result evidence digest mismatch/,
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertArtifactSigningDelegationContext,
  artifactSigningDelegationOutputs,
  createArtifactSigningDelegation,
  readArtifactSigningDelegation,
  sealArtifactSigningDelegation,
  validateArtifactSigningDelegation,
} from "../scripts/artifact-signing-delegation.mjs";

const sha = "a".repeat(40);
const treeSha = "b".repeat(40);

function values(overrides = {}) {
  return {
    sourceRepository: "kungfu-systems/consumer",
    sourceRunId: "123",
    sourceRunAttempt: "2",
    sourceSha: sha,
    sourceTreeSha: treeSha,
    runtimeRepository: "kungfu-systems/buildchain",
    runtimeSha: sha,
    platformId: "macos-arm64",
    platformName: "macOS ARM64",
    requestCount: "1",
    requestArtifact: `consumer-signing-request-macos-arm64-${sha}`,
    authorityRunId: "456",
    authorityRuntimeSha: "c".repeat(40),
    resultArtifact: `consumer-signing-result-macos-arm64-${sha}-123-2`,
    artifactName: `consumer-macos-arm64-${sha}`,
    manifestArtifact: `consumer-manifest-macos-arm64-${sha}`,
    diagnosticsArtifact: `consumer-diagnostics-macos-arm64-${sha}`,
    workingDirectory: ".",
    ...overrides,
  };
}

test("seals and parses a credential-free hosted signing delegation", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-signing-delegation-"),
  );
  const outputPath = path.join(root, "delegation.json");
  const sealed = sealArtifactSigningDelegation({ outputPath, ...values() });
  assert.deepEqual(readArtifactSigningDelegation(outputPath), sealed);
  assert.deepEqual(artifactSigningDelegationOutputs(sealed), {
    "request-count": "1",
    "request-artifact": `consumer-signing-request-macos-arm64-${sha}`,
    "authority-run-id": "456",
    "authority-runtime-sha": "c".repeat(40),
    "result-artifact": `consumer-signing-result-macos-arm64-${sha}-123-2`,
    "artifact-name": `consumer-macos-arm64-${sha}`,
    "manifest-artifact-name": `consumer-manifest-macos-arm64-${sha}`,
    "diagnostics-artifact-name": `consumer-diagnostics-macos-arm64-${sha}`,
    "working-directory": ".",
  });
});

test("unsigned platforms produce a no-op delegation without authority coordinates", () => {
  const delegation = createArtifactSigningDelegation(
    values({
      requestCount: "0",
      requestArtifact: "",
      authorityRunId: "",
      authorityRuntimeSha: "",
      resultArtifact: "",
    }),
  );
  assert.equal(delegation.request.count, 0);
  assert.equal(delegation.authority.runId, "");
});

test("signed delegations fail closed without immutable result coordinates", () => {
  assert.throws(
    () => createArtifactSigningDelegation(values({ authorityRunId: "" })),
    /authority\.runId is required/u,
  );
  assert.throws(
    () =>
      validateArtifactSigningDelegation({
        ...createArtifactSigningDelegation(
          values({
            requestCount: "0",
            requestArtifact: "",
            authorityRunId: "",
            authorityRuntimeSha: "",
            resultArtifact: "",
          }),
        ),
        workingDirectory: "../escape",
      }),
    /safe relative path/u,
  );
  assert.throws(
    () =>
      createArtifactSigningDelegation(
        values({ workingDirectory: 'dist/"; touch escaped; #' }),
      ),
    /unsafe shell characters/u,
  );
});

test("hosted finalization binds the delegation to the current run", () => {
  const delegation = createArtifactSigningDelegation(values());
  assert.deepEqual(
    assertArtifactSigningDelegationContext(delegation, {
      sourceRepository: "kungfu-systems/consumer",
      sourceRunId: "123",
      sourceRunAttempt: "2",
      sourceSha: sha,
      runtimeRepository: "kungfu-systems/buildchain",
      runtimeSha: sha,
      platformId: "macos-arm64",
    }),
    delegation,
  );
  assert.throws(
    () =>
      assertArtifactSigningDelegationContext(delegation, {
        sourceRunId: "999",
      }),
    /source run ID mismatch/u,
  );
});

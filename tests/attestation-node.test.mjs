import test from "node:test";
import assert from "node:assert/strict";
import { validateAttestationInput } from "../packages/core/build/github-attestation/admission.js";

test("attestation admission binds workflow, runtime, caller run and source before signing", () => {
  const env = {
    runtimeSha: "a".repeat(40),
    definitionSha: "a".repeat(40),
    evidenceRunId: "123",
    currentRunId: "123",
    sourceSha: "b".repeat(40),
    currentSourceSha: "b".repeat(40),
    subjectRelativePath: "linux/app.tar.gz",
    platformManifestRelativePath: "platform.json",
    releasePassportRelativePath: "buildchain.release.json",
  };
  validateAttestationInput({ ...env, definitionSha: "c".repeat(40) });
  for (const change of [
    { evidenceRunId: "456" },
    { sourceSha: "a".repeat(40) },
  ])
    assert.throws(() => validateAttestationInput({ ...env, ...change }));
  for (const path of [
    "../escape",
    "linux/../../escape",
    "/absolute",
    "..\\escape",
    "path\0suffix",
    "",
  ])
    assert.throws(
      () => validateAttestationInput({ ...env, subjectRelativePath: path }),
      /safe relative paths/u,
    );
});

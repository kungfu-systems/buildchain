import test from "node:test";
import assert from "node:assert/strict";
import { validateAttestationInput } from "../packages/core/release/nodes/artifact-attestation.mjs";

test("attestation admission binds workflow, runtime, caller run and source before signing", () => {
  const env = {
    BUILDCHAIN_REF: "a".repeat(40),
    DEFINITION_SHA: "a".repeat(40),
    EVIDENCE_RUN_ID: "123",
    CURRENT_RUN_ID: "123",
    SOURCE_SHA: "b".repeat(40),
    CURRENT_SOURCE_SHA: "b".repeat(40),
    SUBJECT_RELATIVE_PATH: "linux/app.tar.gz",
    PLATFORM_MANIFEST_RELATIVE_PATH: "platform.json",
    RELEASE_PASSPORT_RELATIVE_PATH: "buildchain.release.json",
  };
  validateAttestationInput(env);
  for (const change of [
    { BUILDCHAIN_REF: "v4-alpha" },
    { DEFINITION_SHA: "c".repeat(40) },
    { EVIDENCE_RUN_ID: "456" },
    { SOURCE_SHA: "a".repeat(40) },
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
      () => validateAttestationInput({ ...env, SUBJECT_RELATIVE_PATH: path }),
      /safe relative paths/u,
    );
});

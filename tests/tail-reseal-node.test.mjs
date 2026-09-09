import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import YAML from "yaml";
import {
  validatePolicyBindings,
  verifyReadbacks,
  publicationLine,
} from "../packages/core/release/nodes/tail-reseal.mjs";
const sha = "d".repeat(40),
  runtime = "e".repeat(40),
  root = `sha256:${"f".repeat(64)}`;
function bindings() {
  return {
    request: {
      repository: "example/consumer",
      source: { sha },
      runtime: { sha: runtime },
    },
    receipt: { id: "policy" },
    env: {
      BUILDCHAIN_SOURCE_SHA: sha,
      BUILDCHAIN_RUNTIME_SHA: runtime,
      BUILDCHAIN_POLICY_ROOT: root,
    },
  };
}
test("tail policy admission binds source, runtime and the existing rooted consumer receipt", () => {
  let observed;
  validatePolicyBindings({
    ...bindings(),
    verify: (value) => {
      observed = value;
      return { ok: true };
    },
  });
  assert.equal(observed.receiptRoot, root);
  assert.equal(observed.repository, "example/consumer");
  assert.equal(observed.sourceSha, sha);
  assert.equal(observed.resolvedRuntimeSha, runtime);
  for (const key of ["BUILDCHAIN_SOURCE_SHA", "BUILDCHAIN_RUNTIME_SHA"]) {
    const input = bindings();
    input.env[key] = "a".repeat(40);
    assert.throws(
      () =>
        validatePolicyBindings({
          ...input,
          verify: () => {
            throw Error("must not verify drifted coordinates");
          },
        }),
      /differs/,
    );
  }
  assert.throws(
    () =>
      validatePolicyBindings({
        ...bindings(),
        verify: () => ({ ok: false, failures: [{ code: "root-mismatch" }] }),
      }),
    /root-mismatch/,
  );
});
test("both independent provider readbacks must match their exact byte roots", () => {
  const digest = (value) =>
    `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
  const env = {
    EXPECTED_SIGNING_ROOT: digest("signing"),
    EXPECTED_RELEASE_TAIL_ROOT: digest("tail"),
  };
  const read = (name) =>
    name.endsWith("signing-provider-readback.json") ? "signing" : "tail";
  assert.doesNotThrow(() => verifyReadbacks(env, read));
  for (const key of Object.keys(env))
    assert.throws(
      () => verifyReadbacks({ ...env, [key]: digest("tampered") }, read),
      /root mismatch/,
    );
});
test("tail publication line derives from the exact version and rejects unsealed selectors", () => {
  assert.equal(publicationLine("4.1.0-alpha.0"), "alpha/v4/v4.1");
  assert.equal(publicationLine("5.2.3-alpha.4"), "alpha/v5/v5.2");
  for (const value of ["4.1.0", "v4-alpha", "4.1.0-beta.1", ""])
    assert.throws(() => publicationLine(value), /exact alpha/);
});
test("tail signing token remains exclusive to the macOS effect and follows retained-byte validation", () => {
  const read = (name) =>
    YAML.parse(
      fs.readFileSync(
        new URL(
          `../actions/release/tail-reseal-${name}/action.yml`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const steps = read("platforms").runs.steps;
  const effect = steps.find(
    (s) => s.name === "Execute fenced macOS signing-finalization tail",
  );
  assert.equal(
    effect.if,
    "fromJSON(inputs.matrix-json).platform.id == 'macos-arm64'",
  );
  assert.equal(steps.filter((s) => s.env?.BUILDCHAIN_SIGNING_TOKEN).length, 1);
  assert.ok(
    steps.findIndex(
      (s) => s.name === "Verify exact retained bytes before any effect",
    ) < steps.indexOf(effect),
  );
  assert.match(
    steps.find(
      (s) => s.name === "Verify independent signing and release-tail readbacks",
    ).run,
    /tail-reseal.mjs" readbacks/,
  );
  for (const phase of ["plan", "seal"])
    assert.doesNotMatch(
      JSON.stringify(read(phase)),
      /BUILDCHAIN_SIGNING_TOKEN/,
    );
});

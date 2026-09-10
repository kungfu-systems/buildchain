import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

test("tail-reseal parity matrix roots the captured v3 authority and complete v4 projection", () => {
  const matrix = JSON.parse(read("architecture/tail-reseal-parity.json"));
  const expectedRoot = matrix.matrixRoot;
  delete matrix.matrixRoot;
  assert.equal(
    expectedRoot,
    `sha256:${crypto
      .createHash("sha256")
      .update(JSON.stringify(matrix))
      .digest("hex")}`,
  );
  assert.equal(
    matrix.sourceAuthority.capturedCommit,
    "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  );
  assert.equal(matrix.authority.productionAuthority, "v4");
  assert.equal(matrix.authority.stageCapsuleEffectAuthority, "none");
  assert.equal(matrix.authority.v3BehaviorChange, false);
  assert.deepEqual(
    matrix.invariants.map(({ id }) => id),
    Array.from(
      { length: 12 },
      (_, index) => `TR-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  assert.equal(
    matrix.invariants.filter(
      ({ disposition }) => disposition === "missing-before-closeout",
    ).length,
    1,
  );
});

test("public tail workflow delegates to scoped nodes and keeps effects outside Capsule reuse", () => {
  const workflow = read(".github/workflows/public-ops-tail-reseal.yml");
  const nodes = ["plan", "platforms", "seal"]
    .map((phase) => read(`actions/release/reseal/${phase}/action.yml`))
    .join("\n");
  const implementation = read("packages/core/release/reseal/readbacks.js");
  assert.match(workflow, /workflow_call:/u);
  assert.match(workflow, /workflow-sha: \$\{\{ job\.workflow_sha \}\}/u);
  for (const phase of ["plan", "platforms", "seal"])
    assert.ok(workflow.includes(`actions/release/reseal/${phase}`));
  for (const action of ["admit", "finalize-platform", "close"])
    assert.ok(nodes.includes(`/actions/release/reseal/${action}`));
  const finalization = read(
    "packages/core/release/reseal/finalize-platform.js",
  );
  assert.match(
    finalization,
    /mode: "retained"[\s\S]*verifyResealProviderReadbacks\([\s\S]*mode: "resealed"/,
  );
  assert.match(
    finalization,
    /platformId === "macos-arm64"[\s\S]*hostPlatform !== "darwin"/,
  );
  assert.match(
    read("packages/core/release/reseal/seal.js"),
    /writeReleaseCandidatePassport\(/,
  );
  assert.match(
    read("packages/core/release/reseal/admission.js"),
    /consumerPolicyReceiptRoot/,
  );
  for (const required of [
    "signing-provider-readback.json",
    "release-tail-provider-readback.json",
  ])
    assert.ok(implementation.includes(required), required);
  for (const forbidden of [
    "vars.",
    "secrets: inherit",
    "lifecycle run install",
    "lifecycle run build",
    "lifecycle run verify",
  ])
    assert.ok(!`${workflow}\n${nodes}`.includes(forbidden), forbidden);
  assert.equal(
    nodes
      .split("\n")
      .filter((line) =>
        line.includes("signing-token: ${{ inputs.signing-token }}"),
      ).length,
    1,
  );
});

test("CLI, Node exports, schema, docs, and protected macOS rehearsal expose one contract", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.exports["./v4-tail-reseal"], undefined);
  assert.equal(packageJson.exports["./v4-tail-reseal-receipt"], undefined);
  assert.equal(
    packageJson.exports["./tail-reseal"],
    "./packages/core/release/tail-reseal.js",
  );
  assert.equal(
    packageJson.exports["./tail-reseal-receipt"],
    "./packages/core/release/tail-reseal-receipt.js",
  );
  assert.match(
    read("packages/core/contracts/command-registry.mjs"),
    /id: "tail-reseal"/u,
  );
  assert.match(
    read("packages/core/workflow/commands/buildchain-cli-help.mjs"),
    /buildchain tail-reseal plan/u,
  );
  assert.equal(
    JSON.parse(read("contracts/v4-tail-reseal-v1.schema.json")).properties
      .schema.const,
    "kungfu-buildchain-v4-tail-reseal-request/v1",
  );
  assert.match(read("docs/MAP.md"), /v4-tail-reseal\.md/u);
  const verify = read(
    "actions/build/stage-capsule/verify-checkpoints/action.yml",
  );
  assert.match(
    verify,
    /platform: \$\{\{ fromJSON\(inputs.matrix-json\).platform \}\}/u,
  );
  assert.match(verify, /actions\/build\/stage-capsule\/rehearse/u);
  assert.match(
    read("packages/core/build/stage-capsule/rehearsal/verify.js"),
    /platform === "macos-arm64"\s*\? rehearseTailResealMacos\(/u,
  );
});

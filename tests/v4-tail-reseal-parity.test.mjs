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
  const matrix = JSON.parse(read("architecture/v4-tail-reseal-parity.json"));
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

test("public v4 tail workflow keeps floating selectors durable and effects outside Capsule reuse", () => {
  const workflow = read(".github/workflows/v4-tail-reseal.yml");
  for (const required of [
    "workflow_call:",
    "BUILDCHAIN_WORKFLOW_SHA: ${{ job.workflow_sha }}",
    "tail-reseal admit",
    "tail-reseal verify-platform",
    "--mode retained",
    "--mode resealed",
    "Generate standard v4 candidate Release Passport",
    "BUILDCHAIN_V4_POLICY_RECEIPT_JSON:",
    "signing-provider-readback.json",
    "release-tail-provider-readback.json",
  ])
    assert.match(
      workflow,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );
  for (const forbidden of [
    "vars.",
    "secrets: inherit",
    "lifecycle run install",
    "lifecycle run build",
    "lifecycle run verify",
  ])
    assert.doesNotMatch(
      workflow,
      new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );
  assert.doesNotMatch(
    workflow,
    /uses: \.\/(?!\.github\/workflows\/bootstrap\.yml(?:\s|$))/u,
  );
  const signingTokenUses = workflow
    .split("\n")
    .filter((line) => line.includes("BUILDCHAIN_SIGNING_TOKEN"));
  assert.deepEqual(signingTokenUses, [
    "      BUILDCHAIN_SIGNING_TOKEN:",
    "          BUILDCHAIN_SIGNING_TOKEN: ${{ secrets.BUILDCHAIN_SIGNING_TOKEN }}",
  ]);
});

test("CLI, Node exports, schema, docs, and protected macOS rehearsal expose one contract", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(
    packageJson.exports["./v4-tail-reseal"],
    "./packages/core/v4-tail-reseal.js",
  );
  assert.equal(
    packageJson.exports["./v4-tail-reseal-receipt"],
    "./packages/core/v4-tail-reseal-receipt.js",
  );
  assert.match(read("bin/internal/command-registry.mjs"), /id: "tail-reseal"/u);
  assert.match(
    read("scripts/buildchain-cli-help.mjs"),
    /buildchain tail-reseal plan/u,
  );
  assert.equal(
    JSON.parse(read("contracts/v4-tail-reseal-v1.schema.json")).properties
      .schema.const,
    "kungfu-buildchain-v4-tail-reseal-request/v1",
  );
  assert.match(read("docs/MAP.md"), /v4-tail-reseal\.md/u);
  const verify = read(".github/workflows/verify.yml");
  assert.match(verify, /if: matrix\.platform == 'macos-arm64'/u);
  assert.match(verify, /scripts\/v4-tail-reseal-macos-rehearsal\.mjs/u);
});

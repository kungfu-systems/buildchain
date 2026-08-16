import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { nextDevelopmentRoot } from "../packages/core/next-development-transition.js";
import { checkV4PublicDogfoodContract } from "../scripts/check-v4-public-dogfood-contract.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const matrix = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "architecture/v4-next-development-parity.json"),
    "utf8",
  ),
);

test("rooted v4 next-development matrix maps every declared invariant", () => {
  const body = structuredClone(matrix);
  delete body.matrixRoot;
  assert.equal(matrix.matrixRoot, nextDevelopmentRoot(body));
  assert.equal(matrix.contract, "kungfu-buildchain-v4-next-development-parity");
  assert.equal(
    matrix.sourceAuthority.capturedCommit,
    "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  );
  assert.equal(matrix.target.branch, "dev/v4/v4.0");
  assert.deepEqual(
    matrix.invariants.map(({ id }) => id),
    Array.from(
      { length: 12 },
      (_, index) => `ND-${String(index + 1).padStart(2, "0")}`,
    ),
  );
  const allowed = new Set(matrix.allowedDispositions);
  for (const invariant of matrix.invariants) {
    assert.ok(allowed.has(invariant.disposition));
    assert.ok(invariant.claim.length > 40);
    if (invariant.disposition !== "missing-before-closeout") {
      assert.ok(invariant.implementationEvidence.length > 0);
      assert.ok(invariant.verificationEvidence.length > 0);
      for (const relative of [
        ...invariant.implementationEvidence,
        ...invariant.verificationEvidence,
      ]) {
        assert.ok(fs.existsSync(path.join(repositoryRoot, relative)), relative);
      }
    }
  }
});

test("public self-dogfood remains the exact thin reusable consumer path", () => {
  const result = checkV4PublicDogfoodContract(repositoryRoot);
  assert.equal(result.ok, true);
  assert.equal(
    result.caller,
    ".github/workflows/v4-public-consumer-dogfood.yml",
  );
  assert.equal(result.validationRef, "v4-alpha");
  for (const workflow of [
    ".github/workflows/v4-public-consumer-dogfood.yml",
    ".github/workflows/buildchain-alpha-self-dogfood.yml",
  ]) {
    const source = fs.readFileSync(path.join(repositoryRoot, workflow), "utf8");
    assert.doesNotMatch(source, /next-development-self-dogfood/u);
  }
});

test("external closeout cannot be inferred from local green tests", () => {
  const missing = matrix.invariants.filter(
    ({ disposition }) => disposition === "missing-before-closeout",
  );
  assert.deepEqual(
    missing.map(({ id }) => id),
    ["ND-12"],
  );
  assert.match(missing[0].claim, /Independent review/u);
  assert.match(missing[0].claim, /protected merge/u);
  assert.match(missing[0].claim, /post-merge containment/u);
});

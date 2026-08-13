// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const parity = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture", "v4-release-train-parity.json"),
    "utf8",
  ),
);

test("v4 Release Train parity binds every normative v3 vector", () => {
  assert.equal(parity.contract, "kungfu-buildchain-v4-release-train-parity");
  assert.equal(parity.sourceAuthority.branch, "dev/v3/v3.0");
  assert.equal(parity.target.branch, "dev/v4/v4.0");
  assert.match(parity.sourceAuthority.familyStateRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(parity.sourceAuthority.portableSealRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(parity.sourceAuthority.commits.length, 4);
  assert.equal(
    parity.normativeVectors.reduce((sum, vector) => sum + vector.count, 0),
    56,
  );
  for (const vector of parity.normativeVectors) {
    const source = fs.readFileSync(path.join(root, vector.path), "utf8");
    assert.equal(
      source.split("\n").filter((line) => line.startsWith("test(")).length,
      vector.count,
      vector.path,
    );
    assert.equal(vector.result, "exact");
  }
  assert.deepEqual(
    parity.adapterDifferences.map((difference) => difference.semanticImpact),
    ["none", "none", "evidence-only"],
  );
});

test("v4 parity fixtures and public patrol use only v4 release coordinates", () => {
  const paths = [
    "tests/release-train.test.mjs",
    "tests/release-blocker-priority.test.mjs",
    "tests/release-train-self-dogfood.test.mjs",
    ".github/workflows/dev-alpha-candidate-patrol.yml",
  ];
  for (const relativePath of paths) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /(?:dev|alpha)\/v3\/v3\.0|v3-alpha/u);
  }
});

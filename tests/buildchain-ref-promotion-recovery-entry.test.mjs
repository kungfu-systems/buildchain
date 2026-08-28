import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const promotion = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-ref-promotion.yml"),
  "utf8",
);
const recovery = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-ref-promotion-recovery.yml"),
  "utf8",
);

test("alpha convergence retains one standalone recovery adapter", () => {
  assert.match(
    promotion,
    /^  promote:[\s\S]*\.release-candidate-promote\.yml@v4-alpha/m,
  );
  assert.doesNotMatch(promotion, /^  recover-stable-candidate:/mu);
  assert.doesNotMatch(promotion, /^  promote-stable:/mu);
  assert.match(recovery, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(recovery, /^  workflow_call:/mu);
  assert.match(
    recovery,
    /publication-publisher-workflow-path: \.github\/workflows\/buildchain-ref-promotion-recovery\.yml/,
  );
});

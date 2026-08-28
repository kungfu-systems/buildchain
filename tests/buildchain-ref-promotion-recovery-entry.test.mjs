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

test("stable recovery preserves the npm-trusted top-level workflow identity", () => {
  assert.match(
    promotion,
    /recover-stable-candidate:[\s\S]*uses: \.\/\.github\/workflows\/buildchain-ref-promotion-recovery\.yml[\s\S]*resume-expected-source-tree:/,
  );
  assert.match(
    promotion,
    /promote-stable:[\s\S]*inputs\['resume-candidate-run-id'\] == ''/,
  );
  assert.match(recovery, /^  workflow_call:/mu);
  assert.doesNotMatch(recovery, /^  workflow_dispatch:/mu);
  assert.match(
    recovery,
    /publication-publisher-workflow-path: \.github\/workflows\/buildchain-ref-promotion\.yml/,
  );
});

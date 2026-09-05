import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const readWorkflow = (name) =>
  fs.readFileSync(path.resolve(".github/workflows", name), "utf8");

const advanced = readWorkflow(".release-candidate-promote.yml");
const publicWorkflow = readWorkflow("release-candidate-promote.yml");
const recovery = readWorkflow("self-ops-promotion-recovery.yml");
const selfPromotion = readWorkflow("self-release-promote.yml");

test("canonical publisher has one QUALIFY APPLY SETTLE execution topology", () => {
  assert.match(advanced, /^  qualify:/m);
  assert.match(advanced, /^  apply:/m);
  assert.match(advanced, /^  settle:/m);
  assert.doesNotMatch(
    advanced,
    /^  (?:publication-authority|qualification-plan|publication-qualification|legacy-promote|v4-declarative-promote|promote):/m,
  );
});

test("public and recovery adapters invoke only the floating alpha publisher", () => {
  for (const workflow of [publicWorkflow, recovery]) {
    assert.match(
      workflow,
      /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.?release-candidate-promote\.yml@v4-alpha/u,
    );
    assert.doesNotMatch(
      workflow,
      /\.release-candidate-promote\.yml@v4(?:\n|$)/u,
    );
  }
  assert.match(publicWorkflow, /^  invoke:/m);
  assert.match(recovery, /^  resume:/m);
});

test("Buildchain self-promotion uses one current-major alpha publisher", () => {
  assert.match(
    selfPromotion,
    /^  promote:[\s\S]*uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@v4-alpha/m,
  );
  assert.doesNotMatch(selfPromotion, /^  promote-(?:alpha|stable):/m);
  assert.doesNotMatch(
    selfPromotion,
    /\.release-candidate-promote\.yml@v4(?:\n|$)/u,
  );
});

test("APPLY retains one rooted transaction and SETTLE reads its receipt", () => {
  const apply = advanced.slice(
    advanced.indexOf("\n  apply:"),
    advanced.indexOf("\n  settle:"),
  );
  const settle = advanced.slice(advanced.indexOf("\n  settle:"));

  assert.match(apply, /release-invocation-root:/);
  assert.match(apply, /release-transaction-root:/);
  assert.match(apply, /release-receipt-root:/);
  assert.match(apply, /Resume the same transaction journal/);
  assert.match(settle, /release-receipt\.json/);
  assert.match(settle, /receipt-root=/);
});

test("only APPLY carries provider mutation permissions", () => {
  const qualify = advanced.slice(
    advanced.indexOf("\n  qualify:"),
    advanced.indexOf("\n  apply:"),
  );
  const apply = advanced.slice(
    advanced.indexOf("\n  apply:"),
    advanced.indexOf("\n  settle:"),
  );
  const settle = advanced.slice(advanced.indexOf("\n  settle:"));

  assert.doesNotMatch(qualify, /contents: write|id-token: write/);
  assert.match(apply, /contents: write/);
  assert.match(apply, /id-token: write/);
  assert.doesNotMatch(settle, /contents: write|id-token: write/);
});

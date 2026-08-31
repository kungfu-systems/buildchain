import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveFreshPublicationVersion } from "../scripts/release-candidate-resolver.mjs";

const promotion = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-ref-promotion.yml"),
  "utf8",
);
const recovery = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-ref-promotion-recovery.yml"),
  "utf8",
);
const publicPromotion = fs.readFileSync(
  path.resolve(".github/workflows/release-candidate-promote.yml"),
  "utf8",
);
const resolver = fs.readFileSync(
  path.resolve("scripts/release-candidate-resolver.mjs"),
  "utf8",
);

function nestedKeys(source, marker) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === marker);
  assert.notEqual(start, -1, `missing ${marker.trim()} block`);
  const indent = marker.match(/^ */u)[0].length;
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^ */u)[0].length <= indent) break;
    const match = line.match(
      new RegExp(`^ {${indent + 2}}([a-z0-9-]+):(?:\\s|$)`, "u"),
    );
    if (match) keys.push(match[1]);
  }
  return keys;
}

function jobBlock(source, jobId) {
  const start = source.indexOf(`  ${jobId}:\n`);
  assert.notEqual(start, -1, `missing ${jobId} job`);
  const tail = source.slice(start + 1);
  const next = tail.search(/^  [a-z0-9-]+:\n/mu);
  return source.slice(start, next === -1 ? source.length : start + 1 + next);
}

test("canonical publisher accepts one closed universal request", () => {
  assert.match(
    promotion,
    /^      universal-request-json:\n        description: "Versioned exact-candidate request envelope/mu,
  );
  const universal = jobBlock(promotion, "universal-bootstrap");
  assert.match(universal, /uses: \.\/\.github\/workflows\/bootstrap\.yml/u);
  assert.match(
    universal,
    /request-json: \$\{\{ inputs\['universal-request-json'\] \}\}/u,
  );
  assert.match(universal, /contents: write/u);
  assert.match(universal, /id-token: write/u);
  assert.doesNotMatch(universal, /release-candidate-promote\.yml@/u);
  for (const jobId of [
    "reject-manual-apply",
    "reject-invalid-durable-recovery",
    "reject-invalid-candidate-recovery",
    "promote",
  ]) {
    assert.match(
      jobBlock(promotion, jobId),
      /inputs\['universal-request-json'\] == ''/u,
      `${jobId} can overlap universal execution`,
    );
  }
});

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

test("stable recovery forwards only inputs declared by the floating publisher", () => {
  const declaredInputs = new Set(nestedKeys(publicPromotion, "    inputs:"));
  const forwardedInputs = nestedKeys(recovery, "    with:");
  assert.deepEqual(
    forwardedInputs.filter((name) => !declaredInputs.has(name)),
    [],
  );
});

test("self-promotion recovery retains the sealed npm payload selector", () => {
  assert.match(promotion, /artifact-patterns: buildchain-package-\*/);
  assert.doesNotMatch(
    promotion,
    /artifact-patterns: \$\{\{ inputs\['resume-candidate-run-id'\] != '' && ''/,
  );
  assert.match(recovery, /artifact-patterns: buildchain-package-\*/);
  assert.match(promotion, /required-artifact-count: 0/);
  assert.match(recovery, /required-artifact-count: 0/);
});

test("protected alpha recovery bootstraps from the current workflow runtime", () => {
  assert.match(
    promotion,
    /buildchain-ref: \$\{\{[^\n]*inputs\['recover-durable-transaction'\] == true && github\.sha \|\| 'v4-alpha' \}\}/,
  );
  assert.match(
    promotion,
    /github\.event_name == 'workflow_dispatch' &&\s*startsWith\(inputs\['target-ref'\], 'alpha\/'\) &&\s*\(inputs\['resume-candidate-run-id'\] != '' \|\| inputs\['recover-durable-transaction'\] == true\) &&\s*inputs\.sha != ''/,
  );
  assert.match(
    promotion,
    /inputs\['recover-durable-transaction'\] == true && inputs\.sha == ''/,
  );
});

test("candidate sealing precedes required-artifact version projection", () => {
  assert.ok(
    resolver.indexOf("const sealedBundle =") <
      resolver.lastIndexOf("resolveFreshPublicationVersion({ sealedBundle"),
  );
});

test("fresh self-publication projects the sealed npm version instead of the fixture candidate version", () => {
  assert.equal(
    resolveFreshPublicationVersion({
      sealedBundle: { manifest: { npm: { version: "4.0.2-alpha.2" } } },
      candidateVersion: "22.22.3-kf.0",
    }),
    "4.0.2-alpha.2",
  );
  assert.equal(
    resolveFreshPublicationVersion({ candidateVersion: "22.22.3-kf.0" }),
    "22.22.3-kf.0",
  );
});

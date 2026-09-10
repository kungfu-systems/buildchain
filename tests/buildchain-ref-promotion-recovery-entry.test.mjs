import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readWorkflow } from "../scripts/workflow-action-graph.mjs";
import { resolveFreshPublicationVersion } from "../packages/core/release/candidate/selection.js";

const promotion = fs.readFileSync(
  path.resolve(".github/workflows/self-release-promote.yml"),
  "utf8",
);
const recovery = fs.readFileSync(
  path.resolve(".github/workflows/self-ops-promotion-recovery.yml"),
  "utf8",
);
const publicPromotion = fs.readFileSync(
  path.resolve(".github/workflows/public-release-promote.yml"),
  "utf8",
);
const resolver = fs.readFileSync(
  path.resolve("packages/core/release/candidate/materialize.js"),
  "utf8",
);
const universalEngine = fs.readFileSync(
  path.resolve("packages/core/workflow/commands/universal-workflow-engine.mjs"),
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

test("self promotion has one publishing API and no overlapping universal dispatch", () => {
  const workflow = readWorkflow(".github/workflows/self-release-promote.yml");
  assert.equal(workflow.on.workflow_dispatch.inputs["universal-request-json"], undefined);
  assert.equal(workflow.jobs["universal-bootstrap"], undefined);
  const publishers = Object.values(workflow.jobs).filter(job => job.uses);
  assert.equal(publishers.length, 1);
  assert.equal(publishers[0].uses, "./.github/workflows/public-release-promote.yml");
  assert.deepEqual(Object.keys(publishers[0].with), ["request-json"]);
});

test("universal inspection preserves request mode for alpha admission", () => {
  assert.match(
    universalEngine,
    /requestRoot: universalWorkflowRequestRoot\(request\),\s+mode: request\.mode,\s+candidate: request\.candidate/u,
  );
});

test("alpha convergence retains one standalone recovery adapter", () => {
  assert.match(
    promotion,
    /^  promote:[\s\S]*uses: \.\/\.github\/workflows\/public-release-promote\.yml/m,
  );
  assert.doesNotMatch(promotion, /^  recover-stable-candidate:/mu);
  assert.doesNotMatch(promotion, /^  promote-stable:/mu);
  assert.match(recovery, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(recovery, /^  workflow_call:/mu);
  assert.match(
    recovery,
    /"publication-publisher-workflow-path": "\.github\/workflows\/self-ops-promotion-recovery\.yml"/,
  );
});

test("stable recovery forwards only the declared public request envelope", () => {
  const declaredInputs = new Set(nestedKeys(publicPromotion, "    inputs:"));
  const forwardedInputs = nestedKeys(recovery, "    with:");
  assert.deepEqual(
    forwardedInputs.filter((name) => !declaredInputs.has(name)),
    [],
  );
});

test("self-promotion recovery retains the sealed npm payload selector", () => {
  assert.match(promotion, /"artifact-patterns": "buildchain-package-\*"/);
  assert.doesNotMatch(
    promotion,
    /artifact-patterns: \$\{\{ inputs\['resume-candidate-run-id'\] != '' && ''/,
  );
  assert.match(recovery, /"artifact-patterns": "buildchain-package-\*"/);
  assert.match(promotion, /"required-artifact-count": 0/);
  assert.match(recovery, /"required-artifact-count": 0/);
});

test("protected alpha recovery bootstraps from the current workflow runtime", () => {
  assert.match(
    promotion,
    /"buildchain-ref": \$\{\{ toJSON\([^\n]*inputs\['recover-durable-transaction'\] == true && github\.sha \|\| ''\) \}\}/,
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
      resolver.lastIndexOf("resolveFreshPublicationVersion({"),
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

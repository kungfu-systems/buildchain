import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readWorkflow } from "../scripts/workflow-action-graph.mjs";
import { resolveFreshPublicationVersion } from "../packages/core/release/candidate/selection.js";

const promotion = fs.readFileSync(
  path.resolve(".github/workflows/buildchain.yml"),
  "utf8",
);
const recovery = fs.readFileSync(
  path.resolve(".github/workflows/buildchain-recover.yml"),
  "utf8",
);
const publicPromotion = fs.readFileSync(
  path.resolve(".github/workflows/public-ops-recover.yml"),
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

test("self normal delivery delegates one public pipeline without a dispatch controller", () => {
  const workflow = readWorkflow(".github/workflows/buildchain.yml");
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.deepEqual(Object.keys(workflow.jobs), ["buildchain"]);
  assert.match(workflow.jobs.buildchain.uses, /^kungfu-systems\/buildchain\/\.github\/workflows\/public-ops-pipeline\.yml@v4(?:-alpha)?$/u);
  assert.equal(workflow.jobs.buildchain.with, undefined);
});

test("universal inspection preserves the consumer capability independently from runtime selection", () => {
  assert.match(universalEngine, /consumer: request.consumer/);
  assert.match(universalEngine, /capability: request.capability/);
  assert.doesNotMatch(universalEngine, /candidate: request.candidate|mode: request.mode/);
});

test("recovery forwards only attempt and the optional runtime to the public declaration", () => {
  const declaredInputs = nestedKeys(publicPromotion, "    inputs:");
  assert.deepEqual(nestedKeys(recovery, "    with:"), declaredInputs);
  const caller = readWorkflow(".github/workflows/buildchain-recover.yml");
  assert.deepEqual(Object.keys(caller.jobs), ["buildchain"]);
  assert.match(caller.jobs.buildchain.uses, /^kungfu-systems\/buildchain\/\.github\/workflows\/public-ops-recover\.yml@v4(?:-alpha)?$/u);
  assert.equal(caller.jobs.buildchain.with.attempt, "${{ inputs.attempt }}");
  assert.equal(caller.jobs.buildchain.with["runtime-ref"], "${{ inputs.runtime-ref }}");
  for (const source of [promotion, recovery]) {
    assert.doesNotMatch(source, /request-json|artifact-patterns|required-artifact-count|resume-candidate|runtime-selection|runs-on:|steps:/u);
  }
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

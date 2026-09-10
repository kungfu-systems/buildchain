import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectWorkflowJob, readWorkflow as parseWorkflow } from "../scripts/workflow-action-graph.mjs";

const readWorkflow = (name) =>
  fs.readFileSync(path.resolve(".github/workflows", name), "utf8");

const advanced = readWorkflow(".release-promote.yml");
const publicWorkflow = readWorkflow("public-release-promote.yml");
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

test("public admission and recovery enter one source-owned publisher", () => {
  const api = parseWorkflow(".github/workflows/public-release-promote.yml");
  assert.equal(api.jobs.invoke.uses, "./.github/workflows/.release-promote.yml");
  assert.equal(api.jobs.invoke.with["request-json"], "${{ needs.consumer-admission.outputs.invocation-json }}");
  const recover = parseWorkflow(".github/workflows/self-ops-promotion-recovery.yml");
  assert.equal(recover.jobs.resume.uses, "./.github/workflows/public-release-promote.yml");
});

test("Buildchain self-promotion uses one public publisher at the defining commit", () => {
  assert.match(
    selfPromotion,
    /^  promote:[\s\S]*uses: \.\/\.github\/workflows\/public-release-promote\.yml/m,
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
  const applyGraph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "apply");
  assert.ok(applyGraph.steps.some(step => step.name === "Resume the same transaction journal"));
  const settleGraph = inspectWorkflowJob(".github/workflows/.release-promote.yml", "settle");
  assert.match(JSON.stringify(settleGraph.steps), /release-receipt\.json/);
  assert.match([...settleGraph.modules.values()].join("\n"), /core.setOutput\("receipt-root", receipt.receiptRoot\)/);
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

  assert.match(qualify, /permissions:\n(?:      [a-z-]+: read\n)*      contents: read/u);
  assert.doesNotMatch(qualify, /contents: write|id-token: write/);
  assert.doesNotMatch(apply, /^    permissions:/mu);
  assert.ok(inspectWorkflowJob(".github/workflows/.release-promote.yml", "apply").actions.has("actions/release/promotion/candidate"));
  assert.match(settle, /permissions:\n(?:      [a-z-]+: read\n)*      contents: read/u);
  assert.doesNotMatch(settle, /contents: write|id-token: write/);
});

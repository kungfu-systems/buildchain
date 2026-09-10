import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { request, policy } from "./universal-workflow-harness.mjs";

const root = path.resolve(import.meta.dirname, "..");
function isolatedRecovery(t) {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-consumer-recovery-"));
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  const installed = path.join(consumer, ".buildchain/bootstrap-recovery");
  fs.cpSync(path.join(root, "templates/bootstrap-recovery"), installed, { recursive: true });
  fs.mkdirSync(path.join(consumer, ".github/workflows"), { recursive: true });
  fs.copyFileSync(path.join(root, "templates/universal-buildchain-bootstrap-recovery.yml"), path.join(consumer, ".github/workflows/buildchain-bootstrap-recovery.yml"));
  return { consumer, installed };
}
function runAction(consumer, installed, action, inputs) {
  const output = path.join(consumer, `output-${crypto.randomUUID()}`);
  fs.writeFileSync(output, "");
  const run = spawnSync(process.execPath, [path.join(installed, `actions/${action}/dist/index.js`)], { cwd: consumer, encoding: "utf8", env: {
    PATH: process.env.PATH, GITHUB_WORKSPACE: consumer, GITHUB_OUTPUT: output,
    ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`INPUT_${key.toUpperCase()}`, String(value)])),
  } });
  return { ...run, outputs: fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "" };
}
test("consumer recovery package executes bundled admission without repository or npm dependencies", t => {
  const { consumer, installed } = isolatedRecovery(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "manifest.json")));
  for (const file of manifest.files) assert.equal(`sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.join(installed, file.path))).digest("hex")}`, file.root, file.path);
  const value = request(policy());
  const result = runAction(consumer, installed, "workflow/admission/inspect", { "request-json": JSON.stringify(value), recovery: "true" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.outputs, new RegExp(value.candidate.expectedSha));
  assert.equal(fs.existsSync(path.join(consumer, "node_modules")), false);
  value.candidate.repository = "attacker/buildchain";
  const rejected = runAction(consumer, installed, "workflow/admission/inspect", { "request-json": JSON.stringify(value), recovery: "true" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr + rejected.stdout, /Buildchain capability Train/);
});
test("all trusted recovery action dependencies resolve in the prepositioned package", t => {
  const { consumer, installed } = isolatedRecovery(t);
  const workflow = YAML.parse(fs.readFileSync(path.join(consumer, ".github/workflows/buildchain-bootstrap-recovery.yml"), "utf8"));
  const visited = new Set();
  function visit(uses) {
    if (!uses.startsWith("./")) return;
    if (uses.startsWith("./.buildchain/candidate/actions/")) return;
    assert.ok(uses.startsWith("./.buildchain/workflow-shell/.buildchain/bootstrap-recovery/actions/"), uses);
    const directory = path.join(installed, uses.split("/bootstrap-recovery/")[1]);
    if (visited.has(directory)) return; visited.add(directory);
    const action = YAML.parse(fs.readFileSync(path.join(directory, "action.yml"), "utf8"));
    if (action.runs.using === "composite") for (const step of action.runs.steps) { assert.ok(step.uses && !step.run && !step.shell); visit(step.uses); }
    else { assert.equal(action.runs.using, "node24"); assert.ok(fs.existsSync(path.join(directory, action.runs.main))); }
  }
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) { assert.equal(Object.hasOwn(step, "run"), false); visit(step.uses); }
  assert.ok(visited.size >= 9);
});
test("consumer-owned settlement rejects candidate lineage substitution", t => {
  const { consumer, installed } = isolatedRecovery(t);
  const result = runAction(consumer, installed, "workflow/settlement/seal", { "admission-json": JSON.stringify({ runtime: { sha: "a".repeat(40) } }), "result-json": JSON.stringify({ runtime: { sha: "b".repeat(40) } }) });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /consumer-owned admission lineage/);
  assert.equal(fs.existsSync(path.join(consumer, ".buildchain/terminal-receipt.json")), false);
});

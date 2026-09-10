#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
const root = process.cwd();
const contract = JSON.parse(fs.readFileSync(path.join(root, "architecture/dev-delivery-orchestration.json"), "utf8"));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-actionlint-"));
try {
  const files = [];
  for (const node of contract.nodes) for (const implementation of node.implementations) {
    const action = YAML.parse(fs.readFileSync(path.join(root, implementation.action), "utf8"));
    assert.deepEqual(Object.keys(action.inputs || {}), implementation.inputs, `${implementation.action}: input contract drift`);
    assert.deepEqual(Object.keys(action.outputs || {}), implementation.outputs, `${implementation.action}: output contract drift`);
    if (action.runs.using === "node24") continue;
    assert.equal(action.runs.using, "composite");
    for (const step of action.runs.steps) {
      assert.ok(step.uses && !step.run && !step.shell && !step.with?.script, `${implementation.action}: composite contains executable logic`);
    }
    const inputs = Object.fromEntries(Object.entries(action.inputs || {}).map(([name, input]) => [name, { ...input, type: "string" }]));
    const outputs = Object.fromEntries(Object.entries(action.outputs || {}).map(([name, output]) => [name, output.value]));
    const file = path.join(temp, `${node.id}-${files.length}.yml`);
    fs.writeFileSync(file, YAML.stringify({ name: `Validate ${node.id} composite`, on: { workflow_call: { inputs } }, jobs: { node: { "runs-on": "ubuntu-24.04", ...(Object.keys(outputs).length ? { outputs } : {}), steps: action.runs.steps } } }));
    files.push(file);
  }
  const probe = spawnSync("actionlint", ["-version"], { stdio: "ignore" });
  const command = probe.error?.code === "ENOENT" ? "go" : "actionlint";
  const prefix = command === "go" ? ["run", "github.com/rhysd/actionlint/cmd/actionlint@v1.7.12"] : [];
  const result = spawnSync(command, [...prefix, "-color=false", ...files], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) process.exitCode = result.status || 1;
  else console.log(`Validated ${files.length} delivery composite bodies and interfaces.`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

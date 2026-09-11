#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { lowerSelfReferencesForLint } from "./workflow-self-reference.mjs";
const root = process.cwd();
const contract = JSON.parse(fs.readFileSync(path.join(root, "architecture/dev-delivery-orchestration.json"), "utf8"));
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-delivery-actionlint-")));
try {
  const workflows = path.join(temp, ".github/workflows");
  fs.cpSync(path.join(root, ".github"), path.join(temp, ".github"), { recursive: true });
  fs.mkdirSync(path.join(temp, ".git")); // actionlint's isolated project boundary, never a runtime checkout.
  fs.mkdirSync(path.join(temp, ".buildchain"));
  fs.symlinkSync(path.join(root, "actions"), path.join(temp, "actions"), "junction");
  const files = fs.readdirSync(workflows).filter(file => /\.ya?ml$/u.test(file)).map(file => path.join(workflows, file));
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
    const file = path.join(workflows, `lint-composite-${node.id}-${files.length}.yml`);
    fs.writeFileSync(file, YAML.stringify({ name: `Validate ${node.id} composite`, on: { workflow_call: { inputs } }, jobs: { node: { "runs-on": "ubuntu-24.04", ...(Object.keys(outputs).length ? { outputs } : {}), steps: action.runs.steps } } }));
    files.push(file);
  }
  const aliases = new Set(files.flatMap(file => [...fs.readFileSync(file, "utf8").matchAll(/\.\/\.buildchain\/([a-z0-9][a-z0-9-]*)\/actions\//gu)].map(match => match[1])));
  for (const alias of aliases) fs.symlinkSync(root, path.join(temp, ".buildchain", alias), "junction");
  for (const file of files) fs.writeFileSync(file, lowerSelfReferencesForLint(fs.readFileSync(file, "utf8")));
  const version = "1.7.12", probe = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
  const command = probe.status === 0 && probe.stdout.trim().split(/\s/u)[0].replace(/^v/u, "") === version ? "actionlint" : "go";
  const prefix = command === "go" ? ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${version}`] : [];
  const result = spawnSync(command, [...prefix, "-color=false", ...files], { cwd: temp, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) process.exitCode = result.status || 1;
  else console.log(`Validated ${files.length} source workflows and delivery composite interfaces.`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }

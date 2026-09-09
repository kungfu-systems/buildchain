#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// actionlint resolves local action interfaces but does not lint composite bodies.
// Validate each owned body's expressions and shell in a workflow with the same
// string inputs and step-output scope. Never execute the synthesized workflow.
const root = process.cwd();
const contract = JSON.parse(
  fs.readFileSync(
    path.join(root, "architecture/dev-delivery-orchestration.json"),
    "utf8",
  ),
);
const temp = fs.mkdtempSync(
  path.join(os.tmpdir(), "buildchain-delivery-actionlint-"),
);
try {
  const files = [];
  for (const node of contract.nodes) {
    const text = fs.readFileSync(path.join(root, node.action), "utf8");
    const inputs = text.match(/^inputs:\n([\s\S]*?)(?=^outputs:|^runs:)/m)?.[1];
    const steps = text.split("  steps:\n")[1];
    if (!inputs || !steps || !text.includes("  using: composite\n"))
      throw new Error(`Invalid owned composite: ${node.id}`);
    const ports = [...inputs.matchAll(/^  ([\w-]+):$/gm)].map((m) => m[1]);
    if (JSON.stringify(ports) !== JSON.stringify(node.inputs))
      throw new Error(`Input contract drift: ${node.id}`);
    const typedInputs = inputs
      .replace(/^  ([\w-]+):$/gm, "  $1:\n    type: string")
      .split("\n")
      .map((line) => (line ? "    " + line : line))
      .join("\n");
    const outputsBlock =
      text.match(/^outputs:\n([\s\S]*?)(?=^runs:)/m)?.[1] || "";
    const outputEntries = [
      ...outputsBlock.matchAll(
        /^  ([\w-]+):\n\s+description:[^\n]*\n\s+value: (.+)$/gm,
      ),
    ];
    if (
      JSON.stringify(outputEntries.map((m) => m[1])) !==
      JSON.stringify(node.outputs)
    )
      throw new Error(`Output contract drift: ${node.id}`);
    const outputs = outputEntries.length
      ? "    outputs:\n" +
        outputEntries.map((m) => `      ${m[1]}: ${m[2]}\n`).join("")
      : "";
    const file = path.join(temp, `${node.id}.yml`);
    fs.writeFileSync(
      file,
      `name: Validate ${node.id} composite\non:\n  workflow_call:\n    inputs:\n${typedInputs}\njobs:\n  node:\n    runs-on: ubuntu-24.04\n${outputs}    steps:\n${steps
        .split("\n")
        .map((line) => (line ? "  " + line : line))
        .join("\n")}`,
    );
    files.push(file);
  }
  const probe = spawnSync("actionlint", ["-version"], { stdio: "ignore" });
  const command = probe.error?.code === "ENOENT" ? "go" : "actionlint";
  const prefix =
    command === "go"
      ? ["run", "github.com/rhysd/actionlint/cmd/actionlint@v1.7.12"]
      : [];
  const result = spawnSync(command, [...prefix, "-color=false", ...files], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0)
    process.exitCode = result.status || 1;
  else
    console.log(
      `Validated ${files.length} delivery composite bodies and interfaces.`,
    );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

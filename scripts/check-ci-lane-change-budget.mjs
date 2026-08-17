#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { evaluateCiLaneChangeBudget } from "../packages/core/ci-lane-change-budget.js";

const root = process.cwd();
const workflowRoot = path.join(root, ".github", "workflows");
const policyPath = path.join(
  root,
  "architecture",
  "ci-lane-change-budget.json",
);

const workflows = fs
  .readdirSync(workflowRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:yaml|yml)$/u.test(entry.name))
  .map((entry) => {
    const workflowPath = path.posix.join(".github/workflows", entry.name);
    return {
      path: workflowPath,
      text: fs.readFileSync(path.join(workflowRoot, entry.name), "utf8"),
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const baselineRevision = String(policy.baseline?.gitRevision || "").trim();
if (!/^[0-9a-f]{40}$/u.test(baselineRevision)) {
  throw new Error("baseline.gitRevision must be an exact Git commit");
}
const baselinePaths = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", baselineRevision, "--", ".github/workflows"],
  { cwd: root, encoding: "utf8" },
)
  .split(/\r?\n/u)
  .filter((value) => /\.(?:yaml|yml)$/u.test(value))
  .sort();
const baselineWorkflows = baselinePaths.map((workflowPath) => ({
  path: workflowPath,
  text: execFileSync("git", ["show", `${baselineRevision}:${workflowPath}`], {
    cwd: root,
    encoding: "utf8",
  }),
}));
const evaluation = evaluateCiLaneChangeBudget({
  policy,
  workflows,
  baselineWorkflows,
});
process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
if (!evaluation.ok) process.exitCode = 1;

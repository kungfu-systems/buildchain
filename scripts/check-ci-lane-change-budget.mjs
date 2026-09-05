#!/usr/bin/env node
import crypto from "node:crypto";
import { projectWorkflowIdentities } from "./workflow-taxonomy.mjs";
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

const physicalWorkflows = fs
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

const workflows = projectWorkflowIdentities(root, physicalWorkflows);

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const baselineRevision = String(policy.baseline?.gitRevision || "").trim();
if (!/^[0-9a-f]{40}$/u.test(baselineRevision)) {
  throw new Error("baseline.gitRevision must be an exact Git commit");
}
const embeddedBaselineLanes = policy.baseline?.lanes;
if (
  !Array.isArray(embeddedBaselineLanes) ||
  embeddedBaselineLanes.length === 0
) {
  throw new Error("baseline.lanes must contain the exact offline lane set");
}
const embeddedLaneSetRoot = `sha256:${crypto
  .createHash("sha256")
  .update(`${JSON.stringify(embeddedBaselineLanes)}\n`)
  .digest("hex")}`;
if (embeddedLaneSetRoot !== policy.baseline?.laneSetRoot) {
  throw new Error("baseline laneSetRoot does not match baseline.lanes");
}

let baselineWorkflows = null;
try {
  execFileSync("git", ["cat-file", "-e", `${baselineRevision}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  const baselinePaths = execFileSync(
    "git",
    [
      "ls-tree",
      "-r",
      "--name-only",
      baselineRevision,
      "--",
      ".github/workflows",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .filter((value) => /\.(?:yaml|yml)$/u.test(value))
    .sort();
  baselineWorkflows = baselinePaths.map((workflowPath) => ({
    path: workflowPath,
    text: execFileSync("git", ["show", `${baselineRevision}:${workflowPath}`], {
      cwd: root,
      encoding: "utf8",
    }),
  }));
} catch {
  // Shallow and exported source cuts may not contain the pinned commit object.
  // The content-rooted embedded lane set remains the exact offline authority.
}

const embeddedEvaluation = evaluateCiLaneChangeBudget({
  policy,
  workflows,
});
const evaluation = baselineWorkflows
  ? evaluateCiLaneChangeBudget({ policy, workflows, baselineWorkflows })
  : embeddedEvaluation;
if (
  baselineWorkflows &&
  (evaluation.baselineLaneCount !== embeddedEvaluation.baselineLaneCount ||
    JSON.stringify(evaluation.newLanes) !==
      JSON.stringify(embeddedEvaluation.newLanes))
) {
  throw new Error(
    "embedded baseline lanes do not match the pinned baseline revision",
  );
}
process.stdout.write(`${JSON.stringify(evaluation, null, 2)}\n`);
if (!evaluation.ok) process.exitCode = 1;

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  analyzeJavaScript,
  collectMaintainabilityMetrics,
  isHandMaintainedSource,
} from "./maintainability-metrics.mjs";

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function gitOutput(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function revisionAvailable(root, revision) {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function ensureRevisionAvailable(root, revision) {
  if (revisionAvailable(root, revision)) return false;
  try {
    gitOutput(root, ["fetch", "--no-tags", "--depth=1", "origin", revision]);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(
      `maintainability enforcement revision ${revision} is unavailable and could not be fetched from origin${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!revisionAvailable(root, revision)) {
    throw new Error(
      `maintainability enforcement revision ${revision} is unavailable after a successful origin fetch`,
    );
  }
  return true;
}

function sourceMetricsAtRevision(root, revision) {
  const files = gitOutput(root, ["ls-tree", "-r", "--name-only", revision])
    .split("\n")
    .filter(isHandMaintainedSource)
    .sort();
  return Object.fromEntries(
    files.map((file) => [
      file,
      analyzeJavaScript(file, gitOutput(root, ["show", `${revision}:${file}`])),
    ]),
  );
}

function maximumFunction(metrics, field) {
  return Math.max(
    0,
    ...(metrics?.functions || []).map((entry) => entry[field]),
  );
}

function selectedFunction(metrics, file, name) {
  return metrics.files[file]?.functions.find((entry) => entry.name === name);
}

function readJsonAtRevision(root, revision, file) {
  return JSON.parse(gitOutput(root, ["show", `${revision}:${file}`]));
}

function publicSurfaceContract(entry, kind) {
  if (kind === "cli") return { id: entry.id, usage: entry.usage };
  if (kind === "node")
    return {
      export: entry.export,
      specifier: entry.specifier,
      target: entry.target,
    };
  return {
    id: entry.id,
    path: entry.path,
    reusable: entry.reusable,
    inputs: entry.inputs || [],
    secrets: entry.secrets || [],
    outputs: entry.outputs || [],
  };
}

function evaluatePublicSurface({ root, revision, policy }) {
  const issues = [];
  const lifecycleFields = policy.publicSurfacePolicy.requiredLifecycleFields;
  const capabilityGroups = new Set(
    readJson(root, "dist/site/capability-registry.json").groups.map(
      (entry) => entry.id,
    ),
  );
  const definitions = [
    {
      file: "dist/site/cli-registry.json",
      collection: "commands",
      kind: "cli",
      key: "id",
    },
    {
      file: "dist/site/node-api-registry.json",
      collection: "exports",
      kind: "node",
      key: "export",
    },
    {
      file: "dist/site/workflow-registry.json",
      collection: "workflows",
      kind: "workflow",
      key: "id",
    },
    {
      file: "dist/site/workflow-registry.json",
      collection: "actions",
      kind: "action",
      key: "id",
    },
  ];
  for (const definition of definitions) {
    const current =
      readJson(root, definition.file)[definition.collection] || [];
    const baseline =
      readJsonAtRevision(root, revision, definition.file)[
        definition.collection
      ] || [];
    const baselineByKey = new Map(
      baseline.map((entry) => [entry[definition.key], entry]),
    );
    for (const entry of current) {
      const label = `${definition.kind}:${entry[definition.key]}`;
      for (const field of lifecycleFields) {
        if (
          !Object.prototype.hasOwnProperty.call(entry, field) ||
          typeof entry[field] !== "string"
        ) {
          issues.push(`${label}: lifecycle field ${field} is missing`);
        }
      }
      if (!capabilityGroups.has(entry.capabilityGroup)) {
        issues.push(
          `${label}: capability group ${entry.capabilityGroup || "<empty>"} is not registered`,
        );
      }
      const previous = baselineByKey.get(entry[definition.key]);
      if (
        previous &&
        JSON.stringify(publicSurfaceContract(entry, definition.kind)) !==
          JSON.stringify(publicSurfaceContract(previous, definition.kind))
      ) {
        issues.push(
          `${label}: existing public contract drifted from ${revision}`,
        );
      }
      if (!previous && !entry.nonDuplicationRationale) {
        issues.push(
          `${label}: new public surface requires a non-duplication rationale`,
        );
      }
    }
  }
  return issues;
}

function evaluateAddedFunctionBudgets({
  file,
  metrics,
  baseline,
  policy,
  budgets,
}) {
  const issues = [];
  const baselineFunctionNames = new Set(
    (baseline.functions || [])
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("<anonymous@")),
  );
  for (const entry of metrics.functions) {
    if (
      entry.name.startsWith("<anonymous@") ||
      baselineFunctionNames.has(entry.name)
    ) {
      continue;
    }
    const key = `${file}#${entry.name}`;
    const approval = policy.approvedExtractedDebt?.[key];
    if (approval && !String(approval.rationale || "").trim()) {
      issues.push(`${key}: approved extracted debt requires a rationale`);
    }
    const allowedLines = approval?.maxLines ?? budgets.newFunctionLines;
    const allowedComplexity =
      approval?.maxComplexity ?? budgets.newFunctionComplexity;
    if (entry.lines > allowedLines) {
      issues.push(
        `${file}:${entry.start} ${entry.name} has ${entry.lines} lines; new-function budget is ${allowedLines}`,
      );
    }
    if (entry.complexity > allowedComplexity) {
      issues.push(
        `${file}:${entry.start} ${entry.name} has complexity ${entry.complexity}; new-function budget is ${allowedComplexity}`,
      );
    }
  }
  return issues;
}

function evaluateMaintainability({ current, baselineFiles, policy }) {
  const issues = [];
  const budgets = policy.sourceBudgets;
  for (const [file, metrics] of Object.entries(current.files)) {
    const baseline = baselineFiles[file];
    if (!baseline) {
      if (metrics.lines > budgets.newFileLines) {
        issues.push(
          `${file}: new file has ${metrics.lines} lines; budget is ${budgets.newFileLines}`,
        );
      }
      for (const entry of metrics.functions) {
        if (entry.lines > budgets.newFunctionLines) {
          issues.push(
            `${file}:${entry.start} ${entry.name} has ${entry.lines} lines; new-function budget is ${budgets.newFunctionLines}`,
          );
        }
        if (entry.complexity > budgets.newFunctionComplexity) {
          issues.push(
            `${file}:${entry.start} ${entry.name} has complexity ${entry.complexity}; new-function budget is ${budgets.newFunctionComplexity}`,
          );
        }
      }
      continue;
    }
    const transition = policy.approvedExistingDebtTransitions?.[file];
    if (transition && !String(transition.rationale || "").trim()) {
      issues.push(`${file}: approved debt transition requires a rationale`);
    }
    const allowedLines =
      transition?.maxLines ?? Math.max(baseline.lines, budgets.newFileLines);
    const allowedFunctionLines =
      transition?.maxFunctionLines ??
      Math.max(maximumFunction(baseline, "lines"), budgets.newFunctionLines);
    const allowedFunctionComplexity =
      transition?.maxFunctionComplexity ??
      Math.max(
        maximumFunction(baseline, "complexity"),
        budgets.newFunctionComplexity,
      );
    if (metrics.lines > allowedLines) {
      issues.push(
        `${file}: file debt widened from ${baseline.lines} to ${metrics.lines} lines`,
      );
    }
    const maxLines = maximumFunction(metrics, "lines");
    if (maxLines > allowedFunctionLines) {
      issues.push(
        `${file}: maximum function length widened beyond ${allowedFunctionLines} to ${maxLines}`,
      );
    }
    const maxComplexity = maximumFunction(metrics, "complexity");
    if (maxComplexity > allowedFunctionComplexity) {
      issues.push(
        `${file}: maximum function complexity widened beyond ${allowedFunctionComplexity} to ${maxComplexity}`,
      );
    }
    issues.push(
      ...evaluateAddedFunctionBudgets({
        file,
        metrics,
        baseline,
        policy,
        budgets,
      }),
    );
  }

  for (const [name, budget] of Object.entries(policy.selectedFunctionBudgets)) {
    const entry = selectedFunction(current, budget.file, name);
    if (!entry) {
      issues.push(`${budget.file}: selected function ${name} is missing`);
      continue;
    }
    if (entry.lines > budget.lines) {
      issues.push(
        `${budget.file}: ${name} has ${entry.lines} lines; terminal budget is ${budget.lines}`,
      );
    }
    if (entry.complexity > budget.complexity) {
      issues.push(
        `${budget.file}: ${name} has complexity ${entry.complexity}; terminal budget is ${budget.complexity}`,
      );
    }
  }
  return issues;
}

function checkMaintainability({ root = process.cwd() } = {}) {
  const policy = readJson(root, "architecture/maintainability-policy.json");
  const baseline = readJson(root, policy.baseline);
  const enforcementRevision = policy.enforcementRevision || baseline.revision;
  const hydratedEnforcementRevision = ensureRevisionAvailable(
    root,
    enforcementRevision,
  );
  const current = collectMaintainabilityMetrics({ root });
  const baselineFiles = sourceMetricsAtRevision(root, enforcementRevision);
  const issues = evaluateMaintainability({ current, baselineFiles, policy });
  issues.push(
    ...evaluatePublicSurface({ root, revision: enforcementRevision, policy }),
  );
  if (issues.length > 0) {
    throw new Error(`maintainability check failed:\n- ${issues.join("\n- ")}`);
  }
  return {
    schemaVersion: 1,
    baselineRevision: baseline.revision,
    enforcementRevision,
    hydratedEnforcementRevision,
    trackedFiles: current.repository.trackedFiles,
    sourceFiles: current.repository.handMaintainedSourceFiles,
    publicSurface: current.publicSurface,
    hotspots: current.hotspots,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const report = checkMaintainability();
    console.log(
      `maintainability check passed: ${report.sourceFiles} source files against ${report.enforcementRevision} ` +
        `(audit baseline ${report.baselineRevision})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  checkMaintainability,
  ensureRevisionAvailable,
  evaluateMaintainability,
  evaluatePublicSurface,
  sourceMetricsAtRevision,
};

import crypto from "node:crypto";
import { parseWorkflowDocument } from "./workflow-yaml-contract.js";

export const CI_LANE_CHANGE_BUDGET_CONTRACT =
  "buildchain.ci-lane-change-budget/v1";

const AUTHORITY_CLASSES = new Set([
  "merge-critical-required",
  "merge-critical-admission",
  "post-merge-advisory",
  "diagnostic",
  "evidence",
  "release",
]);
const TRIGGER_CLASSES = new Set([
  "merge-group",
  "pull-request",
  "push",
  "scheduled",
  "manual",
  "reusable",
  "release",
  "mixed",
]);
const CONCURRENCY_MODES = new Set([
  "none",
  "ref-scoped",
  "workflow-scoped",
  "serialized",
]);
const CANCELLATION_BEHAVIORS = new Set([
  "cancel-stale",
  "finish-started",
  "provider-default",
  "not-applicable",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function root(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function triggerClass(triggers) {
  const classes = new Set();
  for (const trigger of triggers) {
    if (trigger === "merge_group") classes.add("merge-group");
    else if (trigger.startsWith("pull_request")) classes.add("pull-request");
    else if (trigger === "push") classes.add("push");
    else if (trigger === "schedule") classes.add("scheduled");
    else if (trigger === "workflow_dispatch") classes.add("manual");
    else if (trigger === "workflow_call") classes.add("reusable");
    else if (trigger === "release") classes.add("release");
    else classes.add("mixed");
  }
  return classes.size === 1 ? [...classes][0] : "mixed";
}

function diagnostic(code, laneId, message) {
  return { code, laneId, message };
}

function validateDeclaration(declaration, observed) {
  const laneId = String(declaration?.laneId || "");
  const diagnostics = [];
  if (!AUTHORITY_CLASSES.has(declaration?.authorityClass)) {
    diagnostics.push(
      diagnostic(
        "invalid-authority-class",
        laneId,
        "authorityClass must identify the lane's merge or non-merge authority",
      ),
    );
  }
  if (!TRIGGER_CLASSES.has(declaration?.triggerClass)) {
    diagnostics.push(
      diagnostic(
        "invalid-trigger-class",
        laneId,
        "triggerClass must identify the workflow trigger class",
      ),
    );
  } else if (observed && declaration.triggerClass !== observed.triggerClass) {
    diagnostics.push(
      diagnostic(
        "trigger-class-mismatch",
        laneId,
        `declared ${declaration.triggerClass}, observed ${observed.triggerClass}`,
      ),
    );
  }
  const concurrency = declaration?.concurrencyPolicy;
  if (
    !concurrency ||
    !CONCURRENCY_MODES.has(concurrency.mode) ||
    typeof concurrency.cancelInProgress !== "boolean"
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-concurrency-policy",
        laneId,
        "concurrencyPolicy requires a known mode and boolean cancelInProgress",
      ),
    );
  }
  if (
    !Number.isFinite(declaration?.expectedRunnerMinutes) ||
    declaration.expectedRunnerMinutes <= 0
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-runner-budget",
        laneId,
        "expectedRunnerMinutes must be greater than zero",
      ),
    );
  }
  if (!CANCELLATION_BEHAVIORS.has(declaration?.cancellationBehavior)) {
    diagnostics.push(
      diagnostic(
        "invalid-cancellation-behavior",
        laneId,
        "cancellationBehavior must describe how stale or started work settles",
      ),
    );
  }
  const impact = declaration?.sloImpact;
  if (
    !impact ||
    typeof impact.mergeCritical !== "boolean" ||
    !String(impact.metric || "").trim() ||
    !Number.isFinite(impact.expectedContributionSeconds) ||
    impact.expectedContributionSeconds < 0 ||
    !String(impact.rationale || "").trim()
  ) {
    diagnostics.push(
      diagnostic(
        "invalid-slo-impact",
        laneId,
        "sloImpact requires mergeCritical, metric, expectedContributionSeconds, and rationale",
      ),
    );
  }
  return diagnostics;
}

function collectLanes(workflows) {
  const lanes = new Map();
  for (const workflow of workflows) {
    const workflowPath = String(workflow?.path || "").trim();
    if (!workflowPath) throw new Error("workflow path is required");
    const document = parseWorkflowDocument(workflow.text);
    for (const job of document.jobs) {
      const laneId = `${workflowPath}#${job.id}`;
      if (lanes.has(laneId)) throw new Error(`duplicate CI lane: ${laneId}`);
      lanes.set(laneId, {
        laneId,
        workflowPath,
        jobId: job.id,
        triggerClass: triggerClass(document.triggers),
      });
    }
  }
  return lanes;
}

export function evaluateCiLaneChangeBudget({
  policy,
  workflows,
  baselineWorkflows = null,
} = {}) {
  if (policy?.schema !== CI_LANE_CHANGE_BUDGET_CONTRACT) {
    throw new Error(`expected ${CI_LANE_CHANGE_BUDGET_CONTRACT}`);
  }
  if (!Array.isArray(workflows)) throw new Error("workflows must be an array");
  const observed = collectLanes(workflows);
  const baselineLaneIds = baselineWorkflows
    ? [...collectLanes(baselineWorkflows).keys()]
    : policy.baseline?.lanes || [];
  const baseline = new Set(baselineLaneIds);
  if (baseline.size !== baselineLaneIds.length) {
    throw new Error("baseline CI lanes must be unique");
  }
  const declarations = new Map();
  const diagnostics = [];
  for (const declaration of policy.declarations || []) {
    const laneId = String(declaration?.laneId || "").trim();
    if (!laneId) throw new Error("CI lane declaration laneId is required");
    if (declarations.has(laneId))
      throw new Error(`duplicate CI lane declaration: ${laneId}`);
    declarations.set(laneId, declaration);
    if (!observed.has(laneId)) {
      diagnostics.push(
        diagnostic(
          "stale-declaration",
          laneId,
          "declared CI lane is absent from the current workflow cut",
        ),
      );
    }
    diagnostics.push(
      ...validateDeclaration(declaration, observed.get(laneId) || null),
    );
  }
  const newLanes = [...observed.keys()]
    .filter((laneId) => !baseline.has(laneId))
    .sort();
  for (const laneId of newLanes) {
    if (!declarations.has(laneId)) {
      diagnostics.push(
        diagnostic(
          "undeclared-new-lane",
          laneId,
          "new CI lane must declare authority, trigger, concurrency, runner, cancellation, and SLO budgets",
        ),
      );
    }
  }
  const result = {
    schema: "buildchain.ci-lane-change-budget.evaluation/v1",
    ok: diagnostics.length === 0,
    observedLaneCount: observed.size,
    baselineLaneCount: baseline.size,
    newLaneCount: newLanes.length,
    declaredLaneCount: declarations.size,
    newLanes,
    diagnostics: diagnostics.sort((left, right) =>
      `${left.laneId}:${left.code}`.localeCompare(
        `${right.laneId}:${right.code}`,
      ),
    ),
  };
  return { ...result, evaluationRoot: root(result) };
}

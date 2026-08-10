#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  GitHubHousekeeperClient,
  applyGitHubHousekeeperPlan,
  collectGitHubHousekeeperInventory,
} from "../packages/core/engineering-housekeeper-github.js";

const VALID_MODES = new Set(["report", "apply"]);
const VALID_SCOPES = new Set(["branches", "pull-requests"]);
const DEFAULT_OUTPUT_DIRECTORY = ".buildchain/engineering-housekeeper";

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function boolOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`boolean input must be true or false, got: ${value}`);
}

function positiveInteger(value, fallback, field) {
  const selected =
    value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return selected;
}

function splitPatterns(value, fallback) {
  const normalized = String(value || "").trim();
  if (!normalized) return [...fallback];
  return [
    ...new Set(
      normalized
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeRepository(value) {
  const repository = requiredString(value, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`repository must be owner/repo, got: ${repository}`);
  }
  return repository;
}

function normalizeMode(value) {
  const mode = String(value || "report")
    .trim()
    .toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error(`mode must be report or apply, got: ${value || "<empty>"}`);
  }
  return mode;
}

export function normalizeHousekeeperWorkflowOptions(options = {}) {
  const mode = normalizeMode(options.mode ?? process.env.HOUSEKEEPER_MODE);
  const applyEnabled = boolOption(
    options.applyEnabled ?? process.env.HOUSEKEEPER_APPLY_ENABLED,
    false,
  );
  if (mode === "apply" && !applyEnabled) {
    throw new Error("apply mode requires apply-enabled=true");
  }
  if (mode === "report" && applyEnabled) {
    throw new Error("apply-enabled=true is only valid when mode=apply");
  }
  return {
    mode,
    applyEnabled,
    repository: normalizeRepository(
      options.repository ||
        process.env.HOUSEKEEPER_REPOSITORY ||
        process.env.GITHUB_REPOSITORY,
    ),
    targetBranch: String(
      options.targetBranch || process.env.HOUSEKEEPER_TARGET_BRANCH || "",
    )
      .trim()
      .replace(/^refs\/heads\//, ""),
    staleDays: positiveInteger(
      options.staleDays ?? process.env.HOUSEKEEPER_STALE_DAYS,
      30,
      "stale-days",
    ),
    maxActions: positiveInteger(
      options.maxActions ?? process.env.HOUSEKEEPER_MAX_ACTIONS,
      20,
      "max-actions",
    ),
    protectedPatterns: splitPatterns(
      options.protectedPatterns ?? process.env.HOUSEKEEPER_PROTECTED_PATTERNS,
      ["dev/**", "alpha/**", "release/**", "publish-gate/**"],
    ),
    retainedPatterns: splitPatterns(
      options.retainedPatterns ?? process.env.HOUSEKEEPER_RETAINED_PATTERNS,
      ["train/**", "authority/**"],
    ),
    temporaryBranchPatterns: splitPatterns(
      options.temporaryBranchPatterns ??
        process.env.HOUSEKEEPER_TEMPORARY_BRANCH_PATTERNS,
      ["feature/**", "fix/**", "chore/**", "docs/**", "ci/**", "refactor/**"],
    ),
    stalePullRequestLabel: String(
      options.stalePullRequestLabel ??
        process.env.HOUSEKEEPER_STALE_PR_LABEL ??
        "",
    ).trim(),
    observedAt: String(
      options.observedAt ||
        process.env.HOUSEKEEPER_OBSERVED_AT ||
        new Date().toISOString(),
    ),
    appliedAt: String(
      options.appliedAt ||
        process.env.HOUSEKEEPER_APPLIED_AT ||
        new Date().toISOString(),
    ),
    outputDirectory: path.resolve(
      String(
        options.outputDirectory ||
          process.env.HOUSEKEEPER_OUTPUT_DIRECTORY ||
          DEFAULT_OUTPUT_DIRECTORY,
      ),
    ),
  };
}

function workflowPolicy(options) {
  return {
    protectedPatterns: options.protectedPatterns,
    retainedPatterns: options.retainedPatterns,
    temporaryBranchPatterns: options.temporaryBranchPatterns,
    pullRequests: {
      reportStale: true,
      label: options.stalePullRequestLabel,
      autoClose: false,
    },
  };
}

function actionIdentity(action) {
  return action.name
    ? `${action.kind}:${action.name}`
    : `${action.kind}:#${action.number}`;
}

function decisionFor(entry) {
  if (entry.kind === "branch") return entry.decision;
  return entry.actions.length > 0 ? entry.actions.join(",") : "report-only";
}

export function renderHousekeeperWorkflowReport(
  plan,
  receipt,
  { mode, scope = "all" } = {},
) {
  const lines = [
    "## Engineering Housekeeper",
    "",
    `Mode: \`${mode || "report"}\``,
    `Scope: \`${scope}\``,
    `Repository: \`${plan.repository}\``,
    `Primary mainline: \`${plan.target.name}@${plan.target.headOid}\``,
    `Observed at: \`${plan.observedAt}\``,
    `Plan root: \`${plan.planRoot}\``,
    `Receipt root: \`${receipt.receiptRoot}\``,
    "",
    "### Decisions",
    "",
    "| Subject | Observed ref | Decision | Reason codes |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of plan.inventory) {
    const subject =
      entry.kind === "branch" ? entry.name : `PR #${entry.number}`;
    lines.push(
      `| \`${subject}\` | \`${entry.headOid}\` | ${decisionFor(entry)} | \`${entry.reasonCodes.join(",")}\` |`,
    );
  }
  if (plan.inventory.length === 0)
    lines.push("| - | - | retain | `inventory.empty` |");
  lines.push(
    "",
    "### Outcomes",
    "",
    "| Action | Outcome | Details |",
    "| --- | --- | --- |",
  );
  for (const outcome of receipt.outcomes) {
    const details =
      outcome.reasonCodes?.join(",") || outcome.providerError?.operation || "-";
    lines.push(
      `| \`${outcome.action}\` | ${outcome.status} | \`${details}\` |`,
    );
  }
  if (receipt.outcomes.length === 0)
    lines.push("| - | no-op | `no-actions-in-scope` |");
  return `${lines.join("\n")}\n`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function writeOutputs(outputs, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  const lines = Object.entries(outputs).map(
    ([key, value]) => `${key}=${String(value).replace(/\n/g, "%0A")}`,
  );
  fs.appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

function appendSummary(
  markdown,
  summaryFile = process.env.GITHUB_STEP_SUMMARY,
) {
  if (summaryFile) fs.appendFileSync(summaryFile, markdown);
  else process.stdout.write(markdown);
}

export async function createHousekeeperWorkflowPlan(
  optionsInput = {},
  clientInput,
) {
  const options = normalizeHousekeeperWorkflowOptions(optionsInput);
  const client =
    clientInput ||
    new GitHubHousekeeperClient({
      token: requiredString(process.env.GITHUB_TOKEN, "GitHub token"),
    });
  const plan = await collectGitHubHousekeeperInventory({
    client,
    repository: options.repository,
    targetBranch: options.targetBranch,
    observedAt: options.observedAt,
    staleDays: options.staleDays,
    policy: workflowPolicy(options),
  });
  const receipt = await applyGitHubHousekeeperPlan({
    client,
    plan,
    dryRun: true,
    appliedAt: options.appliedAt,
    staleDays: options.staleDays,
    maxActions: options.maxActions,
  });
  return { options, plan, receipt };
}

export function selectHousekeeperActions(plan, scope, maxActions) {
  if (!VALID_SCOPES.has(scope))
    throw new Error(`scope must be branches or pull-requests, got: ${scope}`);
  return plan.actions
    .slice(0, positiveInteger(maxActions, 20, "max-actions"))
    .filter((action) =>
      scope === "branches"
        ? action.kind === "delete-branch"
        : action.kind.endsWith("-pull-request"),
    );
}

export async function applyHousekeeperWorkflowScope({
  options: optionsInput = {},
  plan,
  scope,
  client: clientInput,
}) {
  const options = normalizeHousekeeperWorkflowOptions(optionsInput);
  if (options.mode !== "apply" || !options.applyEnabled) {
    throw new Error("scope apply requires mode=apply and apply-enabled=true");
  }
  if (
    plan.repository !== options.repository ||
    (options.targetBranch && plan.target.name !== options.targetBranch)
  ) {
    throw new Error(
      "plan repository or target branch does not match current workflow inputs",
    );
  }
  const client =
    clientInput ||
    new GitHubHousekeeperClient({
      token: requiredString(process.env.GITHUB_TOKEN, "GitHub token"),
    });
  const scopedPlan = {
    ...plan,
    actions: selectHousekeeperActions(plan, scope, options.maxActions),
  };
  const receipt = await applyGitHubHousekeeperPlan({
    client,
    plan: scopedPlan,
    dryRun: false,
    appliedAt: options.appliedAt,
    staleDays: options.staleDays,
    maxActions: Math.max(1, scopedPlan.actions.length),
  });
  return { options, plan, scopedPlan, receipt };
}

async function planCommand() {
  const result = await createHousekeeperWorkflowPlan();
  const planPath = path.join(result.options.outputDirectory, "plan.json");
  const reportPath = path.join(result.options.outputDirectory, "report.md");
  const receiptPath = path.join(
    result.options.outputDirectory,
    "report-receipt.json",
  );
  const report = renderHousekeeperWorkflowReport(result.plan, result.receipt, {
    mode: result.options.mode,
  });
  writeJson(planPath, result.plan);
  writeJson(receiptPath, result.receipt);
  writeText(reportPath, report);
  appendSummary(report);
  writeOutputs({
    "plan-path": planPath,
    "report-path": reportPath,
    "report-receipt-path": receiptPath,
    "plan-root": result.plan.planRoot,
    "report-receipt-root": result.receipt.receiptRoot,
    "action-count": result.plan.actions.length,
    "branch-action-count": result.plan.actions.filter(
      (action) => action.kind === "delete-branch",
    ).length,
    "pull-request-action-count": result.plan.actions.filter((action) =>
      action.kind.endsWith("-pull-request"),
    ).length,
    outcome:
      result.plan.actions.length === 0
        ? "no-actions"
        : `${result.options.mode}-ready`,
  });
}

async function applyCommand(scope) {
  const planPath = path.resolve(
    requiredString(process.env.HOUSEKEEPER_PLAN_PATH, "HOUSEKEEPER_PLAN_PATH"),
  );
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const result = await applyHousekeeperWorkflowScope({ plan, scope });
  const receiptPath = path.join(
    result.options.outputDirectory,
    `${scope}-receipt.json`,
  );
  const reportPath = path.join(
    result.options.outputDirectory,
    `${scope}-report.md`,
  );
  const report = renderHousekeeperWorkflowReport(result.plan, result.receipt, {
    mode: result.options.mode,
    scope,
  });
  writeJson(receiptPath, result.receipt);
  writeText(reportPath, report);
  appendSummary(report);
  writeOutputs({
    "receipt-path": receiptPath,
    "report-path": reportPath,
    "receipt-root": result.receipt.receiptRoot,
    "outcome-count": result.receipt.outcomes.length,
    "selected-action-count": result.scopedPlan.actions.length,
    outcome: result.scopedPlan.actions.length === 0 ? "no-actions" : "applied",
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "plan") return planCommand();
  if (command === "apply")
    return applyCommand(requiredString(process.argv[3], "scope"));
  throw new Error(
    "usage: engineering-housekeeper-workflow.mjs plan | apply <branches|pull-requests>",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

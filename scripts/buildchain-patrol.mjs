#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runDevPrAutoMerge } from "./dev-pr-auto-merge.mjs";

const DEFAULT_TARGET_BRANCH = "";
const DEFAULT_OUTPUT_PATH = ".buildchain/patrol/result.json";
const VALID_CADENCES = new Set(["daily", "weekly", "monthly"]);
const VALID_MODES = new Set(["cadence-default", "inspect", "merge-ready-dev-prs", "cleanup-safe"]);

function splitList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  if (!text) return [...fallback];
  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function boolOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function intOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeChoice(value, valid, fallback, field) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!valid.has(normalized)) {
    throw new Error(`${field} must be one of ${[...valid].join(", ")}, got: ${value || "<empty>"}`);
  }
  return normalized;
}

function normalizeRepository(value) {
  const repository = String(value || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`repository must be owner/repo, got: ${repository || "<empty>"}`);
  }
  return repository;
}

function normalizeTargetBranch(value) {
  const branch = String(value || process.env.GITHUB_REF_NAME || DEFAULT_TARGET_BRANCH).replace(/^refs\/heads\//, "");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(branch)) {
    throw new Error(`target-branch must be a semver dev branch such as dev/v2/v2.N, got: ${branch || "<empty>"}`);
  }
  return branch;
}

function defaultCapabilities(cadence) {
  if (cadence === "daily") return ["inspect", "merge-ready-dev-prs"];
  if (cadence === "weekly") return ["inspect", "release-health", "stale-state-health"];
  return ["inspect", "governance-health", "workflow-drift-health"];
}

function capabilitiesFor({ cadence, mode, capabilities }) {
  const explicit = splitList(capabilities);
  if (explicit.length > 0) return explicit;
  if (mode === "cadence-default") return defaultCapabilities(cadence);
  if (mode === "merge-ready-dev-prs") return ["inspect", "merge-ready-dev-prs"];
  if (mode === "cleanup-safe") return ["inspect", "cleanup-safe"];
  return ["inspect"];
}

export function normalizePatrolOptions(options = {}) {
  const cadence = normalizeChoice(options.cadence || process.env.BUILDCHAIN_PATROL_CADENCE, VALID_CADENCES, "daily", "cadence");
  const mode = normalizeChoice(options.mode || process.env.BUILDCHAIN_PATROL_MODE, VALID_MODES, "cadence-default", "mode");
  const targetBranch = normalizeTargetBranch(options.targetBranch || process.env.BUILDCHAIN_PATROL_TARGET_BRANCH);
  return {
    cadence,
    mode,
    capabilities: capabilitiesFor({
      cadence,
      mode,
      capabilities: options.capabilities || process.env.BUILDCHAIN_PATROL_CAPABILITIES,
    }),
    repository: normalizeRepository(options.repository || process.env.BUILDCHAIN_PATROL_REPOSITORY || process.env.GITHUB_REPOSITORY),
    targetBranch,
    requiredChecks: options.requiredChecks ?? process.env.BUILDCHAIN_PATROL_REQUIRED_CHECKS,
    readyLabel: options.readyLabel ?? process.env.BUILDCHAIN_PATROL_READY_LABEL,
    blockLabels: options.blockLabels ?? process.env.BUILDCHAIN_PATROL_BLOCK_LABELS,
    allowedHeadPrefixes: options.allowedHeadPrefixes ?? process.env.BUILDCHAIN_PATROL_ALLOWED_HEAD_PREFIXES,
    requireApproval: options.requireApproval ?? process.env.BUILDCHAIN_PATROL_REQUIRE_APPROVAL,
    sameRepositoryOnly: options.sameRepositoryOnly ?? process.env.BUILDCHAIN_PATROL_SAME_REPOSITORY_ONLY,
    maxActions: intOption(options.maxActions ?? process.env.BUILDCHAIN_PATROL_MAX_ACTIONS, 1),
    mergeMethod: String(options.mergeMethod || process.env.BUILDCHAIN_PATROL_MERGE_METHOD || "merge").trim(),
    landingMode: String(options.landingMode || process.env.BUILDCHAIN_PATROL_LANDING_MODE || "auto").trim(),
    dryRun: boolOption(options.dryRun ?? process.env.BUILDCHAIN_PATROL_DRY_RUN, true),
    outputPath: String(options.outputPath || process.env.BUILDCHAIN_PATROL_OUTPUT_PATH || DEFAULT_OUTPUT_PATH),
  };
}

function createCheck(id, status, message, details = {}) {
  return { id, status, message, details };
}

function inspectRepository(options) {
  const checks = [
    createCheck("repository.format", "pass", "repository is owner/repo", { repository: options.repository }),
    createCheck("target_branch.semver_dev", "pass", "target branch is a semver dev channel", {
      targetBranch: options.targetBranch,
    }),
    createCheck("cadence.contract", "pass", "patrol cadence is recognized", {
      cadence: options.cadence,
      mode: options.mode,
      capabilities: options.capabilities,
    }),
  ];
  return {
    contract: "kungfu-buildchain-patrol-inspection",
    ok: checks.every((check) => check.status === "pass"),
    checks,
  };
}

function plannedCapability(capability, reason) {
  return {
    capability,
    status: "planned",
    reason,
  };
}

export async function runBuildchainPatrol(optionsInput = {}, clientInput) {
  const options = normalizePatrolOptions(optionsInput);
  const result = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-patrol",
    repository: options.repository,
    targetBranch: options.targetBranch,
    cadence: options.cadence,
    mode: options.mode,
    dryRun: options.dryRun,
    maxActions: options.maxActions,
    capabilities: options.capabilities,
    inspections: [],
    actions: [],
    planned: [],
    summary: {
      evaluatedCount: 0,
      actionCount: 0,
      skippedCount: 0,
      plannedCount: 0,
    },
  };

  if (options.capabilities.includes("inspect")) {
    result.inspections.push(inspectRepository(options));
  }

  if (options.capabilities.includes("merge-ready-dev-prs")) {
    const mergeResult = await runDevPrAutoMerge(
      {
        repository: options.repository,
        targetBranch: options.targetBranch,
        requiredChecks: options.requiredChecks,
        readyLabel: options.readyLabel,
        blockLabels: options.blockLabels,
        allowedHeadPrefixes: options.allowedHeadPrefixes,
        requireApproval: options.requireApproval,
        sameRepositoryOnly: options.sameRepositoryOnly,
        maxMerges: options.maxActions,
        mergeMethod: options.mergeMethod,
        landingMode: options.landingMode,
        dryRun: options.dryRun,
        outputPath: path.join(path.dirname(options.outputPath), "dev-pr-auto-merge.json"),
      },
      clientInput,
    );
    result.actions.push({
      capability: "merge-ready-dev-prs",
      status: options.dryRun ? "planned" : "executed",
      result: mergeResult,
    });
    result.summary.evaluatedCount += mergeResult.evaluated.length;
    result.summary.actionCount += mergeResult.actions.length;
    result.summary.skippedCount += mergeResult.skipped.length;
  }

  for (const capability of options.capabilities) {
    if (["inspect", "merge-ready-dev-prs"].includes(capability)) continue;
    const entry = plannedCapability(
      capability,
      `${options.cadence} patrol exposes this stable interface before the checker is implemented`,
    );
    result.planned.push(entry);
  }

  result.summary.plannedCount = result.planned.length;
  result.ok = result.inspections.every((inspection) => inspection.ok !== false);
  return result;
}

export function renderPatrolMarkdownSummary(result) {
  const lines = [
    "## Buildchain patrol",
    "",
    `Repository: \`${result.repository}\``,
    `Target branch: \`${result.targetBranch}\``,
    `Cadence: \`${result.cadence}\``,
    `Mode: \`${result.mode}\``,
    `Dry run: \`${result.dryRun ? "true" : "false"}\``,
    `Capabilities: \`${result.capabilities.join(",") || "none"}\``,
    "",
    "| Area | Count |",
    "| --- | ---: |",
    `| Evaluated PRs | ${result.summary.evaluatedCount} |`,
    `| Actions ${result.dryRun ? "planned" : "taken"} | ${result.summary.actionCount} |`,
    `| Skipped PRs | ${result.summary.skippedCount} |`,
    `| Planned future checks | ${result.summary.plannedCount} |`,
  ];

  for (const action of result.actions) {
    if (action.capability !== "merge-ready-dev-prs") continue;
    lines.push("", "### Ready dev PRs", "", "| PR | Action | Reason | Head |", "| --- | --- | --- | --- |");
    const evaluated = action.result.evaluated || [];
    for (const entry of evaluated) {
      lines.push(`| #${entry.number} | ${entry.action} | ${entry.reason} | \`${entry.headRef || ""}\` |`);
    }
    if (evaluated.length === 0) lines.push("| - | skip | no open pull requests | - |");
  }

  if (result.planned.length > 0) {
    lines.push("", "### Planned checks", "", "| Capability | Reason |", "| --- | --- |");
    for (const entry of result.planned) {
      lines.push(`| \`${entry.capability}\` | ${entry.reason} |`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function writeGitHubOutputs(outputs, outputFile = process.env.GITHUB_OUTPUT) {
  if (!outputFile) return;
  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${String(value).replace(/\n/g, "%0A")}`);
  }
  fs.appendFileSync(outputFile, `${lines.join("\n")}\n`);
}

async function main() {
  const options = normalizePatrolOptions();
  const result = await runBuildchainPatrol(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = renderPatrolMarkdownSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  writeGitHubOutputs({
    "result-path": options.outputPath,
    "evaluated-count": result.summary.evaluatedCount,
    "action-count": result.summary.actionCount,
    "skipped-count": result.summary.skippedCount,
    "planned-count": result.summary.plannedCount,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

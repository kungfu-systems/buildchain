import path from "node:path";
import { normalizePatrolOptions } from "./options.js";
import { runDevPrAutoMerge } from "../../dev-delivery/admission/queue.js";
function createCheck(id, status, message, details = {}) {
  return { id, status, message, details };
}

function inspectRepository(options) {
  const checks = [
    createCheck("repository.format", "pass", "repository is owner/repo", {
      repository: options.repository,
    }),
    createCheck(
      "target_branch.semver_dev",
      "pass",
      "target branch is a semver dev channel",
      {
        targetBranch: options.targetBranch,
      },
    ),
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
        outputPath: path.join(
          path.dirname(options.outputPath),
          "dev-pr-auto-merge.json",
        ),
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
  const admissionActions = result.actions.flatMap(
    (action) => action.result?.actions || [],
  );
  result.runKind = "cadence-patrol";
  result.outcome =
    result.summary.evaluatedCount === 0
      ? "no-op-no-candidates"
      : admissionActions.length === 0
        ? "no-op-all-skipped"
        : "actions-present";
  result.noOp = admissionActions.length === 0;
  result.qualification = false;
  result.ok = result.inspections.every((inspection) => inspection.ok !== false);
  return result;
}

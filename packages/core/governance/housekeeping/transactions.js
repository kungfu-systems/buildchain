import {
  collectGitHubHousekeeperInventory,
  applyGitHubHousekeeperPlan,
} from "../engineering-housekeeper-github.js";
import {
  normalizeHousekeeperWorkflowOptions,
  positiveInteger,
} from "./options.js";
const VALID_SCOPES = new Set(["branches", "pull-requests"]);
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

export async function createHousekeeperWorkflowPlan(
  optionsInput = {},
  clientInput,
) {
  const options = normalizeHousekeeperWorkflowOptions(optionsInput);
  const client = clientInput;
  if (!client)
    throw new Error("Housekeeper requires an explicit GitHub client");
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
  const client = clientInput;
  if (!client)
    throw new Error("Housekeeper requires an explicit GitHub client");
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

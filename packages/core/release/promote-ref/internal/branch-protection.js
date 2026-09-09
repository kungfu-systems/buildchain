import { notFound, retryGitHubOperation } from "./github-adapter.js";
import {
  resolveProtectedStatusCheckContext,
  protectedStatusCheckNames,
} from "./channel-governance.js";
export const GITHUB_ACTIONS_APP_ID = 15368;
export function isManagedChannelBranch(ref) {
  return /^(dev|alpha|release)\/v\d+\/v\d+\.\d+$/.test(String(ref || ""));
}
export function managedChannelStrictStatusChecks(branch, currentProtection) {
  if (/^(alpha|release)\//.test(String(branch || ""))) return false;
  if (currentProtection?.required_status_checks) {
    return currentProtection.required_status_checks.strict === true;
  }
  return true;
}
export function parseBranchProtectionBypassList(value = "") {
  return [
    ...new Set(
      String(value || "")
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}
export function branchProtectionBypassAllowances({
  apps = "",
  users = "",
  teams = "",
} = {}) {
  const allowances = {
    apps: parseBranchProtectionBypassList(apps),
    users: parseBranchProtectionBypassList(users),
    teams: parseBranchProtectionBypassList(teams),
  };
  if (
    allowances.users.length > 0 ||
    allowances.teams.length > 0 ||
    allowances.apps.some((app) => app !== "github-actions")
  ) {
    throw new Error(
      "managed channel protection permits only the descriptor-bound github-actions App bypass actor",
    );
  }
  if (
    allowances.apps.length === 0 &&
    allowances.users.length === 0 &&
    allowances.teams.length === 0
  ) {
    return undefined;
  }
  return allowances;
}
export async function ensureManagedChannelBranchProtection({
  octokit,
  owner,
  repo,
  branch,
  requiredStatusCheck = "check",
  branchProtectionBypassApps = "",
  ...unsupported
}) {
  if (Object.keys(unsupported).length)
    throw new Error(
      `unsupported channel protection option: ${Object.keys(unsupported).join(", ")}`,
    );
  if (!isManagedChannelBranch(branch)) {
    return;
  }
  if (typeof octokit.rest.repos?.updateBranchProtection !== "function") {
    return undefined;
  }
  let currentProtection;
  if (typeof octokit.rest.repos?.getBranchProtection === "function") {
    try {
      ({ data: currentProtection } =
        await octokit.rest.repos.getBranchProtection({ owner, repo, branch }));
    } catch (error) {
      if (
        (error.status === 403 || notFound(error)) &&
        typeof octokit.rest.repos?.getBranch === "function"
      ) {
        const { data: branchSummary } = await octokit.rest.repos.getBranch({
          owner,
          repo,
          branch,
        });
        const providerProtection = branchSummary.protection || {};
        const resolvedStatusCheck = resolveProtectedStatusCheckContext({
          protection: providerProtection,
          requiredStatusCheck,
        });
        const missing = [];
        if (branchSummary.protected !== true)
          missing.push("must be provider-protected");
        if (
          providerProtection.required_status_checks?.enforcement_level !==
          "everyone"
        ) {
          missing.push("must enforce required status checks for everyone");
        }
        if (
          !protectedStatusCheckNames(providerProtection).includes(
            resolvedStatusCheck,
          )
        ) {
          missing.push(
            `must require a ${requiredStatusCheck} status check using the exact context`,
          );
        }
        if (missing.length > 0) {
          throw new Error(
            `Managed channel ${branch} provider policy is not qualifying: ${missing.join("; ")}`,
          );
        }
        const observedPolicy = {
          requiredStatusChecks: protectedStatusCheckNames(providerProtection),
          enforcementLevel:
            providerProtection.required_status_checks.enforcement_level,
        };
        return {
          action: "branch-protection-policy-observed",
          ref: branch,
          policySource: "provider-enforced-existing-policy",
          before: observedPolicy,
          after: observedPolicy,
        };
      }
      if (!notFound(error)) throw error;
    }
  }
  const resolvedStatusCheck = currentProtection
    ? resolveProtectedStatusCheckContext({
        protection: currentProtection,
        requiredStatusCheck,
      })
    : requiredStatusCheck;
  const preservedChecks = (
    currentProtection?.required_status_checks?.checks || []
  )
    .filter((check) => check?.context)
    .map((check) => ({
      context: check.context,
      app_id: check.app_id ?? GITHUB_ACTIONS_APP_ID,
    }));
  for (const context of currentProtection?.required_status_checks?.contexts ||
    []) {
    if (!preservedChecks.some((check) => check.context === context)) {
      preservedChecks.push({ context, app_id: GITHUB_ACTIONS_APP_ID });
    }
  }
  if (!preservedChecks.some((check) => check.context === resolvedStatusCheck)) {
    preservedChecks.push({
      context: resolvedStatusCheck,
      app_id: GITHUB_ACTIONS_APP_ID,
    });
  }
  const configuredBypassAllowances = branchProtectionBypassAllowances({
    apps: branchProtectionBypassApps,
  });
  const bypassAllowances = configuredBypassAllowances;
  const strictStatusChecks = managedChannelStrictStatusChecks(
    branch,
    currentProtection,
  );
  await retryGitHubOperation(`repos.updateBranchProtection ${branch}`, () =>
    octokit.rest.repos.updateBranchProtection({
      owner,
      repo,
      branch,
      required_status_checks: {
        strict: strictStatusChecks,
        checks: preservedChecks,
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        required_approving_review_count: 1,
        require_last_push_approval: true,
        ...(bypassAllowances
          ? { bypass_pull_request_allowances: bypassAllowances }
          : {}),
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false,
    }),
  );
  return {
    action: "branch-protection-policy",
    ref: branch,
    policySource: "release-governance-required-status-check",
    before: currentProtection
      ? {
          requiredStatusChecks: protectedStatusCheckNames(currentProtection),
          strict: currentProtection.required_status_checks?.strict === true,
          enforceAdmins: currentProtection.enforce_admins?.enabled === true,
          requiredApprovals: Number(
            currentProtection.required_pull_request_reviews
              ?.required_approving_review_count || 0,
          ),
        }
      : null,
    after: {
      requiredStatusChecks: preservedChecks.map((check) => check.context),
      strict: strictStatusChecks,
      enforceAdmins: true,
      requiredApprovals: 1,
    },
  };
}

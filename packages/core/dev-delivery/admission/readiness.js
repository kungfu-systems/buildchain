import {
  SUCCESS_CONCLUSIONS,
  SUCCESS_STATES,
  normalizeOptions,
} from "./policy.js";
import { projectCutQualification } from "../commands/dev-pr-prequeue-guard.mjs";
export function labelsOf(pr) {
  return (pr.labels || []).map((label) =>
    String(label.name || label).toLowerCase(),
  );
}

export function hasReadyLabel(pr, readyLabel) {
  if (!readyLabel) return true;
  return labelsOf(pr).includes(readyLabel.toLowerCase());
}

export function hasBlockedLabel(pr, blockLabels) {
  const labels = labelsOf(pr);
  return blockLabels.some((label) => labels.includes(label));
}

export function headPrefixAllowed(pr, prefixes) {
  if (prefixes.length === 0) return true;
  const headRef = String(pr.head?.ref || "");
  return prefixes.some((prefix) => headRef.startsWith(prefix));
}

export function sameRepositoryAllowed(pr, repository, sameRepositoryOnly) {
  if (!sameRepositoryOnly) return true;
  return pr.head?.repo?.full_name === repository.fullName;
}

export function latestReviewStates(reviews = []) {
  const latest = new Map();
  for (const review of reviews) {
    const user = review.user?.login;
    if (!user) continue;
    latest.set(user, String(review.state || "").toUpperCase());
  }
  return [...latest.values()];
}

export function hasRequiredApproval(reviews = []) {
  const states = latestReviewStates(reviews);
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

export function checkMatchesRequired(name, required) {
  const haystack = String(name || "").toLowerCase();
  return (
    haystack === required.toLowerCase() ||
    haystack.includes(required.toLowerCase())
  );
}

export function summarizeChecks(
  { statuses = [], checkRuns = [] } = {},
  requiredChecks = [],
) {
  const summary = [];
  for (const required of requiredChecks) {
    const matchingStatuses = statuses.filter((status) =>
      checkMatchesRequired(status.context, required),
    );
    const matchingRuns = checkRuns.filter((run) =>
      checkMatchesRequired(run.name, required),
    );
    const passedStatuses = matchingStatuses.filter((status) =>
      SUCCESS_STATES.has(String(status.state || "").toLowerCase()),
    );
    const passedRuns = matchingRuns.filter((run) =>
      SUCCESS_CONCLUSIONS.has(String(run.conclusion || "").toLowerCase()),
    );
    const passed = passedStatuses.length > 0 || passedRuns.length > 0;
    summary.push({
      required,
      passed,
      matches: [
        ...matchingStatuses.map((status) => ({
          type: "status",
          name: status.context,
          state: status.state,
        })),
        ...matchingRuns.map((run) => ({
          type: "check-run",
          name: run.name,
          conclusion: run.conclusion,
          status: run.status,
        })),
      ],
    });
  }
  return {
    required: requiredChecks,
    entries: summary,
    passed: summary.every((entry) => entry.passed),
  };
}

export function mergeableAccepted(
  pr,
  landingMode = "direct",
  projectCutQualified = false,
) {
  if (pr.mergeable === false) return false;
  const state = String(
    pr.mergeable_state || pr.mergeStateStatus || "",
  ).toLowerCase();
  return state
    ? [
        "clean",
        "has_hooks",
        "unstable",
        "unknown",
        ...(landingMode === "queue" && pr.mergeable === true
          ? ["blocked", ...(projectCutQualified ? ["behind"] : [])]
          : []),
      ].includes(state)
    : pr.mergeable === true;
}

export function rejectBaseMoveBeforeAtomicReplay(
  options,
  initialBaseSha,
  observedBaseSha,
) {
  return (
    observedBaseSha !== initialBaseSha && options.warrantMode !== "required"
  );
}
export function skip(reason, details = {}) {
  return { action: "skip", reason, ...details };
}

function rejectUnreadyPullRequest(pr, options) {
  if (pr.draft) return skip("draft");
  if (
    !sameRepositoryAllowed(pr, options.repository, options.sameRepositoryOnly)
  ) {
    return skip("fork-or-cross-repository-head", {
      headRepository: pr.head?.repo?.full_name || "",
    });
  }
  if (!headPrefixAllowed(pr, options.allowedHeadPrefixes)) {
    return skip("head-prefix-not-allowed", { headRef: pr.head?.ref || "" });
  }
  if (!hasReadyLabel(pr, options.readyLabel)) {
    return skip("missing-ready-label", { requiredLabel: options.readyLabel });
  }
  if (hasBlockedLabel(pr, options.blockLabels)) {
    return skip("blocked-label", { labels: labelsOf(pr) });
  }

  return null;
}

export async function evaluatePullRequest(pr, options, client) {
  options = options.repository?.fullName ? options : normalizeOptions(options);
  const rejected = rejectUnreadyPullRequest(pr, options);
  if (rejected) return rejected;

  const detailed = await client.getPullRequest(pr.number, {
    attempts: options.pollMergeableAttempts,
    delayMs: options.pollMergeableDelayMs,
  });
  if (detailed.base?.ref && detailed.base.ref !== options.targetBranch) {
    return skip("base-branch-drift", {
      expectedBaseRef: options.targetBranch,
      observedBaseRef: detailed.base.ref,
    });
  }
  const mergeableState = String(
    detailed.mergeable_state || detailed.mergeStateStatus || "",
  ).toLowerCase();
  const projectCut =
    mergeableState === "behind" && options.landingMode === "queue"
      ? await projectCutQualification(detailed, options, client)
      : null;
  if (projectCut && !projectCut.ok)
    return skip(projectCut.reason, { projectCut });
  if (options.landingMode === "queue" && detailed.mergeable === false)
    return skip("pre-enqueue-merge-conflict", {
      mergeable: false,
      mergeableState,
    });
  if (
    !mergeableAccepted(detailed, options.landingMode, projectCut?.ok === true)
  ) {
    return skip("not-mergeable", {
      mergeable: detailed.mergeable,
      mergeableState:
        detailed.mergeable_state || detailed.mergeStateStatus || "",
    });
  }

  const approval = { required: options.requireApproval, passed: true };
  if (options.requireApproval) {
    const reviews = await client.listReviews(pr.number);
    approval.passed = hasRequiredApproval(reviews);
    if (!approval.passed) return skip("missing-approval", { approval });
  }

  const observedHeadSha = detailed.head?.sha || pr.head?.sha || "";
  const checks = await client.listCommitChecks(observedHeadSha);
  const checkSummary = summarizeChecks(checks, options.requiredChecks);
  if (!checkSummary.passed)
    return skip("required-checks-not-passing", {
      checks: checkSummary,
      approval,
    });

  return {
    action: options.dryRun ? "would-merge" : "merge",
    reason: options.dryRun ? "dry-run" : "eligible",
    checks: checkSummary,
    approval,
    projectCut,
    pullRequestId: detailed.node_id || pr.node_id || "",
    observedHeadSha,
  };
}

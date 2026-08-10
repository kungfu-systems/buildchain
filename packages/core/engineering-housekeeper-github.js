import {
  HOUSEKEEPER_REASON_CODES,
  classifyHousekeeperBranch,
  classifyHousekeeperReplay,
  createEngineeringHousekeeperPlan,
  createEngineeringHousekeeperReceipt,
  engineeringHousekeeperRoot,
  revalidateHousekeeperBranchAction,
} from "./engineering-housekeeper.js";
import { GitHubHousekeeperProviderError } from "./engineering-housekeeper-github-client.js";

export {
  GitHubHousekeeperClient,
  GitHubHousekeeperProviderError,
} from "./engineering-housekeeper-github-client.js";

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_MAX_ACTIONS = 20;
function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
function normalizeRepository(value) {
  const normalized = requiredString(value?.fullName || value, "repository");
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match)
    throw new Error(`repository must be owner/repo, got: ${normalized}`);
  return { owner: match[1], repo: match[2], fullName: normalized };
}
function normalizeDate(value, field) {
  const date = new Date(requiredString(value, field));
  if (Number.isNaN(date.getTime()))
    throw new Error(`${field} must be an ISO date-time`);
  return date;
}
function normalizePositiveInteger(value, fallback, field) {
  const selected = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return selected;
}
function providerError(error, operation) {
  if (error instanceof GitHubHousekeeperProviderError) return error;
  return new GitHubHousekeeperProviderError(
    `${operation} failed: ${error?.message || String(error)}`,
    { operation, cause: error },
  );
}

function headOid(branch) {
  return String(
    branch?.commit?.sha || branch?.object?.sha || branch?.headOid || "",
  ).toLowerCase();
}

function pullRequestHeadRepository(pullRequest) {
  return String(
    pullRequest?.head?.repo?.full_name || pullRequest?.headRepository || "",
  );
}

function normalizePullRequest(pullRequest, repository, observedAt, staleDays) {
  const updatedAt = new Date(
    pullRequest.updated_at || pullRequest.updatedAt || "",
  );
  const staleBefore = observedAt.getTime() - staleDays * 24 * 60 * 60 * 1000;
  return {
    repository,
    number: Number(pullRequest.number),
    state: pullRequest.draft ? "draft" : String(pullRequest.state || "open"),
    stale:
      !Number.isNaN(updatedAt.getTime()) && updatedAt.getTime() <= staleBefore,
    headRepository: pullRequestHeadRepository(pullRequest),
    headRef: String(pullRequest?.head?.ref || pullRequest.headRef || ""),
    headOid: String(
      pullRequest?.head?.sha || pullRequest.headOid || "",
    ).toLowerCase(),
    labels: (pullRequest.labels || []).map((label) =>
      String(label?.name || label),
    ),
  };
}

function openPullRequestNumbers(pullRequests, repository, branchName) {
  return pullRequests
    .filter(
      (pullRequest) =>
        pullRequest.headRepository === repository &&
        pullRequest.headRef === branchName &&
        ["open", "draft"].includes(pullRequest.state),
    )
    .map((pullRequest) => pullRequest.number)
    .sort((left, right) => left - right);
}

function normalizeOptionalBranchName(value) {
  return String(value || "")
    .trim()
    .replace(/^refs\/heads\//, "");
}

function branchObservation({
  branchState,
  repository,
  repositoryState,
  pullRequests,
  target,
  ancestry,
}) {
  return {
    repository,
    sourceRepository: repository,
    name: String(branchState.name),
    headOid: headOid(branchState),
    target,
    isDefault:
      String(repositoryState.default_branch) === String(branchState.name),
    isProtected: branchState.protected === true,
    ancestry,
    openPullRequestNumbers: openPullRequestNumbers(
      pullRequests,
      repository,
      String(branchState.name),
    ),
  };
}

function mainlineTargetNames({
  branchStates,
  repository,
  repositoryState,
  requestedTarget,
  policy,
}) {
  const protectedTargets = branchStates
    .filter((branchState) => {
      const classification = classifyHousekeeperBranch(
        branchObservation({
          branchState,
          repository,
          repositoryState,
          pullRequests: [],
          target: { name: "__housekeeper_target__", headOid: "0".repeat(40) },
          ancestry: "ancestor",
        }),
        policy,
      );
      return classification.reasonCodes.includes(
        HOUSEKEEPER_REASON_CODES.PROTECTED_BRANCH,
      );
    })
    .map((branchState) => String(branchState.name));
  return [
    ...new Set(
      [
        requestedTarget,
        repositoryState.default_branch,
        ...protectedTargets,
      ].filter(Boolean),
    ),
  ].sort((left, right) => {
    const priority = (name) =>
      name === requestedTarget
        ? 0
        : name === repositoryState.default_branch
          ? 1
          : name.startsWith("dev/")
            ? 2
            : name.startsWith("alpha/")
              ? 3
              : name.startsWith("release/")
                ? 4
                : name.startsWith("publish-gate/")
                  ? 5
                  : 6;
    return priority(left) - priority(right) || left.localeCompare(right);
  });
}

async function branchCandidateTargets({
  repository,
  branchName,
  branchOid,
  targets,
  associatedPullRequests,
}) {
  const mergedTargetNames = new Set(
    associatedPullRequests
      .filter(
        (pullRequest) =>
          Boolean(pullRequest.merged_at || pullRequest.mergedAt) &&
          pullRequestHeadRepository(pullRequest) === repository &&
          String(pullRequest?.head?.ref || pullRequest.headRef || "") ===
            branchName &&
          String(
            pullRequest?.head?.sha || pullRequest.headOid || "",
          ).toLowerCase() === branchOid,
      )
      .map((pullRequest) =>
        String(pullRequest?.base?.ref || pullRequest.baseRef || ""),
      )
      .filter(Boolean),
  );
  return targets
    .filter(
      (target, index) =>
        mergedTargetNames.has(target.name) ||
        index === 0 ||
        target.name.startsWith("dev/"),
    )
    .sort((left, right) => {
      const associated = (target) =>
        mergedTargetNames.has(target.name) ? 0 : 1;
      return associated(left) - associated(right);
    });
}

async function branchAncestry(client, repository, branchOid, targetOid) {
  if (branchOid === targetOid) return "ancestor";
  const comparison = await client.compareCommits(
    repository,
    branchOid,
    targetOid,
  );
  return String(comparison?.merge_base_commit?.sha || "").toLowerCase() ===
    branchOid
    ? "ancestor"
    : "ambiguous";
}

export async function collectGitHubHousekeeperInventory({
  client,
  repository,
  targetBranch,
  observedAt,
  staleDays = DEFAULT_STALE_DAYS,
  policy = {},
}) {
  const coordinate = normalizeRepository(repository);
  const requestedTarget = normalizeOptionalBranchName(targetBranch);
  const observation = normalizeDate(observedAt, "observedAt");
  const staleWindow = normalizePositiveInteger(
    staleDays,
    DEFAULT_STALE_DAYS,
    "staleDays",
  );
  try {
    const [
      repositoryState,
      branchStates,
      pullRequestStates,
      closedPullRequestStates,
    ] = await Promise.all([
      client.getRepository(coordinate.fullName),
      client.listBranches(coordinate.fullName),
      client.listOpenPullRequests(coordinate.fullName),
      client.listClosedPullRequests(coordinate.fullName),
    ]);
    const branchStatesByName = new Map(
      branchStates.map((branchState) => [
        String(branchState.name),
        branchState,
      ]),
    );
    const targetNames = mainlineTargetNames({
      branchStates,
      repository: coordinate.fullName,
      repositoryState,
      requestedTarget,
      policy,
    });
    const targets = targetNames.map((name) => {
      const state = branchStatesByName.get(name);
      if (!state)
        throw new Error(`mainline target branch ${name} was not found`);
      const target = { name, headOid: headOid(state) };
      if (!target.headOid)
        throw new Error(`mainline target branch ${name} has no head OID`);
      return target;
    });
    const target = targets[0];
    if (!target)
      throw new Error("repository has no discoverable mainline target");
    const pullRequests = pullRequestStates
      .map((entry) =>
        normalizePullRequest(
          entry,
          coordinate.fullName,
          observation,
          staleWindow,
        ),
      )
      .sort((left, right) => left.number - right.number);
    const mergedPullRequestsByExactHead = new Map();
    for (const pullRequest of closedPullRequestStates) {
      if (
        !Boolean(pullRequest.merged_at || pullRequest.mergedAt) ||
        pullRequestHeadRepository(pullRequest) !== coordinate.fullName
      )
        continue;
      const key = `${String(
        pullRequest?.head?.ref || pullRequest.headRef || "",
      )}\0${String(
        pullRequest?.head?.sha || pullRequest.headOid || "",
      ).toLowerCase()}`;
      const existing = mergedPullRequestsByExactHead.get(key) || [];
      existing.push(pullRequest);
      mergedPullRequestsByExactHead.set(key, existing);
    }
    const branches = [];
    for (const branchState of [...branchStates].sort((left, right) =>
      String(left.name).localeCompare(String(right.name)),
    )) {
      const branchOid = headOid(branchState);
      if (!branchOid)
        throw new Error(`branch ${branchState.name} has no head OID`);
      const staticObservation = branchObservation({
        branchState,
        repository: coordinate.fullName,
        repositoryState,
        pullRequests,
        target,
        ancestry: "ancestor",
      });
      const staticallyEligible = classifyHousekeeperBranch(
        staticObservation,
        policy,
      ).eligible;
      let selectedTarget = target;
      let ancestry = "ambiguous";
      if (staticallyEligible) {
        const candidateTargets = await branchCandidateTargets({
          repository: coordinate.fullName,
          branchName: String(branchState.name),
          branchOid,
          targets,
          associatedPullRequests:
            mergedPullRequestsByExactHead.get(
              `${String(branchState.name)}\0${branchOid}`,
            ) || [],
        });
        for (const candidateTarget of candidateTargets) {
          if (String(branchState.name) === candidateTarget.name) continue;
          const candidateAncestry = await branchAncestry(
            client,
            coordinate.fullName,
            branchOid,
            candidateTarget.headOid,
          );
          if (candidateAncestry === "ancestor") {
            selectedTarget = candidateTarget;
            ancestry = candidateAncestry;
            break;
          }
        }
      }
      branches.push(
        branchObservation({
          branchState,
          repository: coordinate.fullName,
          repositoryState,
          pullRequests,
          target: selectedTarget,
          ancestry,
        }),
      );
    }
    return createEngineeringHousekeeperPlan({
      repository: coordinate.fullName,
      target,
      branches,
      pullRequests,
      policy,
      observedAt: observation.toISOString(),
    });
  } catch (error) {
    throw providerError(error, `inventory ${coordinate.fullName}`);
  }
}

function actionIdentity(action) {
  return action.name
    ? `${action.kind}:${action.name}`
    : `${action.kind}:#${action.number}`;
}

function rejectedOutcome(action, reasonCodes, details = {}) {
  return {
    action: actionIdentity(action),
    status: "rejected",
    reasonCodes: [...new Set(reasonCodes)].sort(),
    ...details,
  };
}

function providerFailureOutcome(action, error) {
  return {
    action: actionIdentity(action),
    status: "provider-error",
    providerError: {
      operation: String(error?.operation || "github"),
      status: Number(error?.status || 0),
      message: String(error?.message || error),
    },
  };
}

function rootOutcome(outcome) {
  return { ...outcome, outcomeRoot: engineeringHousekeeperRoot(outcome) };
}

async function currentBranchForAction(client, plan, action) {
  const repository = plan.repository;
  let source;
  try {
    source = await client.getBranch(repository, action.name);
  } catch (error) {
    if (Number(error?.status) === 404) return { missing: true };
    throw error;
  }
  const target = await client.getBranch(repository, action.targetName);
  const pullRequests = (await client.listOpenPullRequests(repository)).map(
    (entry) =>
      normalizePullRequest(
        entry,
        repository,
        new Date(plan.observedAt),
        DEFAULT_STALE_DAYS,
      ),
  );
  const sourceOid = headOid(source);
  const targetOid = headOid(target);
  const ancestry = await branchAncestry(
    client,
    repository,
    sourceOid,
    targetOid,
  );
  const [finalSource, finalTarget, finalPullRequests, repositoryState] =
    await Promise.all([
      client.getBranch(repository, action.name),
      client.getBranch(repository, action.targetName),
      client.listOpenPullRequests(repository),
      client.getRepository(repository),
    ]);
  const finalSourceOid = headOid(finalSource);
  const finalTargetOid = headOid(finalTarget);
  const normalizedFinalPullRequests = finalPullRequests.map((entry) =>
    normalizePullRequest(
      entry,
      repository,
      new Date(plan.observedAt),
      DEFAULT_STALE_DAYS,
    ),
  );
  return {
    name: action.name,
    repository,
    sourceRepository: repository,
    headOid: finalSourceOid,
    target: { name: action.targetName, headOid: finalTargetOid },
    isDefault: String(repositoryState.default_branch) === action.name,
    isProtected: finalSource.protected === true,
    ancestry:
      sourceOid === finalSourceOid && targetOid === finalTargetOid
        ? ancestry
        : "ambiguous",
    openPullRequestNumbers: openPullRequestNumbers(
      normalizedFinalPullRequests,
      repository,
      action.name,
    ),
  };
}

async function applyBranchAction(client, plan, action) {
  const current = await currentBranchForAction(client, plan, action);
  if (current.missing) {
    return rejectedOutcome(action, [HOUSEKEEPER_REASON_CODES.RENAMED]);
  }
  const validation = revalidateHousekeeperBranchAction(
    action,
    current,
    plan.policy,
  );
  if (!validation.ok) {
    return rejectedOutcome(action, validation.reasonCodes, {
      currentHeadOid: validation.currentHeadOid,
      currentTargetHeadOid: validation.currentTargetHeadOid,
    });
  }
  const [fencedSource, fencedTarget, fencedPullRequests] = await Promise.all([
    client.getBranch(plan.repository, action.name),
    client.getBranch(plan.repository, action.targetName),
    client.listOpenPullRequests(plan.repository),
  ]);
  const fenced = {
    ...current,
    headOid: headOid(fencedSource),
    target: { name: action.targetName, headOid: headOid(fencedTarget) },
    isProtected: fencedSource.protected === true,
    openPullRequestNumbers: openPullRequestNumbers(
      fencedPullRequests.map((entry) =>
        normalizePullRequest(
          entry,
          plan.repository,
          new Date(plan.observedAt),
          DEFAULT_STALE_DAYS,
        ),
      ),
      plan.repository,
      action.name,
    ),
  };
  const fencedValidation = revalidateHousekeeperBranchAction(
    action,
    fenced,
    plan.policy,
  );
  if (!fencedValidation.ok) {
    return rejectedOutcome(action, fencedValidation.reasonCodes, {
      currentHeadOid: fencedValidation.currentHeadOid,
      currentTargetHeadOid: fencedValidation.currentTargetHeadOid,
    });
  }
  await client.deleteBranch(plan.repository, action.name, {
    expectedHeadOid: action.expectedHeadOid,
  });
  return {
    action: actionIdentity(action),
    status: "deleted",
    headOid: action.expectedHeadOid,
    targetHeadOid: action.expectedTargetHeadOid,
  };
}

function pullRequestRejection(action, current, stale) {
  const reasons = [];
  if (current.headOid !== action.expectedHeadOid) {
    reasons.push(HOUSEKEEPER_REASON_CODES.HEAD_ADVANCED);
  }
  if (!["open", "draft"].includes(current.state)) {
    reasons.push("pull-request.not-active");
  }
  if (!stale) reasons.push("pull-request.not-stale");
  return reasons;
}

async function applyPullRequestAction(
  client,
  plan,
  action,
  appliedAt,
  staleDays,
) {
  const read = async () =>
    normalizePullRequest(
      await client.getPullRequest(plan.repository, action.number),
      plan.repository,
      appliedAt,
      staleDays,
    );
  let current = await read();
  let reasons = pullRequestRejection(action, current, current.stale);
  if (reasons.length > 0) return rejectedOutcome(action, reasons);
  if (action.kind === "report-pull-request") {
    return {
      action: actionIdentity(action),
      status: "reported",
      headOid: current.headOid,
    };
  }
  const label = String(plan.policy.pullRequests.label || "");
  if (!label)
    return rejectedOutcome(action, [
      HOUSEKEEPER_REASON_CODES.PR_LABEL_ELIGIBLE,
    ]);
  current = await read();
  reasons = pullRequestRejection(action, current, current.stale);
  if (reasons.length > 0) return rejectedOutcome(action, reasons);
  if (current.labels.includes(label)) {
    return {
      action: actionIdentity(action),
      status: "already-labeled",
      label,
      headOid: current.headOid,
    };
  }
  await client.addLabels(plan.repository, action.number, [label]);
  return {
    action: actionIdentity(action),
    status: "labeled",
    label,
    headOid: current.headOid,
  };
}

export async function applyGitHubHousekeeperPlan({
  client,
  plan,
  dryRun = true,
  priorReceipt,
  appliedAt = new Date().toISOString(),
  staleDays = DEFAULT_STALE_DAYS,
  maxActions = DEFAULT_MAX_ACTIONS,
}) {
  const applied = normalizeDate(appliedAt, "appliedAt");
  const actionLimit = normalizePositiveInteger(
    maxActions,
    DEFAULT_MAX_ACTIONS,
    "maxActions",
  );
  const staleWindow = normalizePositiveInteger(
    staleDays,
    DEFAULT_STALE_DAYS,
    "staleDays",
  );
  const replay = classifyHousekeeperReplay(plan, priorReceipt);
  if (replay.alreadyApplied) {
    return createEngineeringHousekeeperReceipt({
      plan,
      appliedAt: applied.toISOString(),
      outcomes: [
        rootOutcome({
          action: "replay",
          status: "no-op",
          reasonCodes: replay.reasonCodes,
          priorReceiptRoot: priorReceipt.receiptRoot,
        }),
      ],
    });
  }
  const outcomes = [];
  for (const [index, action] of plan.actions.entries()) {
    if (index >= actionLimit) {
      outcomes.push({
        action: actionIdentity(action),
        status: "limit-skipped",
      });
      continue;
    }
    if (dryRun) {
      outcomes.push({ action: actionIdentity(action), status: "dry-run" });
      continue;
    }
    try {
      outcomes.push(
        action.kind === "delete-branch"
          ? await applyBranchAction(client, plan, action)
          : await applyPullRequestAction(
              client,
              plan,
              action,
              applied,
              staleWindow,
            ),
      );
    } catch (error) {
      outcomes.push(
        providerFailureOutcome(
          action,
          providerError(error, actionIdentity(action)),
        ),
      );
    }
  }
  return createEngineeringHousekeeperReceipt({
    plan,
    outcomes: outcomes.map(rootOutcome),
    appliedAt: applied.toISOString(),
  });
}

export async function runGitHubHousekeeper(options) {
  const plan = await collectGitHubHousekeeperInventory(options);
  const receipt = await applyGitHubHousekeeperPlan({ ...options, plan });
  return { plan, receipt };
}

export function formatGitHubHousekeeperPlan(plan) {
  const lines = [
    `Engineering Housekeeper plan ${plan.planRoot}`,
    `Repository: ${plan.repository}`,
    `Target: ${plan.target.name}@${plan.target.headOid}`,
    `Observed: ${plan.observedAt}`,
    `Actions: ${plan.actions.length}`,
  ];
  for (const action of plan.actions) lines.push(`- ${actionIdentity(action)}`);
  return `${lines.join("\n")}\n`;
}

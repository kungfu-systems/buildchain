import crypto from "node:crypto";

export const ENGINEERING_HOUSEKEEPER_CONTRACT =
  "kungfu-buildchain-engineering-housekeeper/v1";
export const ENGINEERING_HOUSEKEEPER_SCHEMA_VERSION = 1;

export const HOUSEKEEPER_REASON_CODES = Object.freeze({
  ELIGIBLE_MERGED_BRANCH: "eligible.merged-branch",
  PROTECTED_BRANCH: "branch.protected",
  RETAINED_BRANCH: "branch.retained",
  NOT_TEMPORARY_DEVELOPMENT: "branch.not-temporary-development",
  DEFAULT_BRANCH: "branch.default",
  TARGET_BRANCH: "branch.target",
  OPEN_PR_HEAD: "branch.open-pr-head",
  CROSS_REPOSITORY: "branch.cross-repository",
  NOT_MERGED: "branch.not-merged",
  HEAD_ADVANCED: "branch.head-advanced",
  RENAMED: "branch.renamed",
  TARGET_ADVANCED: "branch.target-advanced",
  PERMISSION_DENIED: "branch.permission-denied",
  PR_ACTIVE: "pull-request.active",
  PR_STALE_REPORT: "pull-request.stale-report",
  PR_LABEL_ELIGIBLE: "pull-request.label-eligible",
  PR_AUTO_CLOSE_DISABLED: "pull-request.auto-close-disabled",
  PR_FORKED: "pull-request.forked",
  REPEATED_NO_OP: "replay.already-applied",
});

export const DEFAULT_HOUSEKEEPER_POLICY = Object.freeze({
  protectedPatterns: ["dev/**", "alpha/**", "release/**", "publish-gate/**"],
  retainedPatterns: ["train/**", "authority/**"],
  temporaryBranchPatterns: [
    "feature/**",
    "fix/**",
    "chore/**",
    "docs/**",
    "ci/**",
    "refactor/**",
  ],
  pullRequests: Object.freeze({
    reportStale: true,
    label: "",
    autoClose: false,
  }),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function engineeringHousekeeperRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function globMatches(pattern, value) {
  const expression = String(pattern)
    .split("**")
    .map((chunk) =>
      chunk
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${expression}$`).test(value);
}

function matchesAny(patterns, value) {
  return [...(patterns || [])].some((pattern) => globMatches(pattern, value));
}

function normalizePolicy(policy = {}) {
  return {
    protectedPatterns: [
      ...(policy.protectedPatterns ||
        DEFAULT_HOUSEKEEPER_POLICY.protectedPatterns),
    ].sort(),
    retainedPatterns: [
      ...(policy.retainedPatterns ||
        DEFAULT_HOUSEKEEPER_POLICY.retainedPatterns),
    ].sort(),
    temporaryBranchPatterns: [
      ...(policy.temporaryBranchPatterns ||
        DEFAULT_HOUSEKEEPER_POLICY.temporaryBranchPatterns),
    ].sort(),
    pullRequests: {
      reportStale: policy.pullRequests?.reportStale !== false,
      label: String(policy.pullRequests?.label || ""),
      autoClose: false,
    },
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function classifyHousekeeperBranch(branch, policyInput = {}) {
  const policy = normalizePolicy(policyInput);
  const reasons = [];
  if (branch.isDefault) reasons.push(HOUSEKEEPER_REASON_CODES.DEFAULT_BRANCH);
  if (branch.name === branch.target?.name)
    reasons.push(HOUSEKEEPER_REASON_CODES.TARGET_BRANCH);
  if (
    branch.isProtected === true ||
    matchesAny(policy.protectedPatterns, branch.name)
  )
    reasons.push(HOUSEKEEPER_REASON_CODES.PROTECTED_BRANCH);
  if (matchesAny(policy.retainedPatterns, branch.name))
    reasons.push(HOUSEKEEPER_REASON_CODES.RETAINED_BRANCH);
  if (!matchesAny(policy.temporaryBranchPatterns, branch.name))
    reasons.push(HOUSEKEEPER_REASON_CODES.NOT_TEMPORARY_DEVELOPMENT);
  if (branch.sourceRepository && branch.sourceRepository !== branch.repository)
    reasons.push(HOUSEKEEPER_REASON_CODES.CROSS_REPOSITORY);
  if ((branch.openPullRequestNumbers || []).length > 0)
    reasons.push(HOUSEKEEPER_REASON_CODES.OPEN_PR_HEAD);
  if (branch.ancestry !== "ancestor")
    reasons.push(HOUSEKEEPER_REASON_CODES.NOT_MERGED);
  const eligible =
    reasons.length === 0 &&
    Boolean(branch.headOid) &&
    Boolean(branch.target?.headOid);
  return {
    kind: "branch",
    repository: branch.repository,
    name: branch.name,
    headOid: branch.headOid,
    target: { name: branch.target?.name, headOid: branch.target?.headOid },
    eligible,
    decision: eligible ? "delete" : "retain",
    reasonCodes: eligible
      ? [HOUSEKEEPER_REASON_CODES.ELIGIBLE_MERGED_BRANCH]
      : sortedUnique(reasons),
  };
}

export function classifyHousekeeperPullRequest(pullRequest, policyInput = {}) {
  const policy = normalizePolicy(policyInput);
  const active = ["open", "draft"].includes(pullRequest.state);
  const forked = pullRequest.headRepository !== pullRequest.repository;
  const stale = active && pullRequest.stale === true;
  const actions = stale && policy.pullRequests.reportStale ? ["report"] : [];
  if (stale && policy.pullRequests.label) actions.push("label");
  const reasons = [HOUSEKEEPER_REASON_CODES.PR_AUTO_CLOSE_DISABLED];
  if (active) reasons.push(HOUSEKEEPER_REASON_CODES.PR_ACTIVE);
  if (stale) reasons.push(HOUSEKEEPER_REASON_CODES.PR_STALE_REPORT);
  if (stale && policy.pullRequests.label)
    reasons.push(HOUSEKEEPER_REASON_CODES.PR_LABEL_ELIGIBLE);
  if (forked) reasons.push(HOUSEKEEPER_REASON_CODES.PR_FORKED);
  return {
    kind: "pull-request",
    repository: pullRequest.repository,
    number: pullRequest.number,
    headRepository: pullRequest.headRepository,
    headRef: pullRequest.headRef,
    headOid: pullRequest.headOid,
    state: pullRequest.state,
    actions: actions.sort(),
    reasonCodes: sortedUnique(reasons),
  };
}

export function createEngineeringHousekeeperPlan({
  repository,
  target,
  branches = [],
  pullRequests = [],
  policy = {},
  observedAt,
}) {
  const normalizedPolicy = normalizePolicy(policy);
  const inventory = [
    ...branches.map((branch) =>
      classifyHousekeeperBranch(branch, normalizedPolicy),
    ),
    ...pullRequests.map((pullRequest) =>
      classifyHousekeeperPullRequest(pullRequest, normalizedPolicy),
    ),
  ].sort((left, right) =>
    `${left.kind}:${left.name || String(left.number).padStart(12, "0")}`.localeCompare(
      `${right.kind}:${right.name || String(right.number).padStart(12, "0")}`,
    ),
  );
  const body = {
    contract: ENGINEERING_HOUSEKEEPER_CONTRACT,
    schemaVersion: ENGINEERING_HOUSEKEEPER_SCHEMA_VERSION,
    mode: "plan",
    repository,
    target,
    observedAt,
    policy: normalizedPolicy,
    inventory,
    actions: inventory.flatMap((entry) =>
      entry.kind === "branch" && entry.eligible
        ? [
            {
              kind: "delete-branch",
              name: entry.name,
              expectedHeadOid: entry.headOid,
              targetName: entry.target.name,
              expectedTargetHeadOid: entry.target.headOid,
            },
          ]
        : entry.kind === "pull-request"
          ? entry.actions.map((action) => ({
              kind: `${action}-pull-request`,
              number: entry.number,
              expectedHeadOid: entry.headOid,
            }))
          : [],
    ),
  };
  return { ...body, planRoot: engineeringHousekeeperRoot(body) };
}

export function revalidateHousekeeperBranchAction(
  action,
  current,
  policy = {},
) {
  const reasons = [];
  if (current.name !== action.name)
    reasons.push(HOUSEKEEPER_REASON_CODES.RENAMED);
  if (current.headOid !== action.expectedHeadOid)
    reasons.push(HOUSEKEEPER_REASON_CODES.HEAD_ADVANCED);
  if (current.target?.headOid !== action.expectedTargetHeadOid)
    reasons.push(HOUSEKEEPER_REASON_CODES.TARGET_ADVANCED);
  const classification = classifyHousekeeperBranch(current, policy);
  if (!classification.eligible) reasons.push(...classification.reasonCodes);
  return {
    ok: reasons.length === 0,
    action,
    currentHeadOid: current.headOid,
    currentTargetHeadOid: current.target?.headOid,
    reasonCodes: sortedUnique(reasons),
  };
}

export function createEngineeringHousekeeperReceipt({
  plan,
  outcomes,
  appliedAt,
}) {
  const orderedOutcomes = [...outcomes].sort((a, b) =>
    stableJson(a).localeCompare(stableJson(b)),
  );
  const body = {
    contract: ENGINEERING_HOUSEKEEPER_CONTRACT,
    schemaVersion: ENGINEERING_HOUSEKEEPER_SCHEMA_VERSION,
    mode: "receipt",
    planRoot: plan.planRoot,
    appliedAt,
    outcomes: orderedOutcomes,
  };
  return { ...body, receiptRoot: engineeringHousekeeperRoot(body) };
}

export function classifyHousekeeperReplay(plan, priorReceipt) {
  const alreadyApplied = priorReceipt?.planRoot === plan.planRoot;
  return {
    alreadyApplied,
    action: alreadyApplied ? "no-op" : "apply",
    reasonCodes: alreadyApplied
      ? [HOUSEKEEPER_REASON_CODES.REPEATED_NO_OP]
      : [],
  };
}

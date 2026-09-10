export const PUBLIC_BUILD_ROUTER_AGGREGATE_JOB = "Summarize build contract";

export function normalized(value) {
  return String(value ?? "").trim();
}

export function assertRepository(value) {
  const repository = normalized(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("repository must use owner/repo form");
  }
  return repository;
}

export function assertManagedBranch(value) {
  const branch = normalized(value).replace(/^refs\/heads\//, "");
  if (!/^(?:dev|alpha|release)\/v\d+\/v\d+\.\d+$/.test(branch)) {
    throw new Error("branch must be a managed dev/alpha/release ref");
  }
  return branch;
}

export function assertSha(value) {
  const sha = normalized(value);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("candidate SHA must be a 40-character Git SHA");
  }
  return sha.toLowerCase();
}

function checkContextEntries(protection = {}) {
  const policy = protection.required_status_checks || {};
  const entries = [];
  for (const check of policy.checks || []) {
    const context = normalized(check?.context);
    if (context) entries.push({ context, app_id: check.app_id ?? null });
  }
  for (const contextValue of policy.contexts || []) {
    const context = normalized(contextValue);
    if (context && !entries.some((entry) => entry.context === context)) {
      entries.push({ context, app_id: null });
    }
  }
  return entries;
}

function isBuildRouterAggregateContext(
  context,
  aggregateJob = PUBLIC_BUILD_ROUTER_AGGREGATE_JOB,
) {
  const name = normalized(context);
  return name === aggregateJob || name.endsWith(` / ${aggregateJob}`);
}

function contextDepth(context) {
  return normalized(context).split(" / ").length;
}

export function resolvePublicBuildRouterAggregateCheck({
  checkRuns = [],
  aggregateJob = PUBLIC_BUILD_ROUTER_AGGREGATE_JOB,
} = {}) {
  const qualifying = (checkRuns || []).filter(
    (check) =>
      check?.status === "completed" &&
      check?.conclusion === "success" &&
      isBuildRouterAggregateContext(check?.name, aggregateJob),
  );
  const names = [...new Set(qualifying.map((check) => normalized(check.name)))];
  if (names.length === 0) {
    throw new Error(
      `candidate emitted no successful public Buildchain aggregate ending in '${aggregateJob}'`,
    );
  }
  const shallowestDepth = Math.min(...names.map(contextDepth));
  const shallowest = names.filter(
    (name) => contextDepth(name) === shallowestDepth,
  );
  if (shallowest.length !== 1) {
    throw new Error(
      `candidate emitted ambiguous public Buildchain aggregates: ${shallowest.join(", ")}`,
    );
  }
  const name = shallowest[0];
  const matching = qualifying
    .filter((check) => normalized(check.name) === name)
    .sort((left, right) =>
      normalized(right.completed_at).localeCompare(
        normalized(left.completed_at),
      ),
    );
  const appId = matching[0]?.app?.id;
  if (!Number.isInteger(appId)) {
    throw new Error(
      `candidate aggregate '${name}' does not expose a GitHub App id`,
    );
  }
  return { context: name, app_id: appId };
}

export function planReleaseGovernanceReconciliation({
  repository,
  branch,
  candidateSha,
  protection = {},
  checkRuns = [],
  aggregateJob = PUBLIC_BUILD_ROUTER_AGGREGATE_JOB,
} = {}) {
  const normalizedRepository = assertRepository(repository);
  const normalizedBranch = assertManagedBranch(branch);
  const normalizedSha = assertSha(candidateSha);
  const policy = protection.required_status_checks;
  if (!policy) {
    throw new Error(
      `protected branch ${normalizedBranch} has no required status-check policy`,
    );
  }
  const expected = resolvePublicBuildRouterAggregateCheck({
    checkRuns,
    aggregateJob,
  });
  const before = checkContextEntries(protection);
  const stale = before.filter(
    (entry) =>
      isBuildRouterAggregateContext(entry.context, aggregateJob) &&
      entry.context !== expected.context,
  );
  const after = before.filter(
    (entry) => !isBuildRouterAggregateContext(entry.context, aggregateJob),
  );
  after.push(expected);
  const uniqueAfter = [];
  for (const entry of after) {
    const existing = uniqueAfter.find(
      (candidate) => candidate.context === entry.context,
    );
    if (!existing) {
      uniqueAfter.push(entry);
    } else if (existing.app_id === null && entry.app_id !== null) {
      existing.app_id = entry.app_id;
    }
  }
  const normalizedBefore = before
    .map((entry) => `${entry.context}:${entry.app_id ?? "any"}`)
    .sort();
  const normalizedAfter = uniqueAfter
    .map((entry) => `${entry.context}:${entry.app_id ?? "any"}`)
    .sort();
  const changed =
    JSON.stringify(normalizedBefore) !== JSON.stringify(normalizedAfter);

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-governance-reconciliation",
    repository: normalizedRepository,
    branch: normalizedBranch,
    candidateSha: normalizedSha,
    aggregateJob,
    expected,
    actual: before,
    staleBuildchainContexts: stale,
    changed,
    requiredStatusChecks: {
      strict: policy.strict === true,
      before,
      after: uniqueAfter,
    },
    preservedPolicy: {
      requiredApprovingReviewCount:
        protection.required_pull_request_reviews
          ?.required_approving_review_count ?? null,
      enforceAdmins: protection.enforce_admins?.enabled === true,
      requiredConversationResolution:
        protection.required_conversation_resolution?.enabled === true,
      allowForcePushes: protection.allow_force_pushes?.enabled === true,
      allowDeletions: protection.allow_deletions?.enabled === true,
    },
  };
}

#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PUBLIC_BUILD_ROUTER_AGGREGATE_JOB = "Summarize build contract";

function normalized(value) {
  return String(value ?? "").trim();
}

function assertRepository(value) {
  const repository = normalized(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("repository must use owner/repo form");
  }
  return repository;
}

function assertManagedBranch(value) {
  const branch = normalized(value).replace(/^refs\/heads\//, "");
  if (!/^(?:dev|alpha|release)\/v\d+\/v\d+\.\d+$/.test(branch)) {
    throw new Error("branch must be a managed dev/alpha/release ref");
  }
  return branch;
}

function assertSha(value) {
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

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function apiToken() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  return token;
}

async function githubRequest({ apiUrl, token, method = "GET", route, body }) {
  const response = await fetch(
    `${apiUrl.replace(/\/$/, "")}/${route.replace(/^\//, "")}`,
    {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${route} failed with ${response.status}: ${data?.message || text}`,
    );
  }
  return data;
}

function assertCandidatePullRequest({
  pullRequests = [],
  branch,
  candidateSha,
}) {
  const match = pullRequests.find(
    (pullRequest) =>
      pullRequest?.base?.ref === branch &&
      normalized(pullRequest?.head?.sha).toLowerCase() === candidateSha,
  );
  if (!match) {
    throw new Error(
      `candidate ${candidateSha} is not the head of a pull request targeting ${branch}`,
    );
  }
  return { number: match.number, url: match.html_url || "" };
}

export async function reconcileReleaseGovernance({
  repository,
  branch,
  candidateSha,
  apply = false,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  token = apiToken(),
} = {}) {
  const normalizedRepository = assertRepository(repository);
  const normalizedBranch = assertManagedBranch(branch);
  const normalizedSha = assertSha(candidateSha);
  const encodedBranch = encodeURIComponent(normalizedBranch);
  const encodedSha = encodeURIComponent(normalizedSha);
  const [protection, checksResponse, pullRequests] = await Promise.all([
    githubRequest({
      apiUrl,
      token,
      route: `repos/${normalizedRepository}/branches/${encodedBranch}/protection`,
    }),
    githubRequest({
      apiUrl,
      token,
      route: `repos/${normalizedRepository}/commits/${encodedSha}/check-runs?filter=latest&per_page=100`,
    }),
    githubRequest({
      apiUrl,
      token,
      route: `repos/${normalizedRepository}/commits/${encodedSha}/pulls?per_page=100`,
    }),
  ]);
  const pullRequest = assertCandidatePullRequest({
    pullRequests,
    branch: normalizedBranch,
    candidateSha: normalizedSha,
  });
  const plan = planReleaseGovernanceReconciliation({
    repository: normalizedRepository,
    branch: normalizedBranch,
    candidateSha: normalizedSha,
    protection,
    checkRuns: checksResponse.check_runs || [],
  });

  if (apply && plan.changed) {
    await githubRequest({
      apiUrl,
      token,
      method: "PATCH",
      route: `repos/${normalizedRepository}/branches/${encodedBranch}/protection/required_status_checks`,
      body: {
        strict: plan.requiredStatusChecks.strict,
        contexts: plan.requiredStatusChecks.after
          .filter((entry) => entry.app_id === null)
          .map((entry) => entry.context),
        checks: plan.requiredStatusChecks.after
          .filter((entry) => entry.app_id !== null)
          .map((entry) => ({
            context: entry.context,
            app_id: entry.app_id,
          })),
      },
    });
  }
  return {
    ...plan,
    pullRequest,
    applied: apply && plan.changed,
    status: plan.changed ? (apply ? "reconciled" : "drift") : "aligned",
  };
}

function usage() {
  return `Usage:
  buildchain release-governance reconcile --repository <owner/repo>
      --branch <dev|alpha|release/vN/vN.N> --candidate-sha <sha> [--apply] [--json]
`;
}

export async function runReleaseGovernanceCli(argv = process.argv.slice(2)) {
  const [mode = "", ...args] = argv;
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (mode !== "reconcile") {
    throw new Error(`unsupported release-governance command: ${mode}`);
  }
  const result = await reconcileReleaseGovernance({
    repository: readFlag(
      args,
      "repository",
      process.env.GITHUB_REPOSITORY || "",
    ),
    branch: readFlag(args, "branch"),
    candidateSha: readFlag(args, "candidate-sha"),
    apply: hasFlag(args, "apply"),
  });
  if (hasFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `release governance ${result.status}: ${result.repository} ${result.branch}\n`,
    );
    process.stdout.write(`- expected: ${result.expected.context}\n`);
    process.stdout.write(
      `- actual: ${result.actual.map((entry) => entry.context).join(", ") || "none"}\n`,
    );
    process.stdout.write(`- candidate: ${result.candidateSha}\n`);
    process.stdout.write(
      result.applied
        ? "Required status checks were reconciled without changing other branch-protection settings.\n"
        : "No branch-protection settings were modified.\n",
    );
  }
  return result;
}

if (
  !process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runReleaseGovernanceCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BLOCK_LABELS = ["blocked", "do-not-merge", "work-in-progress"];
const DEFAULT_ALLOWED_HEAD_PREFIXES = ["feature/", "fix/", "chore/", "docs/", "ci/", "refactor/"];
const DEFAULT_REQUIRED_CHECKS = ["check"];
const SUCCESS_STATES = new Set(["success"]);
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const VALID_LANDING_MODES = new Set(["auto", "direct", "queue"]);
const STATIC_SKIP_REASONS = new Set([
  "draft",
  "fork-or-cross-repository-head",
  "head-prefix-not-allowed",
  "missing-ready-label",
  "blocked-label",
]);
const ADMISSION_CONTRACT = "kungfu-buildchain-dev-merge-queue-admission";

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

function choiceOption(value, valid, fallback, field) {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!valid.has(normalized)) {
    throw new Error(`${field} must be one of ${[...valid].join(", ")}, got: ${value || "<empty>"}`);
  }
  return normalized;
}

function normalizeRepo(value) {
  const text = String(value?.fullName || value || "").trim();
  const match = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) throw new Error(`repository must be owner/repo, got: ${text || "<empty>"}`);
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function normalizeOptions(options = {}) {
  return {
    repository: normalizeRepo(options.repository || process.env.GITHUB_REPOSITORY),
    targetBranch: String(options.targetBranch || "").replace(/^refs\/heads\//, ""),
    readyLabel: String(options.readyLabel ?? "ready").trim(),
    blockLabels: splitList(options.blockLabels, DEFAULT_BLOCK_LABELS).map((label) => label.toLowerCase()),
    allowedHeadPrefixes: splitList(options.allowedHeadPrefixes, DEFAULT_ALLOWED_HEAD_PREFIXES),
    requiredChecks: splitList(options.requiredChecks, DEFAULT_REQUIRED_CHECKS),
    requireApproval: boolOption(options.requireApproval, true),
    sameRepositoryOnly: boolOption(options.sameRepositoryOnly, true),
    maxMerges: intOption(options.maxMerges, 1),
    mergeMethod: String(options.mergeMethod || "merge").trim(),
    landingMode: choiceOption(options.landingMode, VALID_LANDING_MODES, "auto", "landing mode"),
    dryRun: boolOption(options.dryRun, true),
    pollMergeableAttempts: intOption(options.pollMergeableAttempts, 3),
    pollMergeableDelayMs: intOption(options.pollMergeableDelayMs, 1000),
    outputPath: String(options.outputPath || ".buildchain/dev-pr-auto-merge/result.json"),
  };
}

function labelsOf(pr) {
  return (pr.labels || []).map((label) => String(label.name || label).toLowerCase());
}

function hasReadyLabel(pr, readyLabel) {
  if (!readyLabel) return true;
  return labelsOf(pr).includes(readyLabel.toLowerCase());
}

function hasBlockedLabel(pr, blockLabels) {
  const labels = labelsOf(pr);
  return blockLabels.some((label) => labels.includes(label));
}

function headPrefixAllowed(pr, prefixes) {
  if (prefixes.length === 0) return true;
  const headRef = String(pr.head?.ref || "");
  return prefixes.some((prefix) => headRef.startsWith(prefix));
}

function sameRepositoryAllowed(pr, repository, sameRepositoryOnly) {
  if (!sameRepositoryOnly) return true;
  return pr.head?.repo?.full_name === repository.fullName;
}

function latestReviewStates(reviews = []) {
  const latest = new Map();
  for (const review of reviews) {
    const user = review.user?.login;
    if (!user) continue;
    latest.set(user, String(review.state || "").toUpperCase());
  }
  return [...latest.values()];
}

function hasRequiredApproval(reviews = []) {
  const states = latestReviewStates(reviews);
  return states.includes("APPROVED") && !states.includes("CHANGES_REQUESTED");
}

function checkMatchesRequired(name, required) {
  const haystack = String(name || "").toLowerCase();
  return haystack === required.toLowerCase() || haystack.includes(required.toLowerCase());
}

function summarizeChecks({ statuses = [], checkRuns = [] } = {}, requiredChecks = []) {
  const summary = [];
  for (const required of requiredChecks) {
    const matchingStatuses = statuses.filter((status) => checkMatchesRequired(status.context, required));
    const matchingRuns = checkRuns.filter((run) => checkMatchesRequired(run.name, required));
    const passedStatuses = matchingStatuses.filter((status) => SUCCESS_STATES.has(String(status.state || "").toLowerCase()));
    const passedRuns = matchingRuns.filter((run) => SUCCESS_CONCLUSIONS.has(String(run.conclusion || "").toLowerCase()));
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

function mergeableAccepted(pr) {
  if (pr.mergeable === false) return false;
  const state = String(pr.mergeable_state || pr.mergeStateStatus || "").toLowerCase();
  if (!state) return pr.mergeable === true;
  return ["clean", "has_hooks", "unstable", "unknown"].includes(state);
}

function skip(reason, details = {}) {
  return { action: "skip", reason, ...details };
}

export async function evaluatePullRequest(pr, options, client) {
  options = options.repository?.fullName ? options : normalizeOptions(options);
  if (pr.draft) return skip("draft");
  if (!sameRepositoryAllowed(pr, options.repository, options.sameRepositoryOnly)) {
    return skip("fork-or-cross-repository-head", { headRepository: pr.head?.repo?.full_name || "" });
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
  if (!mergeableAccepted(detailed)) {
    return skip("not-mergeable", {
      mergeable: detailed.mergeable,
      mergeableState: detailed.mergeable_state || detailed.mergeStateStatus || "",
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
  if (!checkSummary.passed) return skip("required-checks-not-passing", { checks: checkSummary, approval });

  return {
    action: options.dryRun ? "would-merge" : "merge",
    reason: options.dryRun ? "dry-run" : "eligible",
    checks: checkSummary,
    approval,
    pullRequestId: detailed.node_id || pr.node_id || "",
    observedHeadSha,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLinkHeader(header) {
  const links = {};
  for (const part of String(header || "").split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export class GitHubClient {
  constructor({ token, repository, apiUrl = "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
    if (!fetchImpl) throw new Error("fetch is required");
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
  }

  async request(method, requestPath, { body, accept = "application/vnd.github+json" } = {}) {
    const url = requestPath.startsWith("http") ? requestPath : `${this.apiUrl}${requestPath}`;
    const response = await this.fetch(url, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const message = data?.message || text || `${method} ${url} failed`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { data, response };
  }

  async paginate(requestPath) {
    let next = requestPath;
    const items = [];
    while (next) {
      const { data, response } = await this.request("GET", next);
      items.push(...data);
      next = parseLinkHeader(response.headers.get("link")).next;
    }
    return items;
  }

  async listPullRequests(base) {
    const query = new URLSearchParams({
      state: "open",
      base,
      sort: "updated",
      direction: "asc",
      per_page: "100",
    });
    return this.paginate(`/repos/${this.repository.owner}/${this.repository.repo}/pulls?${query}`);
  }

  async getPullRequest(number, { attempts = 3, delayMs = 1000 } = {}) {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const { data } = await this.request(
        "GET",
        `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${number}`,
      );
      last = data;
      if (data.mergeable !== null && data.mergeable !== undefined) return data;
      if (attempt < attempts) await delay(delayMs);
    }
    return last;
  }

  async listReviews(number) {
    return this.paginate(`/repos/${this.repository.owner}/${this.repository.repo}/pulls/${number}/reviews?per_page=100`);
  }

  async listCommitChecks(sha) {
    if (!sha) return { statuses: [], checkRuns: [] };
    const [{ data: statusData }, { data: checkRunData }] = await Promise.all([
      this.request("GET", `/repos/${this.repository.owner}/${this.repository.repo}/commits/${sha}/status`),
      this.request("GET", `/repos/${this.repository.owner}/${this.repository.repo}/commits/${sha}/check-runs?per_page=100`),
    ]);
    return {
      statuses: statusData.statuses || [],
      checkRuns: checkRunData.check_runs || [],
    };
  }

  async mergePullRequest(number, { method, sha }) {
    const { data } = await this.request("PUT", `/repos/${this.repository.owner}/${this.repository.repo}/pulls/${number}/merge`, {
      body: {
        merge_method: method,
        sha,
      },
    });
    return data;
  }

  async getBranchSha(branch) {
    const ref = encodeURIComponent(`heads/${branch}`).replace(/%2F/g, "/");
    const { data } = await this.request("GET", `/repos/${this.repository.owner}/${this.repository.repo}/git/ref/${ref}`);
    return data.object?.sha || "";
  }

  async graphql(query, variables = {}) {
    const { data } = await this.request("POST", "/graphql", {
      body: { query, variables },
    });
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const error = new Error(data.errors.map((entry) => entry.message).filter(Boolean).join("; ") || "GitHub GraphQL request failed");
      error.data = data;
      throw error;
    }
    return data?.data || {};
  }

  async getMergeQueueState(branch) {
    const data = await this.graphql(
      `query BuildchainMergeQueueState($owner: String!, $repo: String!, $branch: String!) {
        repository(owner: $owner, name: $repo) {
          mergeQueue(branch: $branch) {
            id
            entries(first: 100) {
              nodes {
                id
                position
                state
                baseCommit { oid }
                headCommit { oid }
                pullRequest { number headRefOid }
              }
            }
          }
        }
      }`,
      {
        owner: this.repository.owner,
        repo: this.repository.repo,
        branch,
      },
    );
    const queue = data.repository?.mergeQueue || null;
    return {
      enabled: Boolean(queue),
      id: queue?.id || "",
      entries: (queue?.entries?.nodes || []).map((entry) => ({
        id: entry.id || "",
        position: entry.position,
        state: entry.state || "",
        pullRequestNumber: entry.pullRequest?.number || null,
        pullRequestHeadSha: entry.pullRequest?.headRefOid || "",
        baseSha: entry.baseCommit?.oid || "",
        headSha: entry.headCommit?.oid || "",
      })),
    };
  }

  async enqueuePullRequest({ pullRequestId, expectedHeadOid }) {
    const data = await this.graphql(
      `mutation BuildchainEnqueuePullRequest($input: EnqueuePullRequestInput!) {
        enqueuePullRequest(input: $input) {
          mergeQueueEntry {
            id
            position
            state
            baseCommit { oid }
            headCommit { oid }
            pullRequest { number headRefOid }
          }
        }
      }`,
      {
        input: {
          pullRequestId,
          expectedHeadOid,
        },
      },
    );
    const entry = data.enqueuePullRequest?.mergeQueueEntry;
    if (!entry?.id) throw new Error("GitHub did not return a merge queue entry");
    return {
      id: entry.id,
      position: entry.position,
      state: entry.state || "",
      pullRequestNumber: entry.pullRequest?.number || null,
      pullRequestHeadSha: entry.pullRequest?.headRefOid || "",
      baseSha: entry.baseCommit?.oid || "",
      headSha: entry.headCommit?.oid || "",
    };
  }
}

function queuePredecessor(queueState, fallback = {}) {
  const entry = queueState?.entries?.[0];
  if (entry) {
    return {
      queueEntryId: entry.id,
      pullRequestNumber: entry.pullRequestNumber,
      headSha: entry.pullRequestHeadSha || entry.headSha || "",
      state: entry.state || "",
    };
  }
  return {
    queueEntryId: fallback.queueEntryId || "",
    pullRequestNumber: fallback.pullRequestNumber || null,
    headSha: fallback.headSha || "",
    state: fallback.state || "",
  };
}

function admissionReceipt({
  options,
  pr,
  expectedBaseSha,
  observedBaseSha,
  expectedHeadSha,
  observedHeadSha,
  decision,
  reason,
  checks,
  approval,
  predecessor,
} = {}) {
  return {
    schemaVersion: 1,
    contract: ADMISSION_CONTRACT,
    repository: options.repository.fullName,
    targetBranch: options.targetBranch,
    pullRequestNumber: pr.number,
    expectedBaseSha: expectedBaseSha || "",
    observedBaseSha: observedBaseSha || "",
    expectedHeadSha: expectedHeadSha || "",
    observedHeadSha: observedHeadSha || "",
    approvalRequired: options.requireApproval,
    approval: approval || { required: options.requireApproval, passed: false },
    checks: checks || { required: options.requiredChecks, entries: [], passed: false },
    decision,
    reason,
    predecessor: predecessor || null,
    finalSafetyBoundary: "github-merge-group",
  };
}

function evaluatedEntry(pr, decision) {
  return {
    number: pr.number,
    title: pr.title || "",
    headRef: pr.head?.ref || "",
    headSha: pr.head?.sha || "",
    action: decision.action,
    reason: decision.reason,
    checks: decision.checks,
  };
}

function blockRemainingPullRequests(result, pullRequests, startIndex, options, expectedBaseSha, predecessor) {
  for (const pr of pullRequests.slice(startIndex)) {
    const entry = evaluatedEntry(pr, {
      action: "skip",
      reason: "blocked-by-predecessor",
    });
    entry.admissionReceipt = admissionReceipt({
      options,
      pr,
      expectedBaseSha,
      observedBaseSha: expectedBaseSha,
      expectedHeadSha: pr.head?.sha || "",
      observedHeadSha: pr.head?.sha || "",
      decision: "blocked",
      reason: "blocked-by-predecessor",
      predecessor,
    });
    result.evaluated.push(entry);
    result.skipped.push(entry);
  }
}

export async function runDevPrAutoMerge(optionsInput = {}, clientInput) {
  const options = normalizeOptions(optionsInput);
  if (!options.targetBranch) throw new Error("target branch is required");
  const client = clientInput || new GitHubClient({
    token: optionsInput.token || process.env.GITHUB_TOKEN,
    repository: options.repository,
    apiUrl: optionsInput.apiUrl || process.env.GITHUB_API_URL || "https://api.github.com",
  });

  const [pullRequests, initialBaseSha, initialQueueState] = await Promise.all([
    client.listPullRequests(options.targetBranch),
    client.getBranchSha(options.targetBranch).catch(() => ""),
    client.getMergeQueueState(options.targetBranch),
  ]);
  const landingMode = initialQueueState.enabled ? "queue" : options.landingMode === "queue" ? "queue" : "direct";
  const orderedPullRequests = landingMode === "queue"
    ? [...pullRequests].sort((left, right) => Number(left.number) - Number(right.number))
    : pullRequests;
  const result = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-dev-pr-auto-merge",
    repository: options.repository.fullName,
    targetBranch: options.targetBranch,
    requestedLandingMode: options.landingMode,
    landingMode,
    dryRun: options.dryRun,
    maxMerges: options.maxMerges,
    evaluated: [],
    actions: [],
    merged: [],
    enqueued: [],
    skipped: [],
    initialBaseSha,
    finalBaseSha: initialBaseSha,
    mergeQueue: initialQueueState,
  };

  if (landingMode === "queue" && !initialQueueState.enabled) {
    blockRemainingPullRequests(result, orderedPullRequests, 0, options, initialBaseSha, null);
    for (const entry of result.evaluated) {
      entry.reason = "merge-queue-not-enabled";
      entry.admissionReceipt.reason = "merge-queue-not-enabled";
      entry.admissionReceipt.decision = "rejected";
    }
    return result;
  }

  if (landingMode === "queue" && initialQueueState.entries.length > 0) {
    blockRemainingPullRequests(result, orderedPullRequests, 0, options, initialBaseSha, queuePredecessor(initialQueueState));
    return result;
  }

  for (let index = 0; index < orderedPullRequests.length; index += 1) {
    const pr = orderedPullRequests[index];
    if (result.merged.length >= options.maxMerges) {
      const entry = { number: pr.number, title: pr.title || "", action: "skip", reason: "max-merges-reached" };
      result.evaluated.push(entry);
      result.skipped.push(entry);
      continue;
    }

    const decision = await evaluatePullRequest(pr, options, client);
    const entry = evaluatedEntry(pr, decision);
    result.evaluated.push(entry);

    if (landingMode === "direct" && decision.action === "merge") {
      const mergeResult = await client.mergePullRequest(pr.number, {
        method: options.mergeMethod,
        sha: pr.head?.sha,
      });
      const mergedEntry = { ...entry, mergeSha: mergeResult.sha || "" };
      result.merged.push(mergedEntry);
      result.actions.push(mergedEntry);
      result.evaluated[result.evaluated.length - 1] = mergedEntry;
    } else if (landingMode === "direct" && decision.action === "would-merge") {
      result.merged.push(entry);
      result.actions.push(entry);
    } else if (landingMode === "direct" || STATIC_SKIP_REASONS.has(decision.reason)) {
      result.skipped.push(entry);
    } else if (decision.action === "skip") {
      entry.admissionReceipt = admissionReceipt({
        options,
        pr,
        expectedBaseSha: initialBaseSha,
        observedBaseSha: initialBaseSha,
        expectedHeadSha: decision.observedHeadSha || pr.head?.sha || "",
        observedHeadSha: decision.observedHeadSha || pr.head?.sha || "",
        decision: "rejected",
        reason: decision.reason,
        checks: decision.checks,
        approval: decision.approval,
      });
      result.skipped.push(entry);
      blockRemainingPullRequests(result, orderedPullRequests, index + 1, options, initialBaseSha, queuePredecessor(null, {
        pullRequestNumber: pr.number,
        headSha: decision.observedHeadSha || pr.head?.sha || "",
        state: "ADMISSION_REJECTED",
      }));
      break;
    } else {
      const expectedHeadSha = decision.observedHeadSha || pr.head?.sha || "";
      const [observedPullRequest, observedBaseSha, observedQueueState] = await Promise.all([
        client.getPullRequest(pr.number, {
          attempts: options.pollMergeableAttempts,
          delayMs: options.pollMergeableDelayMs,
        }),
        client.getBranchSha(options.targetBranch),
        client.getMergeQueueState(options.targetBranch),
      ]);
      const observedHeadSha = observedPullRequest.head?.sha || "";
      let admissionDecision = options.dryRun ? "planned" : "accepted";
      let admissionReason = options.dryRun ? "dry-run" : "eligible";
      let predecessor = null;
      if (observedQueueState.entries.length > 0) {
        admissionDecision = "blocked";
        admissionReason = "blocked-by-predecessor";
        predecessor = queuePredecessor(observedQueueState);
      } else if (observedBaseSha !== initialBaseSha) {
        admissionDecision = "rejected";
        admissionReason = "base-sha-drift";
      } else if (observedHeadSha !== expectedHeadSha) {
        admissionDecision = "rejected";
        admissionReason = "head-sha-drift";
      } else if (!mergeableAccepted(observedPullRequest)) {
        admissionDecision = "rejected";
        admissionReason = "not-mergeable-on-admission-recheck";
      }

      entry.action = admissionDecision === "planned" ? "would-enqueue" : admissionDecision === "accepted" ? "enqueue" : "skip";
      entry.reason = admissionReason;
      entry.headSha = expectedHeadSha;
      entry.admissionReceipt = admissionReceipt({
        options,
        pr,
        expectedBaseSha: initialBaseSha,
        observedBaseSha,
        expectedHeadSha,
        observedHeadSha,
        decision: admissionDecision,
        reason: admissionReason,
        checks: decision.checks,
        approval: decision.approval,
        predecessor,
      });

      if (admissionDecision === "planned") {
        result.actions.push(entry);
      } else if (admissionDecision === "accepted") {
        if (!decision.pullRequestId) {
          entry.action = "skip";
          entry.reason = "missing-pull-request-node-id";
          entry.admissionReceipt.decision = "rejected";
          entry.admissionReceipt.reason = entry.reason;
          result.skipped.push(entry);
        } else {
          try {
            const queueEntry = await client.enqueuePullRequest({
              pullRequestId: decision.pullRequestId,
              expectedHeadOid: expectedHeadSha,
            });
            entry.action = "enqueued";
            entry.reason = "enqueued-with-expected-head";
            entry.queueEntry = queueEntry;
            entry.admissionReceipt.reason = entry.reason;
            result.actions.push(entry);
            result.enqueued.push(entry);
          } catch (error) {
            entry.action = "skip";
            entry.reason = "enqueue-rejected";
            entry.enqueueError = {
              status: error.status || null,
              message: error.message || "GitHub rejected merge queue admission",
            };
            entry.admissionReceipt.decision = "rejected";
            entry.admissionReceipt.reason = entry.reason;
            result.skipped.push(entry);
          }
        }
      } else {
        result.skipped.push(entry);
      }

      const activePredecessor = queuePredecessor(null, {
        queueEntryId: entry.queueEntry?.id || predecessor?.queueEntryId || "",
        pullRequestNumber: pr.number,
        headSha: expectedHeadSha,
        state: entry.queueEntry?.state || (admissionDecision === "planned" ? "ADMISSION_PLANNED" : "ADMISSION_REJECTED"),
      });
      blockRemainingPullRequests(result, orderedPullRequests, index + 1, options, observedBaseSha || initialBaseSha, activePredecessor);
      break;
    }
  }

  result.finalBaseSha = await client.getBranchSha(options.targetBranch).catch(() => "");
  return result;
}

export function renderMarkdownSummary(result) {
  const lines = [
    "## Buildchain dev PR auto-merge",
    "",
    `Repository: \`${result.repository}\``,
    `Target branch: \`${result.targetBranch}\``,
    `Landing mode: \`${result.landingMode}\``,
    `Execution: \`${result.dryRun ? "dry-run" : "apply"}\``,
    `Evaluated PRs: ${result.evaluated.length}`,
    `Actions ${result.dryRun ? "planned" : "taken"}: ${result.actions.length}`,
    "",
    "| PR | Action | Reason | Head |",
    "| --- | --- | --- | --- |",
  ];
  for (const entry of result.evaluated) {
    lines.push(`| #${entry.number} | ${entry.action} | ${entry.reason} | \`${entry.headRef || ""}\` |`);
  }
  if (result.evaluated.length === 0) lines.push("| - | skip | no open pull requests | - |");
  if (!result.dryRun && result.finalBaseSha) {
    lines.push("", `Final target branch SHA: \`${result.finalBaseSha}\``);
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
  const options = normalizeOptions({
    repository: process.env.BUILDCHAIN_DEV_PR_REPOSITORY || process.env.GITHUB_REPOSITORY,
    targetBranch: process.env.BUILDCHAIN_DEV_PR_TARGET_BRANCH || process.env.GITHUB_REF_NAME,
    readyLabel: process.env.BUILDCHAIN_DEV_PR_READY_LABEL,
    blockLabels: process.env.BUILDCHAIN_DEV_PR_BLOCK_LABELS,
    allowedHeadPrefixes: process.env.BUILDCHAIN_DEV_PR_ALLOWED_HEAD_PREFIXES,
    requiredChecks: process.env.BUILDCHAIN_DEV_PR_REQUIRED_CHECKS,
    requireApproval: process.env.BUILDCHAIN_DEV_PR_REQUIRE_APPROVAL,
    sameRepositoryOnly: process.env.BUILDCHAIN_DEV_PR_SAME_REPOSITORY_ONLY,
    maxMerges: process.env.BUILDCHAIN_DEV_PR_MAX_MERGES,
    mergeMethod: process.env.BUILDCHAIN_DEV_PR_MERGE_METHOD,
    landingMode: process.env.BUILDCHAIN_DEV_PR_LANDING_MODE,
    dryRun: process.env.BUILDCHAIN_DEV_PR_DRY_RUN,
    outputPath: process.env.BUILDCHAIN_DEV_PR_OUTPUT_PATH,
  });
  const result = await runDevPrAutoMerge(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = renderMarkdownSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  writeGitHubOutputs({
    "evaluated-count": result.evaluated.length,
    "merged-count": result.merged.length,
    "enqueued-count": result.enqueued.length,
    "action-count": result.actions.length,
    "skipped-count": result.skipped.length,
    "final-base-sha": result.finalBaseSha,
    "result-path": options.outputPath,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

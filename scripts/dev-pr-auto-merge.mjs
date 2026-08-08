#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { verifyProjectCutReplayProof } from "../packages/core/dev-delivery-warrant.js";
import { admitExistingQueueEntry, createDevPrAdmissionReceipt, readDeliveryWarrantResult, runSourceQualification, runTargetedQueueAdmission } from "./dev-pr-delivery-warrant.mjs";
const DEFAULT_BLOCK_LABELS = ["blocked", "do-not-merge", "work-in-progress"];
const DEFAULT_ALLOWED_HEAD_PREFIXES = ["feature/", "fix/", "chore/", "docs/", "ci/", "refactor/"];
const DEFAULT_REQUIRED_CHECKS = ["check"];
const DEFAULT_READY_LABEL = "ready";
const SUCCESS_STATES = new Set(["success"]);
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const VALID_LANDING_MODES = new Set(["auto", "direct", "queue"]);
const VALID_WARRANT_MODES = new Set(["off", "required"]);
const STATIC_SKIP_REASONS = new Set(["draft", "fork-or-cross-repository-head", "head-prefix-not-allowed", "missing-ready-label", "blocked-label"]);
const ADMISSION_CONTRACT = "kungfu-buildchain-dev-merge-queue-admission";
const AGENT_ADMISSION_RESULT_SCHEMA = "kungfu.buildchain.dev-pr-admission-result/v1";
const AGENT_ADMISSION_MARKER = "buildchain-dev-pr-admission:v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

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

function positiveIntOption(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
    readyLabel: String(options.readyLabel || DEFAULT_READY_LABEL).trim(),
    blockLabels: splitList(options.blockLabels, DEFAULT_BLOCK_LABELS).map((label) => label.toLowerCase()),
    allowedHeadPrefixes: splitList(options.allowedHeadPrefixes, DEFAULT_ALLOWED_HEAD_PREFIXES),
    requiredChecks: splitList(options.requiredChecks, DEFAULT_REQUIRED_CHECKS),
    queueAdmissionContext: String(options.queueAdmissionContext || "").trim(),
    requireApproval: boolOption(options.requireApproval, true),
    sameRepositoryOnly: boolOption(options.sameRepositoryOnly, true),
    maxMerges: intOption(options.maxMerges, 1),
    mergeMethod: String(options.mergeMethod || "merge").trim(),
    landingMode: choiceOption(options.landingMode, VALID_LANDING_MODES, "auto", "landing mode"),
    dryRun: boolOption(options.dryRun, true),
    pollMergeableAttempts: intOption(options.pollMergeableAttempts, 3),
    pollMergeableDelayMs: intOption(options.pollMergeableDelayMs, 1000),
    outputPath: String(options.outputPath || ".buildchain/dev-pr-auto-merge/result.json"),
    targetPullRequestNumber: positiveIntOption(options.targetPullRequestNumber, 0),
    expectedHeadSha: String(options.expectedHeadSha || "").trim().toLowerCase(),
    diagnosticContext: String(options.diagnosticContext || "Buildchain delivery intent").trim(),
    warrantMode: choiceOption(options.warrantMode, VALID_WARRANT_MODES, "off", "delivery Warrant mode"),
    warrantResultPath: String(options.warrantResultPath || "").trim(),
    projectCutProofPath: String(options.projectCutProofPath || "").trim(),
    sourcePatchRoot: String(options.sourcePatchRoot || "").trim().toLowerCase(),
    qualificationOnly: boolOption(options.qualificationOnly, false),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function contentRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(`${JSON.stringify(stableValue(value))}\n`).digest("hex")}`;
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

function mergeableAccepted(pr, landingMode = "direct", projectCutQualified = false) {
  if (pr.mergeable === false) return false;
  const state = String(pr.mergeable_state || pr.mergeStateStatus || "").toLowerCase();
  return state ? ["clean", "has_hooks", "unstable", "unknown", ...(landingMode === "queue" && pr.mergeable === true ? ["blocked", ...(projectCutQualified ? ["behind"] : [])] : [])].includes(state) : pr.mergeable === true;
}

async function projectCutQualification(pr, options, client) {
  if (!options.projectCutProofPath) return { ok: false, reason: "project-cut-proof-required" };
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(options.projectCutProofPath, "utf8"));
  } catch {
    return { ok: false, reason: "project-cut-proof-invalid" };
  }
  const currentBase = await client.getBranchSha(options.targetBranch).catch(() => "");
  const verification = verifyProjectCutReplayProof(proof, {
    repository: options.repository.fullName,
    protectedBase: options.targetBranch,
    pullRequestNumber: Number(pr.number),
    sourceHead: String(pr.head?.sha || "").toLowerCase(),
    ...(options.sourcePatchRoot ? { sourcePatchRoot: options.sourcePatchRoot } : {}),
    currentBase,
  });
  return verification.ok
    ? { ok: true, reason: verification.reason, proofRoot: verification.proofRoot, currentBase }
    : { ok: false, reason: `project-cut-${verification.reason}`, currentBase };
}
async function setQueueAdmissionStatus(client, repository, sha, context, state) {
  if (!context) return null;
  await client.request("POST", `/repos/${repository.owner}/${repository.repo}/statuses/${sha}`, { body: { state, context, description: state === "success" ? "Buildchain admitted this exact PR head to the merge queue" : "Buildchain rejected merge queue admission for this exact PR head" } });
  return { context, state, sha };
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
  const mergeableState = String(detailed.mergeable_state || detailed.mergeStateStatus || "").toLowerCase();
  const projectCut = mergeableState === "behind" && options.landingMode === "queue"
    ? await projectCutQualification(detailed, options, client)
    : null;
  if (projectCut && !projectCut.ok) return skip(projectCut.reason, { projectCut });
  if (!mergeableAccepted(detailed, options.landingMode, projectCut?.ok === true)) {
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
    projectCut,
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

  async addLabels(number, labels) {
    const { data } = await this.request(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/labels`,
      { body: { labels } },
    );
    return data;
  }

  async listIssueComments(number) {
    return this.paginate(`/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/comments?per_page=100`);
  }

  async createIssueComment(number, body) {
    const { data } = await this.request(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/${number}/comments`,
      { body: { body } },
    );
    return data;
  }

  async updateIssueComment(commentId, body) {
    const { data } = await this.request(
      "PATCH",
      `/repos/${this.repository.owner}/${this.repository.repo}/issues/comments/${commentId}`,
      { body: { body } },
    );
    return data;
  }

  async setCommitStatus(sha, { state, context, description, targetUrl = "" }) {
    const { data } = await this.request(
      "POST",
      `/repos/${this.repository.owner}/${this.repository.repo}/statuses/${sha}`,
      { body: { state, context, description, target_url: targetUrl } },
    );
    return data;
  }
}

function ghJson(args, { input } = {}) {
  const ghEnvironment = { ...process.env };
  delete ghEnvironment.GITHUB_TOKEN;
  delete ghEnvironment.GH_TOKEN;
  const result = spawnSync("gh", args, { encoding: "utf8", input, env: ghEnvironment });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error((result.stderr || result.stdout || "gh command failed").trim());
    error.status = result.status;
    throw error;
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

export class GhCliClient extends GitHubClient {
  constructor({ repository } = {}) {
    super({ token: "gh-cli", repository, fetchImpl: async () => { throw new Error("unexpected fetch"); } });
  }

  async request(method, requestPath, { body } = {}) {
    const endpoint = requestPath.replace(/^https:\/\/api\.github\.com/, "");
    const args = ["api", "--method", method, endpoint];
    if (body !== undefined) args.push("--input", "-");
    return {
      data: ghJson(args, { input: body === undefined ? undefined : `${JSON.stringify(body)}\n` }),
      response: { headers: { get: () => "" } },
    };
  }

  async paginate(requestPath) {
    return ghJson(["api", "--paginate", requestPath, "--slurp"]).flatMap((page) => page);
  }

  async getMergeQueueState(branch) {
    const query = `query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){id entries(first:100){nodes{id position state baseCommit{oid} headCommit{oid} pullRequest{number headRefOid}}}}}}`;
    const data = ghJson([
      "api", "graphql", "-f", `query=${query}`,
      "-f", `owner=${this.repository.owner}`,
      "-f", `repo=${this.repository.repo}`,
      "-f", `branch=${branch}`,
    ]).data;
    const queue = data?.repository?.mergeQueue || null;
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
    const query = `mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{id position state baseCommit{oid} headCommit{oid} pullRequest{number headRefOid}}}}`;
    const data = ghJson([
      "api", "graphql", "-f", `query=${query}`,
      "-f", `id=${pullRequestId}`,
      "-f", `head=${expectedHeadOid}`,
    ]).data;
    const entry = data?.enqueuePullRequest?.mergeQueueEntry;
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
  projectCut,
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
    projectCut: projectCut || null,
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

function admissionStateFor(entry = {}) {
  if (["enqueued", "merged"].includes(entry.action)) return "queued";
  if (["would-enqueue", "would-merge", "merge"].includes(entry.action)) return "ready";
  if (entry.reason === "missing-approval") return "waiting-approval";
  if (entry.reason === "required-checks-not-passing") return "waiting-checks";
  if (entry.reason === "blocked-by-predecessor") return "waiting-queue";
  if (["head-sha-drift", "base-branch-drift", "base-sha-drift"].includes(entry.reason)) return "stale";
  if (["blocked-label", "fork-or-cross-repository-head"].includes(entry.reason)) return "blocked";
  return "rejected";
}

function nextAdmissionAction({ options, state, reason, observedHeadSha = "" }) {
  const command = [
    "buildchain dev pr-admit",
    `--repository ${options.repository.fullName}`,
    `--branch ${options.targetBranch}`,
    `--pull-request ${options.targetPullRequestNumber}`,
    `--expected-head ${observedHeadSha || options.expectedHeadSha}`,
    "--execute",
  ].join(" ");
  if (state === "queued") return `Monitor PR #${options.targetPullRequestNumber} and its native merge-group checks.`;
  if (state === "waiting-approval") return `Obtain an independent approval, then rerun: ${command}`;
  if (state === "waiting-checks") return `Wait for or repair required checks, then rerun: ${command}`;
  if (state === "waiting-queue") return `Wait for the active queue predecessor to finish, then rerun: ${command}`;
  if (state === "stale") return `Re-read the PR head and rerun with that exact SHA: ${command}`;
  if (reason === "missing-ready-label") return `Declare the exact delivery intent by running: ${command}`;
  if (state === "ready") return options.dryRun ? `Apply the reviewed plan: ${command}` : "Continue with native merge-group qualification.";
  return `Inspect reason ${reason || "unknown"}, repair it, and rerun the exact-head command.`;
}

function diagnosticState(state) {
  if (["ready", "queued"].includes(state)) return "success";
  if (["waiting-approval", "waiting-checks", "waiting-queue"].includes(state)) return "pending";
  return "failure";
}

function renderAdmissionComment(receipt, receiptRoot) {
  const marker = `<!-- ${AGENT_ADMISSION_MARKER} pr=${receipt.pullRequestNumber} head=${receipt.expectedHeadSha} -->`;
  return [
    marker,
    "## Buildchain dev PR admission",
    "",
    `- State: \`${receipt.state}\``,
    `- Reason: \`${receipt.reason}\``,
    `- Exact head: \`${receipt.expectedHeadSha}\``,
    `- Readiness: \`${receipt.readiness.observed ? "present" : "missing"}\` (\`${receipt.readiness.label || "policy-equivalent"}\`)`,
    `- Receipt root: \`${receiptRoot}\``,
    `- Next action: ${receipt.nextAction}`,
    "",
    "GitHub auto-merge state is observed evidence only; it is not Buildchain admission authority.",
  ].join("\n");
}

async function publishAdmissionDiagnostic(client, options, receipt, receiptRoot) {
  const marker = `<!-- ${AGENT_ADMISSION_MARKER} pr=${receipt.pullRequestNumber} head=${receipt.expectedHeadSha} -->`;
  const body = renderAdmissionComment(receipt, receiptRoot);
  const comments = await client.listIssueComments(receipt.pullRequestNumber);
  const existing = comments.find((comment) => String(comment.body || "").includes(marker));
  const comment = existing
    ? await client.updateIssueComment(existing.id, body)
    : await client.createIssueComment(receipt.pullRequestNumber, body);
  let status = null;
  if (receipt.expectedHeadSha === receipt.observedHeadSha) {
    status = await client.setCommitStatus(receipt.expectedHeadSha, {
      state: diagnosticState(receipt.state),
      context: options.diagnosticContext,
      description: `${receipt.state}: ${receipt.reason}`.slice(0, 140),
      targetUrl: receipt.pullRequestUrl,
    });
  }
  return { commentId: comment?.id || null, commentUrl: comment?.html_url || "", statusPublished: Boolean(status) };
}

function createAdmissionReceipt({ options, pr = {}, state, reason, readiness, decision = {}, queue = null, warrant = null }) {
  return createDevPrAdmissionReceipt({ options, pr, state, reason, readiness, decision, queue, warrant, labels: labelsOf(pr), nextAction: nextAdmissionAction });
}

function targetedFailure({ options, pr, state, reason, readiness, decision, queue }) {
  const receipt = createAdmissionReceipt({ options, pr, state, reason, readiness, decision, queue });
  return {
    schema: AGENT_ADMISSION_RESULT_SCHEMA,
    ok: false,
    mode: options.dryRun ? "plan" : "execute",
    outcome: "targeted-admission-failed",
    receipt,
    receiptRoot: contentRoot(receipt),
    diagnostic: null,
  };
}

export async function runDevPrAdmission(optionsInput = {}, clientInput) {
  const options = normalizeOptions(optionsInput);
  if (!options.targetBranch) throw new Error("target branch is required");
  if (!options.targetPullRequestNumber) throw new Error("pull request number is required");
  if (!SHA_PATTERN.test(options.expectedHeadSha)) throw new Error("expected head must be an exact 40-character lowercase Git SHA");
  const client = clientInput || (optionsInput.useGhCli || !process.env.GITHUB_TOKEN
    ? new GhCliClient({ repository: options.repository })
    : new GitHubClient({
      token: optionsInput.token || process.env.GITHUB_TOKEN,
      repository: options.repository,
      apiUrl: optionsInput.apiUrl || process.env.GITHUB_API_URL || "https://api.github.com",
    }));

  let pr;
  try {
    pr = await client.getPullRequest(options.targetPullRequestNumber, {
      attempts: options.pollMergeableAttempts,
      delayMs: options.pollMergeableDelayMs,
    });
  } catch (error) {
    return targetedFailure({ options, pr: {}, state: "missing", reason: "pull-request-not-found" });
  }

  const reject = async (state, reason, readiness = { observed: hasReadyLabel(pr, options.readyLabel), established: false }) => {
    const result = targetedFailure({ options, pr, state, reason, readiness });
    if (!options.dryRun) result.diagnostic = await publishAdmissionDiagnostic(client, options, result.receipt, result.receiptRoot);
    return result;
  };
  if (String(pr.state || "open").toLowerCase() !== "open") return reject("rejected", "pull-request-not-open");
  if (pr.base?.ref !== options.targetBranch) return reject("stale", "base-branch-drift");
  if (String(pr.head?.sha || "").toLowerCase() !== options.expectedHeadSha) return reject("stale", "head-sha-drift");
  if (!sameRepositoryAllowed(pr, options.repository, options.sameRepositoryOnly)) return reject("blocked", "fork-or-cross-repository-head");
  if (hasBlockedLabel(pr, options.blockLabels)) return reject("blocked", "blocked-label");
  if (pr.draft) return reject("blocked", "draft");
  if (!headPrefixAllowed(pr, options.allowedHeadPrefixes)) return reject("blocked", "head-prefix-not-allowed");

  let readiness = { observed: hasReadyLabel(pr, options.readyLabel), established: false };
  if (!readiness.observed) {
    if (options.dryRun) return reject("rejected", "missing-ready-label", readiness);
    await client.addLabels(pr.number, [options.readyLabel]);
    const readback = await client.getPullRequest(pr.number, {
      attempts: options.pollMergeableAttempts,
      delayMs: options.pollMergeableDelayMs,
    });
    if (String(readback.head?.sha || "").toLowerCase() !== options.expectedHeadSha) {
      pr = readback;
      return reject("stale", "head-sha-drift-after-readiness-write", readiness);
    }
    if (readback.base?.ref !== options.targetBranch) {
      pr = readback;
      return reject("stale", "base-branch-drift-after-readiness-write", readiness);
    }
    pr = readback;
    readiness = { observed: hasReadyLabel(pr, options.readyLabel), established: true };
    if (!readiness.observed) return reject("rejected", "readiness-readback-failed", readiness);
  }

  if (options.qualificationOnly) {
    return runSourceQualification({
      options, pullRequest: pr, readiness, client, reject,
      evaluate: evaluatePullRequest,
      admissionState: admissionStateFor,
      createReceipt: createAdmissionReceipt,
      root: contentRoot,
      publishDiagnostic: publishAdmissionDiagnostic,
    });
  }

  const initialQueue = await client.getMergeQueueState(options.targetBranch);
  let warrant = null;
  try {
    warrant = readDeliveryWarrantResult(options, pr);
  } catch (error) {
    return reject("blocked", error.code || "invalid-delivery-warrant");
  }
  const matchingEntry = initialQueue.entries.find((entry) =>
    entry.pullRequestNumber === pr.number && entry.pullRequestHeadSha === options.expectedHeadSha);
  const existing = await admitExistingQueueEntry({
    options, pullRequest: pr, readiness, client, entry: matchingEntry, warrant,
    createReceipt: createAdmissionReceipt,
    root: contentRoot,
    publishDiagnostic: publishAdmissionDiagnostic,
  });
  if (existing) return existing;

  return runTargetedQueueAdmission({
    options, pullRequest: pr, readiness, client, warrant,
    runController: runDevPrAutoMerge,
    admissionState: admissionStateFor,
    createReceipt: createAdmissionReceipt,
    root: contentRoot,
    publishDiagnostic: publishAdmissionDiagnostic,
  });
}

function finalizePatrolResult(result) {
  result.runKind = "cadence-patrol";
  result.outcome = result.evaluated.length === 0
    ? "no-op-no-candidates"
    : result.actions.length === 0
      ? "no-op-all-skipped"
      : "actions-present";
  result.qualification = false;
  result.noOp = result.actions.length === 0;
  return result;
}

async function reconcileEnqueueError({ client, options, pr, expectedHeadSha, entry, result, error }) {
  const queueReadback = await client.getMergeQueueState(options.targetBranch).catch(() => null);
  const exactEntry = queueReadback?.entries?.find((candidate) =>
    candidate.pullRequestNumber === pr.number && candidate.pullRequestHeadSha === expectedHeadSha);
  if (exactEntry) {
    entry.action = "enqueued";
    entry.reason = "already-enqueued-exact-head";
    entry.queueEntry = exactEntry;
    entry.admissionReceipt.reason = entry.reason;
    result.actions.push(entry);
    result.enqueued.push(entry);
    return;
  }
  entry.queueAdmissionStatus = await setQueueAdmissionStatus(client, options.repository, expectedHeadSha, options.queueAdmissionContext, "failure");
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
  const orderedPullRequests = landingMode === "queue" ? [...pullRequests].sort((left, right) => Number(left.number) - Number(right.number)) : pullRequests;
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
    return finalizePatrolResult(result);
  }

  if (landingMode === "queue" && initialQueueState.entries.length > 0) {
    blockRemainingPullRequests(result, orderedPullRequests, 0, options, initialBaseSha, queuePredecessor(initialQueueState));
    return finalizePatrolResult(result);
  }

  for (let index = 0; index < orderedPullRequests.length; index += 1) {
    const pr = orderedPullRequests[index];
    if (result.merged.length >= options.maxMerges) {
      const entry = { number: pr.number, title: pr.title || "", action: "skip", reason: "max-merges-reached" };
      result.evaluated.push(entry);
      result.skipped.push(entry);
      continue;
    }

    const decision = await evaluatePullRequest(pr, { ...options, landingMode }, client);
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
        projectCut: decision.projectCut,
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
      } else if (!mergeableAccepted(observedPullRequest, landingMode, decision.projectCut?.ok === true)) {
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
        projectCut: decision.projectCut,
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
            entry.queueAdmissionStatus = await setQueueAdmissionStatus(client, options.repository, expectedHeadSha, options.queueAdmissionContext, "success");
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
            await reconcileEnqueueError({ client, options, pr, expectedHeadSha, entry, result, error });
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
  return finalizePatrolResult(result);
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

function cliValue(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function cliFlag(args, name) {
  return args.includes(`--${name}`);
}

export function cliOptions(args = [], environment = process.env) {
  const targetPullRequestNumber = cliValue(args, "pull-request", environment.BUILDCHAIN_DEV_PR_EXPECTED_PR_NUMBER);
  return {
    repository: cliValue(args, "repository", environment.BUILDCHAIN_DEV_PR_REPOSITORY || environment.GITHUB_REPOSITORY),
    targetBranch: cliValue(args, "branch", environment.BUILDCHAIN_DEV_PR_TARGET_BRANCH || environment.GITHUB_REF_NAME),
    targetPullRequestNumber,
    expectedHeadSha: cliValue(args, "expected-head", environment.BUILDCHAIN_DEV_PR_EXPECTED_HEAD_SHA),
    readyLabel: cliValue(args, "ready-label", environment.BUILDCHAIN_DEV_PR_READY_LABEL || DEFAULT_READY_LABEL),
    blockLabels: cliValue(args, "block-labels", environment.BUILDCHAIN_DEV_PR_BLOCK_LABELS),
    allowedHeadPrefixes: cliValue(args, "allowed-head-prefixes", environment.BUILDCHAIN_DEV_PR_ALLOWED_HEAD_PREFIXES),
    requiredChecks: cliValue(args, "required-checks", environment.BUILDCHAIN_DEV_PR_REQUIRED_CHECKS),
    queueAdmissionContext: cliValue(args, "queue-admission-context", environment.BUILDCHAIN_DEV_PR_QUEUE_ADMISSION_CONTEXT),
    diagnosticContext: cliValue(args, "diagnostic-context", environment.BUILDCHAIN_DEV_PR_DIAGNOSTIC_CONTEXT),
    warrantMode: cliValue(args, "warrant-mode", environment.BUILDCHAIN_DEV_PR_WARRANT_MODE),
    warrantResultPath: cliValue(args, "warrant-result", environment.BUILDCHAIN_DEV_PR_WARRANT_RESULT_PATH),
    projectCutProofPath: cliValue(args, "project-cut-proof", environment.BUILDCHAIN_DEV_PR_PROJECT_CUT_PROOF_PATH),
    sourcePatchRoot: cliValue(args, "source-patch-root", environment.BUILDCHAIN_DEV_PR_SOURCE_PATCH_ROOT),
    qualificationOnly: cliFlag(args, "qualification-only"),
    requireApproval: environment.BUILDCHAIN_DEV_PR_REQUIRE_APPROVAL,
    sameRepositoryOnly: environment.BUILDCHAIN_DEV_PR_SAME_REPOSITORY_ONLY,
    maxMerges: environment.BUILDCHAIN_DEV_PR_MAX_MERGES,
    mergeMethod: environment.BUILDCHAIN_DEV_PR_MERGE_METHOD,
    landingMode: cliValue(args, "landing-mode", environment.BUILDCHAIN_DEV_PR_LANDING_MODE),
    dryRun: cliFlag(args, "execute") ? false : environment.BUILDCHAIN_DEV_PR_DRY_RUN,
    outputPath: cliValue(
      args,
      "output",
      environment.BUILDCHAIN_DEV_PR_OUTPUT_PATH || (targetPullRequestNumber
        ? ".buildchain/dev-pr-admission/result.json"
        : ".buildchain/dev-pr-auto-merge/result.json"),
    ),
    useGhCli: cliFlag(args, "gh-cli"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (cliFlag(args, "help")) {
    process.stdout.write("Usage:\n  buildchain dev pr-admit --repository owner/repo --branch dev/vN/vN.M --pull-request N --expected-head SHA [--qualification-only] [--landing-mode auto|direct|queue] [--warrant-mode off|required] [--warrant-result FILE] [--execute] [--output FILE] [--json]\n");
    return;
  }
  const options = normalizeOptions(cliOptions(args));
  const targeted = options.targetPullRequestNumber > 0 || Boolean(options.expectedHeadSha);
  const result = targeted
    ? await runDevPrAdmission({ ...options, useGhCli: cliFlag(args, "gh-cli") })
    : await runDevPrAutoMerge(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = targeted ? `${renderAdmissionComment(result.receipt, result.receiptRoot)}\n` : renderMarkdownSummary(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else if (cliFlag(args, "json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(summary);
  writeGitHubOutputs({
    "evaluated-count": targeted ? 1 : result.evaluated.length,
    "merged-count": targeted ? Number(result.receipt.state === "merged") : result.merged.length,
    "enqueued-count": targeted ? Number(result.receipt.state === "queued") : result.enqueued.length,
    "action-count": targeted ? Number(result.ok) : result.actions.length,
    "skipped-count": targeted ? Number(!result.ok) : result.skipped.length,
    "final-base-sha": targeted ? "" : result.finalBaseSha,
    "targeted": targeted,
    "targeted-ok": targeted ? result.ok : "",
    "admission-state": targeted ? result.receipt.state : "",
    "receipt-root": targeted ? result.receiptRoot : "",
    "result-path": options.outputPath,
  });
  if (targeted && !result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

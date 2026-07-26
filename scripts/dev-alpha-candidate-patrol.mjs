#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { decideChannelCandidate } from "../packages/core/channel-candidate.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  return normalized;
}

function branch(value, name) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!normalized || normalized.startsWith("-") || /[\s~^:?*[\\]/.test(normalized)) {
    throw new Error(`${name} is not a valid branch name`);
  }
  return normalized;
}

function workflowPath(value, name) {
  const normalized = text(value);
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(normalized)) {
    throw new Error(`${name} must be a repository workflow path`);
  }
  return normalized;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeDevAlphaPatrolOptions(options = {}) {
  return {
    repository: repository(options.repository ?? process.env.BUILDCHAIN_CHANNEL_PATROL_REPOSITORY ?? process.env.GITHUB_REPOSITORY),
    sourceBranch: branch(options.sourceBranch ?? process.env.BUILDCHAIN_CHANNEL_PATROL_SOURCE_BRANCH ?? "dev/v4/v4.0", "sourceBranch"),
    targetBranch: branch(options.targetBranch ?? process.env.BUILDCHAIN_CHANNEL_PATROL_TARGET_BRANCH ?? "alpha/v4/v4.0", "targetBranch"),
    devWorkflowPath: workflowPath(options.devWorkflowPath ?? process.env.BUILDCHAIN_CHANNEL_PATROL_DEV_WORKFLOW ?? ".github/workflows/dev-verify-patrol.yml", "devWorkflowPath"),
    alphaWorkflowPath: workflowPath(options.alphaWorkflowPath ?? process.env.BUILDCHAIN_CHANNEL_PATROL_ALPHA_WORKFLOW ?? ".github/workflows/alpha-promotion-preflight.yml", "alphaWorkflowPath"),
    maxAgeSeconds: integer(options.maxAgeSeconds ?? process.env.BUILDCHAIN_CHANNEL_PATROL_MAX_AGE_SECONDS, 7 * 24 * 60 * 60),
    createPullRequest: bool(options.createPullRequest ?? process.env.BUILDCHAIN_CHANNEL_PATROL_CREATE_PR, false),
    dryRun: bool(options.dryRun ?? process.env.BUILDCHAIN_CHANNEL_PATROL_DRY_RUN, true),
    now: text(options.now ?? process.env.BUILDCHAIN_CHANNEL_PATROL_NOW) || new Date().toISOString(),
    outputPath: text(options.outputPath ?? process.env.BUILDCHAIN_CHANNEL_PATROL_OUTPUT_PATH) || ".buildchain/patrol/dev-alpha-candidate.json",
  };
}

function latestWorkflowEvidence(runs, workflowPathValue, sourceSha) {
  const matching = runs
    .filter((run) => run.path === workflowPathValue && run.head_sha === sourceSha)
    .sort((left, right) => Number(right.id) - Number(left.id));
  if (matching.length === 0) throw new Error(`missing completed same-SHA workflow run: ${workflowPathValue}`);
  const run = matching[0];
  return {
    workflowPath: workflowPathValue,
    workflowName: run.name,
    runId: run.id,
    runAttempt: run.run_attempt,
    headSha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    completedAt: run.updated_at,
    url: run.html_url,
  };
}

export async function runDevAlphaCandidatePatrol(optionsInput = {}, clientInput) {
  const options = normalizeDevAlphaPatrolOptions(optionsInput);
  if (options.sourceBranch === options.targetBranch) throw new Error("source and target branches must differ");
  const client = clientInput || createGitHubChannelCandidateClient({
    repository: options.repository,
    token: process.env.GITHUB_TOKEN,
  });
  const [sourceSha, targetSha] = await Promise.all([
    client.resolveBranch(options.sourceBranch),
    client.resolveBranch(options.targetBranch),
  ]);
  const comparison = await client.compare(targetSha, sourceSha);
  const requiredWorkflowPaths = [options.devWorkflowPath, options.alphaWorkflowPath];
  let workflowEvidence = [];
  if (comparison.status === "ahead" && Number(comparison.ahead_by) > 0) {
    const runs = await client.listCompletedRuns(sourceSha);
    workflowEvidence = requiredWorkflowPaths.map((workflow) =>
      latestWorkflowEvidence(runs, workflow, sourceSha),
    );
  }
  const decision = decideChannelCandidate({
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    targetBranch: options.targetBranch,
    sourceSha,
    targetSha,
    comparison: { status: comparison.status, aheadBy: comparison.ahead_by },
    workflowEvidence,
    requiredWorkflowPaths,
    maxAgeSeconds: options.maxAgeSeconds,
    now: options.now,
  });
  let pullRequest;
  if (decision.eligible && options.createPullRequest && !options.dryRun) {
    await client.ensureImmutableBranch(decision.sourceLockRef, sourceSha);
    pullRequest = await client.ensurePullRequest({
      head: decision.sourceLockRef,
      base: options.targetBranch,
      title: `Promote qualified ${options.sourceBranch} candidate ${sourceSha.slice(0, 12)} to ${options.targetBranch}`,
      body: [
        "Buildchain exact-source channel candidate.",
        "",
        `- Source branch: \`${options.sourceBranch}\``,
        `- Source SHA: \`${sourceSha}\``,
        `- Target branch/head: \`${options.targetBranch}\` / \`${targetSha}\``,
        `- Decision root: \`${decision.decisionRoot}\``,
        ...decision.workflowEvidence.map(
          (row) => `- ${row.workflowName}: [run ${row.runId} attempt ${row.runAttempt}](${row.url})`,
        ),
        "",
        "The source-lock branch must continue to point at the exact source SHA. This patrol never merges the PR, publishes a package, creates a tag, or creates a release.",
      ].join("\n"),
    });
  }
  return {
    schema: "kungfu-buildchain-dev-alpha-candidate-patrol/v1",
    dryRun: options.dryRun,
    createPullRequest: options.createPullRequest,
    decision,
    pullRequest: pullRequest || null,
  };
}

function encodeRef(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubChannelCandidateClient({ repository: repositoryInput, token, fetchImpl = globalThis.fetch }) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: token ? `Bearer ${token}` : undefined,
    "user-agent": "buildchain-dev-alpha-candidate-patrol",
    "x-github-api-version": "2022-11-28",
  };
  async function api(requestPath, { method = "GET", body, allow404 = false } = {}) {
    const response = await fetchImpl(`https://api.github.com${requestPath}`, {
      method,
      headers: Object.fromEntries(Object.entries(headers).filter(([, value]) => value)),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : undefined;
    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`);
    return payload;
  }
  return {
    async resolveBranch(ref) {
      const payload = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`);
      return text(payload.object?.sha);
    },
    async compare(baseSha, headSha) {
      return api(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`);
    },
    async listCompletedRuns(headSha) {
      const payload = await api(`/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&status=completed&per_page=100`);
      return payload.workflow_runs || [];
    },
    async ensureImmutableBranch(ref, sourceSha) {
      const current = await api(`/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`, { allow404: true });
      if (current && current.object?.sha !== sourceSha) {
        throw new Error(`source-lock branch ${ref} points to ${current.object?.sha}, not ${sourceSha}`);
      }
      if (current) return current;
      return api(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${ref}`, sha: sourceSha },
      });
    },
    async ensurePullRequest({ head, base, title, body }) {
      const open = await api(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=20`);
      return open[0] || api(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { head, base, title, body },
      });
    },
  };
}

function markdown(result) {
  return [
    "## Buildchain Dev to Alpha candidate patrol",
    "",
    `Eligible: \`${result.decision.eligible}\` (${result.decision.reason})`,
    `Source: \`${result.decision.source.branch}@${result.decision.source.sha}\``,
    `Target: \`${result.decision.target.branch}@${result.decision.target.sha}\``,
    `Dry run: \`${result.dryRun}\``,
    `Pull request: ${result.pullRequest?.html_url || "not created"}`,
    "",
  ].join("\n");
}

async function main() {
  const options = normalizeDevAlphaPatrolOptions();
  const result = await runDevAlphaCandidatePatrol(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = markdown(result);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      "result-path": options.outputPath,
      eligible: String(result.decision.eligible),
      "selected-sha": result.decision.source.sha,
      "source-lock-ref": result.decision.sourceLockRef || "",
      "promotion-pr": result.pullRequest?.html_url || "",
    };
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

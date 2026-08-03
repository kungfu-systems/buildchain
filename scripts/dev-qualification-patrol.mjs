#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXACT_SHA = /^[0-9a-f]{40}$/u;
const ACTIVE_STATUSES = new Set([
  "queued",
  "in_progress",
  "pending",
  "waiting",
  "requested",
]);
const RETRYABLE_CONCLUSIONS = new Set([
  "cancelled",
  "timed_out",
  "startup_failure",
]);
const RETRYABLE_STEP =
  /^(Checkout |Download |Upload |Setup |Expose |Reset prior Windows Gate source workspace)/u;
const DETERMINISTIC_STEP =
  /^(Run and validate Shifu Gate profile|Enforce Shifu Gate qualification|Aggregate Shifu Gate receipts|Enforce aggregate qualification|Create Shifu profile envelope controller receipt)/u;

function text(value = "") {
  return String(value ?? "").trim();
}
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}
function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) {
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  }
  return normalized;
}
function branch(value, name) {
  const normalized = text(value).replace(/^refs\/heads\//u, "");
  if (
    !normalized ||
    normalized.startsWith("-") ||
    /[\s~^:?*[\\]/u.test(normalized)
  ) {
    throw new Error(`${name} is not a valid branch name`);
  }
  return normalized;
}
function workflowPath(value, name) {
  const normalized = text(value);
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/u.test(normalized)) {
    throw new Error(`${name} must be a repository workflow path`);
  }
  return normalized;
}
function workflowPaths(value, name) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON array`);
  return [...new Set(parsed.map((item) => workflowPath(item, name)))];
}
function dispatchInputs(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("dispatchInputs must be a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, item]) => {
      if (!/^[A-Za-z0-9_-]+$/u.test(key))
        throw new Error(`invalid dispatch input ${key}`);
      if (!["string", "number", "boolean"].includes(typeof item)) {
        throw new Error(`dispatch input ${key} must be scalar`);
      }
      return [key, String(item)];
    }),
  );
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
function evidenceRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}
function newest(runs) {
  return [...runs].sort((left, right) => {
    const time = text(
      right.created_at || right.run_started_at || right.updated_at,
    ).localeCompare(
      text(left.created_at || left.run_started_at || left.updated_at),
    );
    return time || Number(right.id || 0) - Number(left.id || 0);
  })[0];
}
function runEvidence(run) {
  if (!run) return null;
  return {
    id: Number(run.id),
    attempt: Number(run.run_attempt || 1),
    headSha: text(run.head_sha),
    status: text(run.status),
    conclusion: text(run.conclusion),
    workflowPath: text(run.path),
    url: text(run.html_url),
  };
}
export function classifyRetryableFailure(run, jobs = []) {
  const conclusion = text(run?.conclusion);
  if (RETRYABLE_CONCLUSIONS.has(conclusion)) {
    return { retryable: true, reason: `run-${conclusion}` };
  }
  if (conclusion !== "failure") {
    return { retryable: false, reason: `run-${conclusion || "unknown"}` };
  }
  const failedJobs = jobs.filter((job) =>
    ["failure", "cancelled", "timed_out", "startup_failure"].includes(
      text(job.conclusion),
    ),
  );
  const rootJobs = failedJobs.some(
    (job) => !/Gate profile \/ aggregate$/u.test(text(job.name)),
  )
    ? failedJobs.filter(
        (job) => !/Gate profile \/ aggregate$/u.test(text(job.name)),
      )
    : failedJobs;
  if (rootJobs.length === 0) {
    return { retryable: true, reason: "runner-ended-without-failed-job" };
  }
  const failedSteps = rootJobs.flatMap((job) =>
    (job.steps || []).filter((step) => text(step.conclusion) === "failure"),
  );
  if (failedSteps.some((step) => DETERMINISTIC_STEP.test(text(step.name)))) {
    return { retryable: false, reason: "deterministic-qualification-step" };
  }
  if (
    failedSteps.length > 0 &&
    failedSteps.every((step) => RETRYABLE_STEP.test(text(step.name)))
  ) {
    return { retryable: true, reason: "external-boundary-step" };
  }
  if (
    failedSteps.length === 0 &&
    rootJobs.every((job) => RETRYABLE_CONCLUSIONS.has(text(job.conclusion)))
  ) {
    return { retryable: true, reason: "runner-job-interrupted" };
  }
  return { retryable: false, reason: "unclassified-failure" };
}
export function normalizeDevQualificationOptions(options = {}) {
  return {
    repository: repository(
      options.repository ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_REPOSITORY ??
        process.env.GITHUB_REPOSITORY,
    ),
    sourceBranch: branch(
      options.sourceBranch ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_SOURCE_BRANCH ??
        "dev/v4/v4.0",
      "sourceBranch",
    ),
    devWorkflowPath: workflowPath(
      options.devWorkflowPath ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_WORKFLOW ??
        ".github/workflows/dev-verify-patrol.yml",
      "devWorkflowPath",
    ),
    preflightWorkflowPath: workflowPath(
      options.preflightWorkflowPath ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_PREFLIGHT_WORKFLOW ??
        ".github/workflows/alpha-promotion-preflight.yml",
      "preflightWorkflowPath",
    ),
    priorityWorkflowPaths: workflowPaths(
      options.priorityWorkflowPaths ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_PRIORITY_WORKFLOWS ??
        "[]",
      "priorityWorkflowPaths",
    ),
    dispatchInputs: dispatchInputs(
      options.dispatchInputs ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_DISPATCH_INPUTS ??
        {},
    ),
    maxAttempts: integer(
      options.maxAttempts ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_MAX_ATTEMPTS,
      2,
    ),
    mutationAuthorized: bool(
      options.mutationAuthorized ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_MUTATION_AUTHORIZED,
      false,
    ),
    expectedAction: text(
      options.expectedAction ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_EXPECTED_ACTION,
    ),
    expectedSourceSha: text(
      options.expectedSourceSha ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_EXPECTED_SOURCE_SHA,
    ),
    outputPath: text(
      options.outputPath ??
        process.env.BUILDCHAIN_DEV_QUALIFICATION_OUTPUT_PATH ??
        ".buildchain/patrol/dev-qualification.json",
    ),
    now:
      text(options.now ?? process.env.BUILDCHAIN_DEV_QUALIFICATION_NOW) ||
      new Date().toISOString(),
  };
}
function decisionBody(options, fields) {
  const body = {
    schema: "kungfu-buildchain-dev-qualification-patrol/v1",
    repository: options.repository,
    sourceBranch: options.sourceBranch,
    observedAt: options.now,
    ...fields,
  };
  return { ...body, decisionRoot: evidenceRoot(body) };
}
function decideObservedState({
  sourceSha,
  latestExactRun,
  activeRun,
  successfulPreflight,
  priorityRuns,
}) {
  const common = {
    sourceSha,
    qualificationRun: runEvidence(latestExactRun),
    preflightRun: runEvidence(successfulPreflight),
  };
  if (
    latestExactRun?.status === "completed" &&
    latestExactRun?.conclusion === "success"
  ) {
    return {
      ...common,
      state: "qualified",
      action: "none",
      reason: "latest-source-already-qualified",
      pendingSha: null,
      activeRun: null,
      priorityRuns: priorityRuns.map(runEvidence),
    };
  }
  if (priorityRuns.length > 0) {
    return {
      ...common,
      state: "waiting-priority",
      action: "none",
      reason: "alpha-or-release-workflow-active",
      pendingSha: sourceSha,
      activeRun: runEvidence(activeRun),
      priorityRuns: priorityRuns.map(runEvidence),
    };
  }
  if (activeRun) {
    const activeIsLatest = text(activeRun.head_sha) === sourceSha;
    return {
      ...common,
      state: "running",
      action: "none",
      reason: activeIsLatest
        ? "latest-source-running"
        : "newer-source-coalesced",
      pendingSha: activeIsLatest ? null : sourceSha,
      activeRun: runEvidence(activeRun),
      priorityRuns: [],
    };
  }
  if (!successfulPreflight) {
    return {
      ...common,
      state: "waiting-preflight",
      action: "none",
      reason: "latest-source-preflight-not-qualified",
      pendingSha: sourceSha,
      activeRun: null,
      preflightRun: null,
      priorityRuns: [],
    };
  }
  if (
    latestExactRun?.status === "completed" &&
    latestExactRun?.conclusion !== "success"
  ) {
    return undefined;
  }
  return {
    ...common,
    state: "dispatch-ready",
    action: "dispatch",
    reason: "latest-source-preflight-qualified",
    pendingSha: sourceSha,
    activeRun: null,
    qualificationRun: null,
    priorityRuns: [],
  };
}
async function decideFailedRun({
  options,
  client,
  sourceSha,
  latestExactRun,
  successfulPreflight,
}) {
  const jobs = await client.listRunJobs(
    latestExactRun.id,
    latestExactRun.run_attempt || 1,
  );
  const classification = classifyRetryableFailure(latestExactRun, jobs);
  const attempt = Number(latestExactRun.run_attempt || 1);
  const retryReady = classification.retryable && attempt < options.maxAttempts;
  return {
    state: retryReady ? "retry-ready" : "blocked",
    action: retryReady ? "rerun-failed-jobs" : "none",
    reason:
      classification.retryable && !retryReady
        ? "bounded-retry-exhausted"
        : classification.reason,
    sourceSha,
    pendingSha: retryReady ? sourceSha : null,
    activeRun: null,
    qualificationRun: runEvidence(latestExactRun),
    preflightRun: runEvidence(successfulPreflight),
    priorityRuns: [],
    retryClassification: classification,
  };
}
export async function runDevQualificationPatrol(
  optionsInput = {},
  clientInput,
) {
  const options = normalizeDevQualificationOptions(optionsInput);
  const client =
    clientInput ||
    createGitHubDevQualificationClient({
      repository: options.repository,
      token: process.env.GITHUB_TOKEN,
    });
  const [sourceSha, devRuns, preflightRuns, ...priorityRunSets] =
    await Promise.all([
      client.resolveBranch(options.sourceBranch),
      client.listWorkflowRuns(options.devWorkflowPath, options.sourceBranch),
      client.listWorkflowRuns(
        options.preflightWorkflowPath,
        options.sourceBranch,
      ),
      ...options.priorityWorkflowPaths.map((workflow) =>
        client.listWorkflowRuns(workflow, undefined, { activeOnly: true }),
      ),
    ]);
  if (!EXACT_SHA.test(sourceSha))
    throw new Error(`source branch resolved invalid SHA ${sourceSha}`);

  const exactRuns = devRuns.filter((run) => text(run.head_sha) === sourceSha);
  const latestExactRun = newest(exactRuns);
  const activeRun = newest(
    devRuns.filter((run) => ACTIVE_STATUSES.has(text(run.status))),
  );
  const successfulPreflight = newest(
    preflightRuns.filter(
      (run) =>
        text(run.head_sha) === sourceSha &&
        text(run.status) === "completed" &&
        text(run.conclusion) === "success",
    ),
  );
  const priorityRuns = priorityRunSets
    .flat()
    .filter((run) => ACTIVE_STATUSES.has(text(run.status)));
  let fields = decideObservedState({
    sourceSha,
    latestExactRun,
    activeRun,
    successfulPreflight,
    priorityRuns,
  });
  if (!fields) {
    fields = await decideFailedRun({
      options,
      client,
      sourceSha,
      latestExactRun,
      successfulPreflight,
    });
  }

  if (options.expectedAction && fields.action !== options.expectedAction) {
    throw new Error(
      `qualification controller action changed: expected ${options.expectedAction}, observed ${fields.action}`,
    );
  }
  if (options.expectedSourceSha && sourceSha !== options.expectedSourceSha) {
    throw new Error(
      `qualification controller source changed: expected ${options.expectedSourceSha}, observed ${sourceSha}`,
    );
  }
  let mutation = null;
  if (options.mutationAuthorized && fields.action === "dispatch") {
    mutation = await client.dispatchWorkflow(
      options.devWorkflowPath,
      options.sourceBranch,
      {
        ...options.dispatchInputs,
        "source-sha": sourceSha,
      },
    );
  } else if (
    options.mutationAuthorized &&
    fields.action === "rerun-failed-jobs"
  ) {
    mutation = await client.rerunFailedJobs(latestExactRun.id);
  }
  return decisionBody(options, {
    ...fields,
    mutationAuthorized: options.mutationAuthorized,
    mutation,
  });
}
function encodeRef(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}
export function createGitHubDevQualificationClient({
  repository: repositoryInput,
  token,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: token ? `Bearer ${token}` : undefined,
    "user-agent": "buildchain-dev-qualification-patrol",
    "x-github-api-version": "2022-11-28",
  };
  async function api(requestPath, { method = "GET", body } = {}) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(`https://api.github.com${requestPath}`, {
        method,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([, value]) => value),
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      const payload = raw ? JSON.parse(raw) : undefined;
      if (response.ok) return payload;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleepImpl(attempt * 250);
        continue;
      }
      throw new Error(
        `GitHub API ${method} ${requestPath} failed with ${response.status}: ${payload?.message || raw}`,
      );
    }
    throw new Error(`GitHub API ${method} ${requestPath} exhausted retries`);
  }
  async function paged(requestPath, key) {
    const rows = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = requestPath.includes("?") ? "&" : "?";
      const payload = await api(
        `${requestPath}${separator}per_page=100&page=${page}`,
      );
      const pageRows = key ? payload[key] || [] : payload;
      rows.push(...pageRows);
      if (pageRows.length < 100) return rows;
    }
    throw new Error(`${requestPath} history exceeds 1000 rows`);
  }
  return {
    async resolveBranch(ref) {
      const payload = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
      );
      return text(payload.object?.sha);
    },
    async listWorkflowRuns(
      workflow,
      sourceBranch,
      { activeOnly = false } = {},
    ) {
      const query = sourceBranch
        ? `?branch=${encodeURIComponent(sourceBranch)}`
        : "";
      const runs = await paged(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs${query}`,
        "workflow_runs",
      );
      return activeOnly
        ? runs.filter((run) => ACTIVE_STATUSES.has(text(run.status)))
        : runs;
    },
    async listRunJobs(runId, runAttempt) {
      return paged(
        `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/attempts/${Number(runAttempt)}/jobs`,
        "jobs",
      );
    },
    async dispatchWorkflow(workflow, ref, inputs) {
      await api(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
        {
          method: "POST",
          body: { ref, inputs },
        },
      );
      return {
        action: "dispatch",
        workflow,
        ref,
        sourceSha: inputs["source-sha"],
      };
    },
    async rerunFailedJobs(runId) {
      await api(
        `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/rerun-failed-jobs`,
        {
          method: "POST",
        },
      );
      return { action: "rerun-failed-jobs", runId: Number(runId) };
    },
  };
}
function markdown(result) {
  return [
    "## Buildchain Dev qualification patrol",
    "",
    `State: \`${result.state}\``,
    `Action: \`${result.action}\` (${result.reason})`,
    `Source: \`${result.sourceBranch}@${result.sourceSha}\``,
    `Active run: ${result.activeRun?.url || "none"}`,
    `Pending SHA: \`${result.pendingSha || "none"}\``,
    `Mutation authorized: \`${result.mutationAuthorized}\``,
    "",
  ].join("\n");
}
async function main() {
  const options = normalizeDevQualificationOptions();
  const result = await runDevQualificationPatrol(options);
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
  fs.writeFileSync(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  const summary = markdown(result);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
  if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      "result-path": options.outputPath,
      state: result.state,
      action: result.action,
      reason: result.reason,
      "source-sha": result.sourceSha,
      "pending-sha": result.pendingSha || "",
      "active-run-id": result.activeRun?.id || "",
      "decision-root": result.decisionRoot,
    };
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

import crypto from "node:crypto";
export const EXACT_SHA = /^[0-9a-f]{40}$/u;
export const ACTIVE_STATUSES = new Set([
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

export function text(value = "") {
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
export function repository(value) {
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
export function evidenceRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}
export function newest(runs) {
  return [...runs].sort((left, right) => {
    const time = text(
      right.created_at || right.run_started_at || right.updated_at,
    ).localeCompare(
      text(left.created_at || left.run_started_at || left.updated_at),
    );
    return time || Number(right.id || 0) - Number(left.id || 0);
  })[0];
}
export function runEvidence(run) {
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
    repository: repository(options.repository),
    sourceBranch: branch(options.sourceBranch ?? "dev/v4/v4.0", "sourceBranch"),
    devWorkflowPath: workflowPath(
      options.devWorkflowPath ?? ".github/workflows/dev-verify-patrol.yml",
      "devWorkflowPath",
    ),
    preflightWorkflowPath: workflowPath(
      options.preflightWorkflowPath ??
        ".github/workflows/alpha-promotion-preflight.yml",
      "preflightWorkflowPath",
    ),
    priorityWorkflowPaths: workflowPaths(
      options.priorityWorkflowPaths ?? "[]",
      "priorityWorkflowPaths",
    ),
    dispatchInputs: dispatchInputs(options.dispatchInputs ?? {}),
    maxAttempts: integer(options.maxAttempts, 2),
    mutationAuthorized: bool(options.mutationAuthorized, false),
    expectedAction: text(options.expectedAction),
    expectedSourceSha: text(options.expectedSourceSha),
    outputPath: text(
      options.outputPath ?? ".buildchain/patrol/dev-qualification.json",
    ),
    now: text(options.now) || new Date().toISOString(),
  };
}

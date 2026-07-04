import crypto from "node:crypto";
import fs from "node:fs";

export const BUILDCHAIN_CONSUMER_ISSUE_CONTRACT = "kungfu-buildchain-consumer-issue";
export const BUILDCHAIN_WORKFLOW_FRICTION_ISSUE_CONTRACT = "kungfu-buildchain-workflow-friction-issue";
export const DEFAULT_BUILDCHAIN_ISSUE_REPOSITORY = "kungfu-systems/buildchain";

const DEFAULT_LABELS = ["buildchain-consumer-feedback"];
const DEFAULT_FRICTION_LABELS = ["buildchain-feedback", "workflow-friction"];
const DEFAULT_MAX_BODY_BYTES = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [500, 1_500, 3_000];

const SECRET_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g,
  /\b[A-Z0-9]{20}:[A-Za-z0-9_=-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(authorization\s*:\s*)(bearer\s+)?[^\s]+/gi,
  /(token|secret|password|private[_-]?key)(\s*[:=]\s*)[^\s"'`]+/gi,
  /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
];

export class GitHubIssueRequestError extends Error {
  constructor(message, { status, response, body } = {}) {
    super(message);
    this.name = "GitHubIssueRequestError";
    this.status = status;
    this.response = response;
    this.body = body;
  }
}

export function normalizeIssueRepository(repository = DEFAULT_BUILDCHAIN_ISSUE_REPOSITORY) {
  const match = String(repository || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

export function parseIssueLabels(input = DEFAULT_LABELS) {
  if (Array.isArray(input)) {
    return input.map((label) => String(label).trim()).filter(Boolean);
  }
  return String(input || "")
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

export function redactIssueText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      if (args.length >= 4 && typeof args[1] === "string" && typeof args[2] === "string") {
        return `${args[1]}${args[2]}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return text;
}

export function computeConsumerIssueFingerprint(fields = {}) {
  const normalized = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    normalized[key] = String(value);
  }
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 32);
}

export function consumerIssueMarker(fingerprint) {
  return `buildchain-consumer-issue:fingerprint=${fingerprint}`;
}

export function workflowFrictionMarker(fingerprint) {
  return `buildchain-workflow-friction:fingerprint=${fingerprint}`;
}

export function truncateUtf8(text, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const value = String(text ?? "");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const suffix = "\n\n[buildchain truncated issue body]\n";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let used = 0;
  for (const char of value) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > budget) {
      break;
    }
    output += char;
    used += bytes;
  }
  return `${output}${suffix}`;
}

export function buildConsumerIssueReport(options = {}) {
  const target = normalizeIssueRepository(options.targetRepository);
  const env = options.env || process.env;
  const consumerRepository = options.consumerRepository || env.GITHUB_REPOSITORY || "";
  const runId = options.runId || env.GITHUB_RUN_ID || "";
  const runUrl = options.runUrl || githubRunUrl(env, consumerRepository, runId);
  const workflow = options.workflow || env.GITHUB_WORKFLOW || "";
  const job = options.job || env.GITHUB_JOB || "";
  const consumerRef = options.consumerRef || env.GITHUB_REF || "";
  const consumerSha = options.consumerSha || env.GITHUB_SHA || "";
  const failureCode = options.failureCode || "consumer-report";
  const fingerprint =
    options.fingerprint ||
    computeConsumerIssueFingerprint({
      targetRepository: target.fullName,
      consumerRepository,
      workflow,
      job,
      failureCode,
      buildchainRef: options.buildchainRef,
      buildchainVersion: options.buildchainVersion,
      title: options.title,
    });
  const title = redactIssueText(
    options.title ||
      `[Buildchain consumer] ${consumerRepository || "unknown repository"}: ${failureCode}`,
  );
  const marker = consumerIssueMarker(fingerprint);
  const body = truncateUtf8(
    redactIssueText(
      [
        `<!-- ${marker} -->`,
        `# Buildchain consumer report`,
        ``,
        options.summary ? `## Summary\n\n${options.summary}` : "",
        `## Consumer`,
        ``,
        `- Repository: ${consumerRepository || "(unknown)"}`,
        `- Ref: ${consumerRef || "(unknown)"}`,
        `- SHA: ${consumerSha || "(unknown)"}`,
        `- Workflow: ${workflow || "(unknown)"}`,
        `- Job: ${job || "(unknown)"}`,
        `- Run: ${runUrl || runId || "(unknown)"}`,
        ``,
        `## Buildchain`,
        ``,
        `- Ref: ${options.buildchainRef || "(unknown)"}`,
        `- Version: ${options.buildchainVersion || "(unknown)"}`,
        `- Failure code: ${failureCode}`,
        `- Fingerprint: ${fingerprint}`,
        ``,
        optionalLine("## Release Passport", options.passportUrl || options.passportPath),
        optionalLine("## Diagnostics", options.diagnosticsUrl || options.diagnosticsPath),
        optionalLine("## Artifact", options.artifactUrl),
        options.body ? `## Details\n\n${options.body}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES),
  );
  const commentBody = truncateUtf8(
    redactIssueText(
      [
        `New matching Buildchain consumer report observed.`,
        ``,
        `- Repository: ${consumerRepository || "(unknown)"}`,
        `- Ref: ${consumerRef || "(unknown)"}`,
        `- SHA: ${consumerSha || "(unknown)"}`,
        `- Workflow: ${workflow || "(unknown)"}`,
        `- Run: ${runUrl || runId || "(unknown)"}`,
        `- Failure code: ${failureCode}`,
        `- Fingerprint: ${fingerprint}`,
        options.summary ? `\n${options.summary}` : "",
      ].join("\n"),
    ),
    Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES),
  );
  return {
    contract: BUILDCHAIN_CONSUMER_ISSUE_CONTRACT,
    targetRepository: target.fullName,
    fingerprint,
    marker,
    title,
    body,
    commentBody,
    labels: parseIssueLabels(options.labels ?? DEFAULT_LABELS),
  };
}

export function buildWorkflowFrictionIssueReport(options = {}) {
  const target = normalizeIssueRepository(options.targetRepository);
  const env = options.env || process.env;
  const repository = options.repository || env.GITHUB_REPOSITORY || "";
  const workflow = options.workflow || env.GITHUB_WORKFLOW || "";
  const runId = options.runId || env.GITHUB_RUN_ID || "";
  const runAttempt = options.runAttempt || env.GITHUB_RUN_ATTEMPT || "";
  const runUrl = options.runUrl || githubRunUrl(env, repository, runId);
  const channel = options.channel || "";
  const releaseIntent = options.releaseIntent || options.version || "";
  const sourceRef = options.sourceRef || env.GITHUB_REF || "";
  const sourceSha = options.sourceSha || env.GITHUB_SHA || "";
  const frictionClass = options.frictionClass || "workflow-friction";
  const fingerprint = options.fingerprint || computeConsumerIssueFingerprint({
    targetRepository: target.fullName,
    repository,
    workflow,
    channel,
    releaseIntent,
    sourceRef,
    sourceSha,
    frictionClass,
  });
  const marker = workflowFrictionMarker(fingerprint);
  const heavyBuilds = Array.isArray(options.heavyBuilds) ? options.heavyBuilds : [];
  const relatedRuns = Array.isArray(options.relatedRuns) ? options.relatedRuns : [];
  const title = redactIssueText(
    options.title || `[Buildchain feedback] ${frictionClass}: ${repository || "unknown repository"}`,
  );
  const body = truncateUtf8(
    redactIssueText(
      [
        `<!-- ${marker} -->`,
        `# Buildchain workflow friction`,
        ``,
        options.summary ? `## Summary\n\n${options.summary}` : "",
        `## Context`,
        ``,
        `- Repository: ${repository || "(unknown)"}`,
        `- Workflow: ${workflow || "(unknown)"}`,
        `- Run: ${runUrl || runId || "(unknown)"}`,
        `- Attempt: ${runAttempt || "(unknown)"}`,
        `- Pull request: ${options.pullRequest || "(unknown)"}`,
        `- Channel: ${channel || "(unknown)"}`,
        `- Release intent: ${releaseIntent || "(unknown)"}`,
        `- Source ref: ${sourceRef || "(unknown)"}`,
        `- Source SHA: ${sourceSha || "(unknown)"}`,
        `- Source tree: ${options.sourceTreeHash || "(unknown)"}`,
        `- Friction class: ${frictionClass}`,
        `- Fingerprint: ${fingerprint}`,
        ``,
        relatedRuns.length ? `## Related runs\n\n${relatedRuns.map((run) => `- ${run}`).join("\n")}` : "",
        heavyBuilds.length ? `## Heavy build jobs\n\n${heavyBuilds.map((job) => `- ${job.name || job}: ${job.durationMs || ""}`).join("\n")}` : "",
        options.diagnosis ? `## Diagnosis\n\n${options.diagnosis}` : "",
        options.nextAction ? `## Suggested next action\n\n${options.nextAction}` : "",
      ].filter(Boolean).join("\n"),
    ),
    Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES),
  );
  const commentBody = truncateUtf8(
    redactIssueText(
      [
        `New matching Buildchain workflow friction observed.`,
        ``,
        `- Repository: ${repository || "(unknown)"}`,
        `- Workflow: ${workflow || "(unknown)"}`,
        `- Run: ${runUrl || runId || "(unknown)"}`,
        `- Attempt: ${runAttempt || "(unknown)"}`,
        `- Friction class: ${frictionClass}`,
        `- Fingerprint: ${fingerprint}`,
        options.summary ? `\n${options.summary}` : "",
      ].join("\n"),
    ),
    Number(options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES),
  );
  return {
    contract: BUILDCHAIN_WORKFLOW_FRICTION_ISSUE_CONTRACT,
    targetRepository: target.fullName,
    fingerprint,
    marker,
    title,
    body,
    commentBody,
    labels: parseIssueLabels(options.labels ?? DEFAULT_FRICTION_LABELS),
  };
}

export async function reportBuildchainIssue(options = {}) {
  const report = options.report || buildConsumerIssueReport(options);
  const target = normalizeIssueRepository(report.targetRepository);
  const mode = options.mode || "create-or-comment";
  if (options.dryRun) {
    return {
      ok: true,
      action: "dry-run",
      created: false,
      commented: false,
      issueNumber: "",
      issueUrl: "",
      fingerprint: report.fingerprint,
      report,
    };
  }
  if (!["create", "create-or-comment", "comment"].includes(mode)) {
    throw new Error(`Unsupported consumer issue mode: ${mode}`);
  }
  const request = options.request || createGitHubIssueRequest(options);
  const existing = mode === "create" ? undefined : await findOpenConsumerIssue({ request, target, report });
  if (existing) {
    if (mode !== "create-or-comment" && mode !== "comment") {
      return {
        ok: true,
        action: "found",
        created: false,
        commented: false,
        issueNumber: existing.number,
        issueUrl: existing.html_url || existing.url || "",
        fingerprint: report.fingerprint,
        report,
      };
    }
    const cooldown = await evaluateCommentCooldown({
      request,
      target,
      issueNumber: existing.number,
      cooldownHours: options.commentCooldownHours,
      now: options.now,
    });
    if (cooldown.active) {
      return {
        ok: true,
        action: "cooldown",
        created: false,
        commented: false,
        issueNumber: existing.number,
        issueUrl: existing.html_url || existing.url || "",
        fingerprint: report.fingerprint,
        report,
        cooldown,
      };
    }
    await request({
      method: "POST",
      path: `/repos/${target.owner}/${target.repo}/issues/${existing.number}/comments`,
      body: { body: report.commentBody },
    });
    return {
      ok: true,
      action: "commented",
      created: false,
      commented: true,
      issueNumber: existing.number,
      issueUrl: existing.html_url || existing.url || "",
      fingerprint: report.fingerprint,
      report,
    };
  }
  if (mode === "comment") {
    throw new Error(`No open Buildchain consumer issue found for fingerprint ${report.fingerprint}`);
  }
  const issue = await createIssueWithLabelFallback({ request, target, report });
  return {
    ok: true,
    action: "created",
    created: true,
    commented: false,
    issueNumber: issue.number,
    issueUrl: issue.html_url || issue.url || "",
    fingerprint: report.fingerprint,
    report,
  };
}

export async function reportWorkflowFrictionIssue(options = {}) {
  return reportBuildchainIssue({
    ...options,
    report: buildWorkflowFrictionIssueReport(options),
  });
}

export function readOptionalIssueBodyFile(filePath) {
  const resolved = String(filePath || "").trim();
  if (!resolved) {
    return "";
  }
  return fs.readFileSync(resolved, "utf8");
}

export function createGitHubIssueRequest({
  token,
  apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  fetchImpl = globalThis.fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
} = {}) {
  if (!token) {
    throw new Error("A GitHub token is required to report a Buildchain issue");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to report a Buildchain issue");
  }
  const baseUrl = String(apiUrl || "https://api.github.com").replace(/\/+$/, "");
  return async function githubIssueRequest({ method = "GET", path, body }) {
    const url = `${baseUrl}${path}`;
    let attempt = 0;
    while (true) {
      try {
        const response = await fetchImpl(url, {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        const parsed = text ? parseJsonResponse(text) : {};
        if (response.ok) {
          return parsed;
        }
        const retryAfterMs = retryAfterHeaderMs(response.headers?.get?.("retry-after"));
        if (shouldRetryStatus(response.status) && attempt < retryDelaysMs.length) {
          await sleep(retryAfterMs ?? retryDelaysMs[attempt]);
          attempt += 1;
          continue;
        }
        throw new GitHubIssueRequestError(
          `GitHub API ${method} ${path} failed with ${response.status}: ${parsed.message || text}`,
          { status: response.status, response: parsed, body },
        );
      } catch (error) {
        if (error instanceof GitHubIssueRequestError) {
          throw error;
        }
        if (attempt < retryDelaysMs.length) {
          await sleep(retryDelaysMs[attempt]);
          attempt += 1;
          continue;
        }
        throw new GitHubIssueRequestError(`GitHub API ${method} ${path} failed: ${error.message}`, {
          body,
        });
      }
    }
  };
}

async function findOpenConsumerIssue({ request, target, report }) {
  const query = encodeURIComponent(
    `repo:${target.fullName} is:issue is:open "${report.marker || consumerIssueMarker(report.fingerprint)}"`,
  );
  const result = await request({ method: "GET", path: `/search/issues?q=${query}&per_page=1` });
  const items = Array.isArray(result.items) ? result.items : [];
  return items[0];
}

async function evaluateCommentCooldown({
  request,
  target,
  issueNumber,
  cooldownHours = 0,
  now = new Date(),
}) {
  const hours = Number(cooldownHours || 0);
  if (!Number.isFinite(hours) || hours <= 0) {
    return { active: false, cooldownHours: 0 };
  }
  const result = await request({
    method: "GET",
    path: `/repos/${target.owner}/${target.repo}/issues/${issueNumber}/comments?per_page=100`,
  });
  const comments = Array.isArray(result) ? result : [];
  const latest = comments[comments.length - 1]?.created_at || "";
  if (!latest) {
    return { active: false, cooldownHours: hours };
  }
  const latestMs = Date.parse(latest);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(latestMs) || !Number.isFinite(nowMs)) {
    return { active: false, cooldownHours: hours, latestCommentAt: latest };
  }
  const elapsedHours = (nowMs - latestMs) / 3_600_000;
  return {
    active: elapsedHours >= 0 && elapsedHours < hours,
    cooldownHours: hours,
    latestCommentAt: latest,
    elapsedHours,
  };
}

async function createIssueWithLabelFallback({ request, target, report }) {
  const payload = {
    title: report.title,
    body: report.body,
  };
  if (report.labels.length > 0) {
    payload.labels = report.labels;
  }
  try {
    return await request({
      method: "POST",
      path: `/repos/${target.owner}/${target.repo}/issues`,
      body: payload,
    });
  } catch (error) {
    if (error?.status === 422 && payload.labels) {
      return await request({
        method: "POST",
        path: `/repos/${target.owner}/${target.repo}/issues`,
        body: { title: payload.title, body: payload.body },
      });
    }
    throw error;
  }
}

function optionalLine(title, value) {
  return value ? `${title}\n\n${value}` : "";
}

function githubRunUrl(env, repository, runId) {
  if (!repository || !runId) {
    return "";
  }
  const server = env.GITHUB_SERVER_URL || "https://github.com";
  return `${server}/${repository}/actions/runs/${runId}`;
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function shouldRetryStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryAfterHeaderMs(value) {
  const seconds = Number(value || "");
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

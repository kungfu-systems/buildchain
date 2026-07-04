#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const DEFAULT_BUILD_WORKFLOW_FILE = "build.yml";
const DEFAULT_BUILD_WORKFLOW_NAME = "Build";

class GitHubApiError extends Error {
  constructor(message, { status, path: requestPath } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.path = requestPath;
  }
}

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function splitRepository(repository) {
  const match = String(repository || "").trim().match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`repository must be owner/repo, got ${repository || "<empty>"}`);
  }
  return { owner: match[1], repo: match[2], fullName: `${match[1]}/${match[2]}` };
}

function normalizeBranch(value = "") {
  return String(value || "").replace(/^refs\/heads\//, "").trim();
}

function assertSha(value, label = "sha") {
  const sha = String(value || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha;
}

function githubHeaders(token) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "buildchain-workflow-friction-report",
    "x-github-api-version": "2022-11-28",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function githubJson({ apiUrl, token, path: requestPath, fetchImpl = globalThis.fetch }) {
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new GitHubApiError(`GitHub API ${requestPath} failed with ${response.status}: ${body.message || text}`, {
      status: response.status,
      path: requestPath,
    });
  }
  return body;
}

function workflowRunMatchesConfiguredWorkflow(run, { buildWorkflowFile = "", buildWorkflowName = "" } = {}) {
  const expectedName = String(buildWorkflowName || "").trim();
  const expectedFile = String(buildWorkflowFile || "").trim();
  const runName = String(run.name || run.workflow_name || "").trim();
  const runPath = String(run.path || run.workflow_path || "").trim();
  if (expectedName && runName === expectedName) {
    return true;
  }
  if (expectedFile && (runPath === expectedFile || runPath.endsWith(`/${expectedFile}`))) {
    return true;
  }
  return !expectedName && !expectedFile;
}

async function listPullRequestWorkflowRuns({
  apiUrl,
  token,
  repo,
  buildWorkflowFile,
  buildWorkflowName,
  fetchImpl,
}) {
  const diagnostics = [];
  const workflowFile = String(buildWorkflowFile || "").trim();
  if (workflowFile) {
    try {
      const runs = await githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repo.owner}/${repo.repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=pull_request&per_page=100`,
      });
      return {
        runs: Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [],
        diagnostics,
      };
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
      diagnostics.push(`Configured PR-stage workflow file ${workflowFile} was not found; fell back to repository pull_request workflow runs.`);
    }
  }

  const runs = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repo.owner}/${repo.repo}/actions/runs?event=pull_request&per_page=100`,
  });
  return {
    runs: (Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [])
      .filter((run) => workflowRunMatchesConfiguredWorkflow(run, { buildWorkflowFile, buildWorkflowName })),
    diagnostics,
  };
}

function runLabel(run = "") {
  if (typeof run === "string") {
    return run;
  }
  const title = run.display_title || run.name || "workflow run";
  const url = run.html_url || run.url || "";
  const status = [run.status, run.conclusion].filter(Boolean).join("/");
  return `${title}${status ? ` (${status})` : ""}${url ? ` ${url}` : ""}`;
}

export function selectFrictionClass({
  duplicatePullRequests = [],
  heavyBuilds = [],
  releaseCandidateOutcome = "",
} = {}) {
  if (duplicatePullRequests.length > 1) {
    return "duplicate-channel-pr";
  }
  if (heavyBuilds.length > 1) {
    return "duplicate-heavy-build";
  }
  if (releaseCandidateOutcome === "failure") {
    return "late-fail-fast";
  }
  return "buildchain-ref-promotion-failed";
}

export function buildWorkflowFrictionBody({
  repository,
  targetRef,
  targetSha,
  runUrl,
  pullRequests = [],
  heavyBuilds = [],
  relatedRuns = [],
  frictionClass,
  diagnosis,
  nextAction,
  releaseCandidateDiagnosis = "",
} = {}) {
  return [
    "# Buildchain workflow friction evidence",
    "",
    "## Promotion context",
    "",
    `- Repository: ${repository || "(unknown)"}`,
    `- Target ref: ${targetRef || "(unknown)"}`,
    `- Target SHA: ${targetSha || "(unknown)"}`,
    `- Promotion run: ${runUrl || "(unknown)"}`,
    `- Friction class: ${frictionClass || "(unknown)"}`,
    releaseCandidateDiagnosis ? `- RC resolver: ${releaseCandidateDiagnosis}` : "",
    "",
    pullRequests.length
      ? `## Associated PRs\n\n${pullRequests.map((pr) => `- #${pr.number} ${pr.title || ""} ${pr.html_url || pr.url || ""}`).join("\n")}`
      : "## Associated PRs\n\n- (none detected)",
    "",
    relatedRuns.length
      ? `## Related workflow runs\n\n${relatedRuns.map((run) => `- ${runLabel(run)}`).join("\n")}`
      : "## Related workflow runs\n\n- (none detected)",
    "",
    heavyBuilds.length
      ? `## Heavy build runs\n\n${heavyBuilds.map((run) => `- ${runLabel(run)}`).join("\n")}`
      : "## Heavy build runs\n\n- (none detected)",
    "",
    diagnosis ? `## Diagnosis\n\n${diagnosis}` : "",
    nextAction ? `## Suggested next action\n\n${nextAction}` : "",
  ].filter(Boolean).join("\n");
}

export async function classifyWorkflowFriction({
  repository,
  targetRef,
  targetSha,
  token = env("GITHUB_TOKEN"),
  apiUrl = env("GITHUB_API_URL", "https://api.github.com"),
  buildWorkflowFile = DEFAULT_BUILD_WORKFLOW_FILE,
  buildWorkflowName = DEFAULT_BUILD_WORKFLOW_NAME,
  releaseCandidateOutcome = env("BUILDCHAIN_RC_RESOLVE_OUTCOME"),
  releaseCandidateDiagnosis = env("BUILDCHAIN_RC_DIAGNOSIS"),
  runUrl = env("BUILDCHAIN_WORKFLOW_RUN_URL"),
  outputDir = ".buildchain/workflow-friction",
  fetchImpl = globalThis.fetch,
} = {}) {
  const repo = splitRepository(repository);
  const sha = assertSha(targetSha, "targetSha");
  const normalizedTarget = normalizeBranch(targetRef);
  const pullResponse = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repo.owner}/${repo.repo}/commits/${sha}/pulls`,
  });
  const pullRequests = (Array.isArray(pullResponse) ? pullResponse : [])
    .filter((pr) => normalizeBranch(pr.base?.ref || "") === normalizedTarget)
    .filter((pr) => !pr.head?.repo?.full_name || pr.head.repo.full_name === repo.fullName);
  const primaryPullRequest = pullRequests
    .filter((pr) => pr.merged_at || pr.state === "closed")
    .sort((left, right) => Date.parse(right.updated_at || right.merged_at || "") - Date.parse(left.updated_at || left.merged_at || ""))[0]
    || pullRequests[0];

  let relatedRuns = [];
  let heavyBuilds = [];
  let workflowRunDiagnostics = [];
  if (primaryPullRequest?.number) {
    const workflowRuns = await listPullRequestWorkflowRuns({
      apiUrl,
      token,
      repo,
      buildWorkflowFile,
      buildWorkflowName,
      fetchImpl,
    });
    workflowRunDiagnostics = workflowRuns.diagnostics;
    relatedRuns = workflowRuns.runs
      .filter((run) => (run.pull_requests || []).some((pr) => Number(pr.number || 0) === Number(primaryPullRequest.number)));
    heavyBuilds = relatedRuns.filter((run) => run.status === "completed" && ["success", "failure", "cancelled", "timed_out"].includes(run.conclusion || ""));
  }

  const frictionClass = selectFrictionClass({
    duplicatePullRequests: pullRequests,
    heavyBuilds,
    releaseCandidateOutcome,
  });
  const diagnosisParts = [];
  if (pullRequests.length > 1) {
    diagnosisParts.push(`Detected ${pullRequests.length} channel PRs associated with the same promoted SHA.`);
  }
  if (heavyBuilds.length > 1) {
    diagnosisParts.push(`Detected ${heavyBuilds.length} completed PR-stage heavy build runs for PR #${primaryPullRequest?.number}.`);
  }
  if (releaseCandidateOutcome === "failure") {
    diagnosisParts.push("Promotion reached the post-Verify workflow before required PR-stage RC evidence could be resolved.");
  }
  if (releaseCandidateDiagnosis) {
    diagnosisParts.push(releaseCandidateDiagnosis);
  }
  diagnosisParts.push(...workflowRunDiagnostics);
  const diagnosis = diagnosisParts.join(" ") || "Buildchain ref promotion failed after Verify succeeded; inspect the classified evidence and keep the fix in Buildchain.";
  const nextAction = frictionClass === "late-fail-fast"
    ? "Move the missing/stale RC evidence check earlier or make the promotion workflow consume the exact PR-stage RC passport before any publish side effect."
    : "Deduplicate the PR/build path or tighten Buildchain workflow gates so the next channel promotion reaches publish exactly once.";
  fs.mkdirSync(outputDir, { recursive: true });
  const bodyFile = path.join(outputDir, "issue-body.md");
  const body = buildWorkflowFrictionBody({
    repository: repo.fullName,
    targetRef: normalizedTarget,
    targetSha: sha,
    runUrl,
    pullRequests,
    heavyBuilds,
    relatedRuns,
    frictionClass,
    diagnosis,
    nextAction,
    releaseCandidateDiagnosis,
  });
  fs.writeFileSync(bodyFile, `${body}\n`);
  return {
    frictionClass,
    summary: `Buildchain ref promotion failed after Verify with ${frictionClass} evidence.`,
    diagnosis,
    nextAction,
    pullRequest: primaryPullRequest?.number ? `#${primaryPullRequest.number}` : "",
    bodyFile,
    relatedRuns: relatedRuns.map(runLabel),
    heavyBuilds: heavyBuilds.map((run) => ({
      name: runLabel(run),
      durationMs: run.run_started_at && run.updated_at
        ? Math.max(0, Date.parse(run.updated_at) - Date.parse(run.run_started_at))
        : "",
    })),
  };
}

export async function workflowFrictionReportCli() {
  let result;
  try {
    result = await classifyWorkflowFriction({
      repository: env("BUILDCHAIN_SOURCE_REPOSITORY", env("GITHUB_REPOSITORY")),
      targetRef: env("BUILDCHAIN_TARGET_REF"),
      targetSha: env("BUILDCHAIN_TARGET_SHA"),
      buildWorkflowFile: env("BUILDCHAIN_BUILD_WORKFLOW_FILE", DEFAULT_BUILD_WORKFLOW_FILE),
      buildWorkflowName: env("BUILDCHAIN_BUILD_WORKFLOW_NAME", env("BUILDCHAIN_RC_WORKFLOW_NAME", DEFAULT_BUILD_WORKFLOW_NAME)),
      outputDir: env("BUILDCHAIN_FRICTION_OUTPUT_DIR", ".buildchain/workflow-friction"),
    });
  } catch (error) {
    const outputDir = env("BUILDCHAIN_FRICTION_OUTPUT_DIR", ".buildchain/workflow-friction");
    fs.mkdirSync(outputDir, { recursive: true });
    const bodyFile = path.join(outputDir, "issue-body.md");
    const diagnosis = `Workflow friction auto-classification failed: ${error.message}`;
    result = {
      frictionClass: env("BUILDCHAIN_RC_RESOLVE_OUTCOME") === "failure" ? "late-fail-fast" : "buildchain-ref-promotion-failed",
      summary: "Buildchain ref promotion failed after Verify; auto-classification did not complete.",
      diagnosis,
      nextAction: "Inspect the promotion logs and fix the Buildchain workflow contract so this class of failure is reported before repeated heavy work or publish side effects.",
      pullRequest: "",
      bodyFile,
      relatedRuns: [],
      heavyBuilds: [],
    };
    fs.writeFileSync(bodyFile, `${buildWorkflowFrictionBody({
      repository: env("BUILDCHAIN_SOURCE_REPOSITORY", env("GITHUB_REPOSITORY")),
      targetRef: env("BUILDCHAIN_TARGET_REF"),
      targetSha: env("BUILDCHAIN_TARGET_SHA"),
      runUrl: env("BUILDCHAIN_WORKFLOW_RUN_URL"),
      frictionClass: result.frictionClass,
      diagnosis,
      nextAction: result.nextAction,
      releaseCandidateDiagnosis: env("BUILDCHAIN_RC_DIAGNOSIS"),
    })}\n`);
    console.error(`::warning::${diagnosis.replace(/\r?\n/g, "%0A")}`);
  }
  writeGitHubOutputs({
    "friction-class": result.frictionClass,
    summary: result.summary,
    diagnosis: result.diagnosis,
    "next-action": result.nextAction,
    "pull-request": result.pullRequest,
    "body-file": result.bodyFile,
    "related-runs-json": JSON.stringify(result.relatedRuns),
    "heavy-builds-json": JSON.stringify(result.heavyBuilds),
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await workflowFrictionReportCli();
}

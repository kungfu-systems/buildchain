#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const DEFAULT_WORKFLOW_FILE = "build-surface-fixture.yml";

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
    "user-agent": "buildchain-release-candidate-resolver",
    "x-github-api-version": "2022-11-28",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

async function githubJson({ apiUrl, token, method = "GET", path: requestPath, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required to resolve release candidate artifacts");
  }
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, { method, headers: githubHeaders(token) });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${requestPath} failed with ${response.status}: ${body.message || text}`);
  }
  return body;
}

async function githubDownload({ apiUrl, token, path: requestPath, outputPath, fetchImpl = globalThis.fetch }) {
  const url = `${String(apiUrl || "https://api.github.com").replace(/\/+$/, "")}${requestPath}`;
  const response = await fetchImpl(url, { headers: githubHeaders(token) });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(`GitHub artifact download ${requestPath} failed with ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  fs.writeFileSync(outputPath, Buffer.from(await response.arrayBuffer()));
  return outputPath;
}

export function selectMergedChannelPullRequest({ pullRequests = [], targetRef, repository }) {
  const normalizedTarget = normalizeBranch(targetRef);
  const candidates = pullRequests.filter((pr) => {
    const baseRef = normalizeBranch(pr.base?.ref || pr.baseRefName || "");
    const merged = Boolean(pr.merged_at || pr.mergedAt || pr.state === "closed");
    const sameRepo = !repository || !pr.head?.repo?.full_name || pr.head.repo.full_name === repository;
    return merged && sameRepo && baseRef === normalizedTarget;
  });
  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.merged_at || left.updated_at || left.closed_at || "");
    const rightTime = Date.parse(right.merged_at || right.updated_at || right.closed_at || "");
    return (rightTime || 0) - (leftTime || 0);
  });
  return candidates[0];
}

export function selectReleaseCandidateRun({ runs = [], pullRequest, workflowName = "Build Surface Fixture" }) {
  const prNumber = Number(pullRequest?.number || 0);
  const candidates = runs.filter((run) => {
    const runPrs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    const matchesPr = runPrs.some((pr) => Number(pr.number || 0) === prNumber);
    const matchesWorkflow = !workflowName || run.name === workflowName || run.display_title === workflowName;
    return matchesPr && matchesWorkflow && run.event === "pull_request" && run.status === "completed" && run.conclusion === "success";
  });
  candidates.sort((left, right) => Date.parse(right.updated_at || right.created_at || "") - Date.parse(left.updated_at || left.created_at || ""));
  return candidates[0];
}

export function selectReleaseCandidateArtifacts({ artifacts = [] }) {
  const active = artifacts.filter((artifact) => !artifact.expired);
  const passports = active.filter((artifact) => /-release-candidate-[0-9a-f]{40}$/i.test(artifact.name || ""));
  if (passports.length !== 1) {
    throw new Error(`expected exactly one release-candidate passport artifact, found ${passports.length}`);
  }
  const passport = passports[0];
  const match = passport.name.match(/^(.+)-release-candidate-([0-9a-f]{40})$/i);
  const prefix = match?.[1] || "";
  const sha = match?.[2] || "";
  const summaries = active.filter((artifact) => artifact.name === `${prefix}-summary-${sha}`);
  if (summaries.length !== 1) {
    throw new Error(`expected exactly one build summary artifact named ${prefix}-summary-${sha}, found ${summaries.length}`);
  }
  return { passport, summary: summaries[0], prefix, sourceSha: sha };
}

function unzip(zipPath, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", outputDir], { stdio: "inherit" });
}

function findDownloadedFile(root, filename) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.name === filename) {
        return fullPath;
      }
    }
  }
  return "";
}

export async function resolveReleaseCandidateArtifacts({
  repository,
  targetRef,
  targetSha,
  token = env("GITHUB_TOKEN"),
  apiUrl = env("GITHUB_API_URL", "https://api.github.com"),
  workflowFile = DEFAULT_WORKFLOW_FILE,
  workflowName = "Build Surface Fixture",
  outputDir = ".buildchain/release-candidate",
  fetchImpl = globalThis.fetch,
  download = true,
} = {}) {
  const repoInfo = splitRepository(repository);
  const sha = assertSha(targetSha, "targetSha");
  const normalizedTarget = normalizeBranch(targetRef);
  if (!/^(alpha|release)\/v\d+\/v\d+\.\d+$/.test(normalizedTarget)) {
    return {
      enabled: false,
      reason: `target ref ${normalizedTarget || "(empty)"} does not require release-candidate promotion`,
    };
  }
  const pulls = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${sha}/pulls`,
  });
  const pullRequest = selectMergedChannelPullRequest({
    pullRequests: Array.isArray(pulls) ? pulls : [],
    targetRef: normalizedTarget,
    repository: repoInfo.fullName,
  });
  if (!pullRequest) {
    throw new Error(`no same-repository merged channel PR found for ${sha} into ${normalizedTarget}`);
  }
  const runs = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=pull_request&status=success&per_page=100`,
  });
  const run = selectReleaseCandidateRun({
    runs: Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [],
    pullRequest,
    workflowName,
  });
  if (!run) {
    throw new Error(`no successful ${workflowName} pull_request run found for channel PR #${pullRequest.number}`);
  }
  const artifactResponse = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${run.id}/artifacts?per_page=100`,
  });
  const selected = selectReleaseCandidateArtifacts({
    artifacts: Array.isArray(artifactResponse.artifacts) ? artifactResponse.artifacts : [],
  });
  const result = {
    enabled: true,
    repository: repoInfo.fullName,
    targetRef: normalizedTarget,
    targetSha: sha,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.html_url || pullRequest.url || "",
      headRef: pullRequest.head?.ref || "",
      baseRef: pullRequest.base?.ref || "",
    },
    run: {
      id: String(run.id || ""),
      url: run.html_url || run.url || "",
      name: run.name || workflowName,
    },
    artifacts: {
      passport: selected.passport.name,
      summary: selected.summary.name,
      sourceSha: selected.sourceSha,
    },
  };
  if (!download) {
    return result;
  }
  const resolvedOutput = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-rc-"));
  const passportDir = path.join(resolvedOutput, "passport");
  const summaryDir = path.join(resolvedOutput, "summary");
  const passportZip = path.join(tempDir, "passport.zip");
  const summaryZip = path.join(tempDir, "summary.zip");
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: passportZip,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${selected.passport.id}/zip`,
  });
  await githubDownload({
    apiUrl,
    token,
    fetchImpl,
    outputPath: summaryZip,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/artifacts/${selected.summary.id}/zip`,
  });
  unzip(passportZip, passportDir);
  unzip(summaryZip, summaryDir);
  fs.rmSync(tempDir, { recursive: true, force: true });
  const passportPath = findDownloadedFile(passportDir, "release-candidate-passport.json");
  const buildSummaryPath = findDownloadedFile(summaryDir, "build-summary.json");
  if (!passportPath || !buildSummaryPath) {
    throw new Error("downloaded release-candidate artifacts did not contain release-candidate-passport.json and build-summary.json");
  }
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));
  return {
    ...result,
    paths: {
      passport: path.relative(process.cwd(), passportPath).split(path.sep).join("/"),
      buildSummary: path.relative(process.cwd(), buildSummaryPath).split(path.sep).join("/"),
    },
    version: passport.target?.version || "",
    candidateHash: passport.candidateHash || "",
  };
}

export async function resolveReleaseCandidateArtifactsCli() {
  const result = await resolveReleaseCandidateArtifacts({
    repository: env("BUILDCHAIN_SOURCE_REPOSITORY", env("GITHUB_REPOSITORY")),
    targetRef: env("BUILDCHAIN_TARGET_REF"),
    targetSha: env("BUILDCHAIN_TARGET_SHA"),
    workflowFile: env("BUILDCHAIN_RC_WORKFLOW_FILE", DEFAULT_WORKFLOW_FILE),
    workflowName: env("BUILDCHAIN_RC_WORKFLOW_NAME", "Build Surface Fixture"),
    outputDir: env("BUILDCHAIN_RC_OUTPUT_DIR", ".buildchain/release-candidate"),
  });
  writeGitHubOutputs({
    "promote-only-release-candidate": String(result.enabled === true),
    "release-candidate-passport-path": result.paths?.passport || "",
    "release-candidate-build-summary-path": result.paths?.buildSummary || "",
    "release-candidate-version": result.version || "",
    "release-candidate-artifact": result.artifacts?.passport || "",
    "release-candidate-build-summary-artifact": result.artifacts?.summary || "",
    "release-candidate-run-id": result.run?.id || "",
    "release-candidate-run-url": result.run?.url || "",
    "release-candidate-pr": result.pullRequest?.number ? String(result.pullRequest.number) : "",
    "release-candidate-diagnosis": result.enabled
      ? `Resolved PR-stage RC passport ${result.artifacts.passport} from ${result.run.url || `run ${result.run.id}`}`
      : result.reason || "",
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await resolveReleaseCandidateArtifactsCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}

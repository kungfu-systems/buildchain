#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertStableReleaseGate,
  evaluateStableReleaseGate,
  loadStableReleasePolicy,
} from "../packages/core/stable-release-gate.js";

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

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "user-agent": "buildchain-stable-release-gate",
    "x-github-api-version": "2022-11-28",
  };
}

async function githubJson({
  apiUrl = "https://api.github.com",
  token = "",
  requestPath,
  fetchImpl = globalThis.fetch,
}) {
  const response = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}${requestPath}`, {
    headers: githubHeaders(token),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`GitHub API GET ${requestPath} failed with ${response.status}: ${body?.message || text}`);
  }
  return body;
}

function parseAlphaVersion(version) {
  const normalized = String(version || "").replace(/^v/, "").trim();
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)-alpha\.(\d+)$/);
  if (!match) {
    throw new Error(`stable release gate requires an exact alpha version, got ${version || "<empty>"}`);
  }
  return {
    version: normalized,
    tag: `v${normalized}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

async function resolveTagCommitSha({ api, repository, tag }) {
  const ref = await api(`/repos/${repository.owner}/${repository.repo}/git/ref/tags/${encodeURIComponent(tag)}`);
  let sha = ref.object?.sha || "";
  if (ref.object?.type === "tag") {
    const annotated = await api(`/repos/${repository.owner}/${repository.repo}/git/tags/${sha}`);
    sha = annotated.object?.sha || "";
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`tag ${tag} did not resolve to a 40-character commit SHA`);
  }
  return sha;
}

function selectPreviousStable({ releases = [], candidate }) {
  const prefix = `v${candidate.major}.${candidate.minor}.`;
  return releases
    .map((release) => {
      const match = String(release.tag_name || "").match(
        new RegExp(`^${prefix.replaceAll(".", "\\.")}(\\d+)$`),
      );
      return match ? { release, patch: Number(match[1]) } : undefined;
    })
    .filter((entry) => entry && entry.patch < candidate.patch && entry.release.published_at)
    .sort((left, right) => right.patch - left.patch)[0]?.release;
}

function loadImpact({ cwd, input }) {
  const normalized = String(input || "").trim();
  if (!normalized) {
    return {};
  }
  if (normalized.startsWith("{")) {
    return JSON.parse(normalized);
  }
  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function parseRunUrl(url = "") {
  const match = String(url).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/);
  return match
    ? { owner: match[1], repo: match[2], repository: `${match[1]}/${match[2]}`, runId: match[3] }
    : undefined;
}

async function resolveCanaryEvidence({
  api,
  repository,
  policy,
  candidateTag,
  candidateSha,
  releaseCandidateRunId,
  releaseCandidateRunUrl,
}) {
  let statuses;
  const evidence = [];
  for (const canary of policy.requiredCanaries) {
    if (canary.source === "release-candidate") {
      if (!releaseCandidateRunId) {
        evidence.push({ id: canary.id, status: "missing", candidateSha });
        continue;
      }
      const run = await api(
        `/repos/${repository.owner}/${repository.repo}/actions/runs/${encodeURIComponent(releaseCandidateRunId)}`,
      );
      const workflowMatches = !canary.workflow ||
        canary.workflow === run.name || canary.workflow === run.path?.split("/").pop();
      evidence.push({
        id: canary.id,
        status: run.conclusion === "success" && workflowMatches ? "success" : run.conclusion || "failure",
        candidateSha,
        completedAt: run.updated_at || run.run_started_at || "",
        evidenceUrl: run.html_url || releaseCandidateRunUrl,
        repository: repository.fullName,
        workflow: run.name || run.path || "",
        attestor: run.actor?.login || run.triggering_actor?.login || "",
      });
      continue;
    }

    statuses ||= await api(
      `/repos/${repository.owner}/${repository.repo}/commits/${candidateSha}/statuses?per_page=100`,
    );
    const status = statuses.find((entry) => entry.context === canary.context);
    const targetRun = parseRunUrl(status?.target_url);
    let targetRunEvidence;
    let targetWorkflowEvidence;
    if (targetRun && (!canary.repository || targetRun.repository === canary.repository)) {
      targetRunEvidence = await api(
        `/repos/${targetRun.owner}/${targetRun.repo}/actions/runs/${targetRun.runId}`,
      );
      if (targetRunEvidence?.workflow_id) {
        targetWorkflowEvidence = await api(
          `/repos/${targetRun.owner}/${targetRun.repo}/actions/workflows/${encodeURIComponent(targetRunEvidence.workflow_id)}`,
        );
      }
    }
    const workflowName = targetWorkflowEvidence?.name || targetRunEvidence?.name || "";
    const workflowPath = targetWorkflowEvidence?.path || targetRunEvidence?.path || "";
    const workflowMatches = !canary.workflow ||
      canary.workflow === workflowName ||
      canary.workflow === workflowPath.split("/").pop();
    const repositoryMatches = !canary.repository || targetRun?.repository === canary.repository;
    const inputRuntimeRef = String(
      targetRunEvidence?.inputs?.buildchain_ref ||
      targetRunEvidence?.inputs?.buildchainRef ||
      "",
    ).trim();
    const runDisplayName = String(
      targetRunEvidence?.display_title || targetRunEvidence?.name || "",
    ).trim();
    const runNamePrefix = `${workflowName || canary.workflow || ""} / `;
    const runNameRuntimeRef = runNamePrefix.trim() && runDisplayName.startsWith(runNamePrefix)
      ? runDisplayName.slice(runNamePrefix.length).trim()
      : "";
    const runtimeRef = inputRuntimeRef || runNameRuntimeRef;
    const runtimeRefSource = inputRuntimeRef ? "workflow-input" : runNameRuntimeRef ? "run-name" : "missing";
    const runtimeRefMatches = runtimeRef === candidateTag || runtimeRef === candidateSha;
    const evidenceMatches =
      status?.state === "success" &&
      targetRunEvidence?.conclusion === "success" &&
      workflowMatches &&
      repositoryMatches &&
      runtimeRefMatches;
    evidence.push({
      id: canary.id,
      status: evidenceMatches
        ? "success"
        : status?.state === "success"
          ? "mismatched"
          : status?.state || "missing",
      candidateSha,
      completedAt: targetRunEvidence?.updated_at || status?.updated_at || "",
      evidenceUrl: status?.target_url || "",
      repository: targetRun?.repository || canary.repository,
      workflow: workflowName || workflowPath,
      attestor: status?.creator?.login || "",
      runtimeRef,
      runtimeRefSource,
      workflowId: targetRunEvidence?.workflow_id || "",
    });
  }
  return evidence;
}

export async function collectStableReleaseGateReport({
  cwd = process.cwd(),
  repository: repositoryInput,
  channel = "",
  policyInput = ".buildchain/stable-release-policy.json",
  impactInput = ".buildchain/release-impact.json",
  candidateVersion = "",
  releaseCandidateRunId = "",
  releaseCandidateRunUrl = "",
  now = new Date().toISOString(),
  apiUrl = "https://api.github.com",
  token = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const policy = loadStableReleasePolicy({ cwd, input: policyInput });
  if (!policy || policy.enabled === false || channel !== "release") {
    return evaluateStableReleaseGate({ policy, channel });
  }
  const repository = splitRepository(repositoryInput);
  const candidate = parseAlphaVersion(candidateVersion);
  const api = (requestPath) => githubJson({ apiUrl, token, requestPath, fetchImpl });
  const [candidateRelease, releases, candidateSha] = await Promise.all([
    api(`/repos/${repository.owner}/${repository.repo}/releases/tags/${encodeURIComponent(candidate.tag)}`),
    api(`/repos/${repository.owner}/${repository.repo}/releases?per_page=100`),
    resolveTagCommitSha({ api, repository, tag: candidate.tag }),
  ]);
  const previousRelease = selectPreviousStable({ releases, candidate });
  const previousSha = previousRelease
    ? await resolveTagCommitSha({ api, repository, tag: previousRelease.tag_name })
    : "";
  const comparison = previousRelease
    ? await api(
        `/repos/${repository.owner}/${repository.repo}/compare/${encodeURIComponent(previousRelease.tag_name)}...${encodeURIComponent(candidate.tag)}`,
      )
    : { files: [] };
  const canaries = await resolveCanaryEvidence({
    api,
    repository,
    policy,
    candidateTag: candidate.tag,
    candidateSha,
    releaseCandidateRunId,
    releaseCandidateRunUrl,
  });
  return assertStableReleaseGate({
    policy,
    channel,
    candidate: {
      tag: candidate.tag,
      sha: candidateSha,
      publishedAt: candidateRelease.published_at,
    },
    previousStable: previousRelease
      ? {
          tag: previousRelease.tag_name,
          sha: previousSha,
          publishedAt: previousRelease.published_at,
        }
      : undefined,
    changedPaths: (comparison.files || []).map((file) => file.filename),
    impact: loadImpact({ cwd, input: impactInput }),
    canaries,
    now,
  });
}

export async function stableReleaseGateCli() {
  const cwd = process.cwd();
  const policyInput = env("BUILDCHAIN_STABLE_RELEASE_POLICY", ".buildchain/stable-release-policy.json");
  const outputPath = env(
    "BUILDCHAIN_STABLE_RELEASE_GATE_OUTPUT",
    ".buildchain/release-passport/stable-release-gate.json",
  );
  const report = await collectStableReleaseGateReport({
    cwd,
    repository: env("GITHUB_REPOSITORY"),
    channel: env("BUILDCHAIN_PROMOTION_CHANNEL"),
    policyInput,
    impactInput: env("BUILDCHAIN_RELEASE_IMPACT", ".buildchain/release-impact.json"),
    candidateVersion: env("BUILDCHAIN_RELEASE_CANDIDATE_VERSION"),
    releaseCandidateRunId: env("BUILDCHAIN_RELEASE_CANDIDATE_RUN_ID"),
    releaseCandidateRunUrl: env("BUILDCHAIN_RELEASE_CANDIDATE_RUN_URL"),
    apiUrl: env("GITHUB_API_URL", "https://api.github.com"),
    token: env("GITHUB_TOKEN"),
  });
  const resolvedOutput = path.isAbsolute(outputPath) ? outputPath : path.resolve(cwd, outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`stable-release-gate=${report.applies ? report.summary.decision : report.summary.reason}`);
  console.log(`stable-release-gate-report=${path.relative(cwd, resolvedOutput).split(path.sep).join("/")}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stableReleaseGateCli().catch((error) => {
    const report = error?.report;
    if (report) {
      const outputPath = env(
        "BUILDCHAIN_STABLE_RELEASE_GATE_OUTPUT",
        ".buildchain/release-passport/stable-release-gate.json",
      );
      const resolvedOutput = path.resolve(process.cwd(), outputPath);
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  });
}

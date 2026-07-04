#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { writeGitHubOutputs } from "./build-contract-core.mjs";

const DEFAULT_API = "https://api.github.com";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function splitRepository(repository) {
  const match = String(repository || "").match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`repository must be owner/repo, got ${repository || "<empty>"}`);
  }
  return { owner: match[1], repo: match[2] };
}

function headers(env) {
  const result = {
    Accept: "application/vnd.github+json",
    "User-Agent": "buildchain-release-candidate-resolver",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = readEnv("GITHUB_TOKEN") || env?.GITHUB_TOKEN || "";
  if (token) {
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

async function githubJson(url, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, { headers: headers(env) });
  if (!response?.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message || "";
    } catch {
      detail = "";
    }
    throw new Error(`GitHub API ${response?.status || "unknown"} for ${url}${detail ? `: ${detail}` : ""}`);
  }
  return await response.json();
}

function apiBase(env) {
  return String(env.GITHUB_API_URL || DEFAULT_API).replace(/\/+$/, "");
}

function encodeRef(ref) {
  return String(ref).split("/").map(encodeURIComponent).join("/");
}

function expectedArtifactNames({ artifactName, builtSourceSha, pullRequestNumber }) {
  return [
    `${artifactName}-release-candidate-pr-${pullRequestNumber}-${builtSourceSha}`,
    `${artifactName}-release-candidate-${builtSourceSha}`,
  ];
}

export async function resolveReleaseCandidate({
  repository,
  targetSha,
  targetRef,
  artifactName,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const { owner, repo } = splitRepository(repository);
  const api = apiBase(env);
  const pulls = await githubJson(
    `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(targetSha)}/pulls`,
    { env, fetchImpl },
  );
  const matchingPulls = (Array.isArray(pulls) ? pulls : []).filter((pull) =>
    pull?.merged_at &&
    (!targetRef || pull.base?.ref === targetRef) &&
    pull.head?.repo?.full_name === repository
  );
  if (matchingPulls.length !== 1) {
    throw new Error(`expected one merged same-repository PR for ${targetSha} into ${targetRef || "<any>"}, found ${matchingPulls.length}`);
  }
  const pullRequest = matchingPulls[0];
  const builtSourceSha = pullRequest.merge_commit_sha || pullRequest.head?.sha || targetSha;
  const names = expectedArtifactNames({
    artifactName,
    builtSourceSha,
    pullRequestNumber: pullRequest.number,
  });
  const found = [];
  for (const name of names) {
    const artifacts = await githubJson(
      `${api}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
      { env, fetchImpl },
    );
    for (const artifact of artifacts.artifacts || []) {
      if (!artifact.expired && artifact.name === name) {
        found.push(artifact);
      }
    }
    if (found.length > 0) {
      break;
    }
  }
  const unique = found.filter((artifact, index) =>
    found.findIndex((candidate) => candidate.id === artifact.id) === index
  );
  if (unique.length !== 1) {
    throw new Error(`expected one release-candidate artifact for PR #${pullRequest.number} (${names.join(" or ")}), found ${unique.length}`);
  }
  const artifact = unique[0];
  return {
    ok: true,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.html_url || pullRequest.url || "",
      headRef: pullRequest.head?.ref || "",
      baseRef: pullRequest.base?.ref || "",
      mergedAt: pullRequest.merged_at || "",
    },
    builtSourceSha,
    targetSha,
    targetRef,
    artifactName: artifact.name,
    artifactId: String(artifact.id),
    workflowRunId: String(artifact.workflow_run?.id || ""),
    archiveDownloadUrl: artifact.archive_download_url || "",
  };
}

export async function releaseCandidateResolverCli({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const result = await resolveReleaseCandidate({
    repository: readEnv("GITHUB_REPOSITORY"),
    targetSha: readEnv("BUILDCHAIN_PROMOTION_CHANNEL_SHA", readEnv("GITHUB_SHA")),
    targetRef: readEnv("BUILDCHAIN_TARGET_REF", readEnv("GITHUB_REF_NAME")),
    artifactName: readEnv("BUILDCHAIN_ARTIFACT_NAME", "buildchain-artifact"),
    env,
    fetchImpl,
  });
  writeGitHubOutputs({
    "release-candidate-artifact-name": result.artifactName,
    "release-candidate-artifact-id": result.artifactId,
    "release-candidate-run-id": result.workflowRunId,
    "built-source-sha": result.builtSourceSha,
    "pull-request-number": String(result.pullRequest.number),
  });
  console.log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await releaseCandidateResolverCli();
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}

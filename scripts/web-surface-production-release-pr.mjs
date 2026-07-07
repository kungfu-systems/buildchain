#!/usr/bin/env node

function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value = "") {
  return String(value || "").trim();
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "production";
}

function parseJson(value, name) {
  const normalized = optionalString(value);
  if (!normalized) return {};
  try {
    return JSON.parse(normalized);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

function runUrl({ serverUrl = "", repository = "", runId = "" } = {}) {
  if (!serverUrl || !repository || !runId) return "";
  return `${serverUrl.replace(/\/$/, "")}/${repository}/actions/runs/${runId}`;
}

function urlsFromResult(result = {}) {
  const urls = result.urls && typeof result.urls === "object" ? result.urls : {};
  if (Object.keys(urls).length > 0) return urls;
  return result.url ? { default: result.url } : {};
}

export function releaseBranchName({ prefix = "release/", channel = "production", sourceSha = "" } = {}) {
  const normalizedPrefix = optionalString(prefix) || "release/";
  const normalizedChannel = slugify(channel || "production");
  const shortSha = requiredString(sourceSha, "sourceSha").slice(0, 12);
  return `${normalizedPrefix}${normalizedChannel}-${shortSha}`;
}

export function renderProductionReleasePrBody({
  stagingResult = {},
  sourceSha = "",
  artifactHash = "",
  releasePassportArtifact = "buildchain-web-surface-staging-release-passport",
  workflowRunUrl = "",
  productionReleaseLabel = "buildchain-release",
  branchName = "",
} = {}) {
  const urls = urlsFromResult(stagingResult);
  const urlLines = Object.entries(urls).length
    ? Object.entries(urls).map(([surface, url]) => `- ${surface}: ${url}`)
    : ["- (no staging URL reported)"];
  const passportLine = workflowRunUrl
    ? `[${releasePassportArtifact}](${workflowRunUrl})`
    : `\`${releasePassportArtifact}\``;
  return `<!-- buildchain:web-surface-production-release-pr -->
## Buildchain production release intent

Staging has been deployed from the current main commit. Review the staging URLs,
then merge this PR to approve production. Buildchain will only publish
production after it verifies that the merged PR is a same-repository release PR
with the required label.

### Staging URLs

${urlLines.join("\n")}

### Release Evidence

- Source SHA: \`${sourceSha}\`
- Artifact hash: \`${artifactHash || "not reported"}\`
- Staging release passport: ${passportLine}
- Required label: \`${productionReleaseLabel}\`
- Release branch: \`${branchName}\`

This PR intentionally contains one empty release-intent commit.`;
}

async function githubJson({ apiUrl, token, method = "GET", path, body }) {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    const detail = text ? `: ${text.slice(0, 500)}` : "";
    const error = new Error(`GitHub API ${method} ${path} failed: HTTP ${response.status}${detail}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? {} : response.json();
}

async function ensureLabel({ apiUrl, token, owner, repo, label }) {
  if (!label) return;
  try {
    await githubJson({ apiUrl, token, path: `/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}` });
  } catch (error) {
    if (error.status !== 404) throw error;
    await githubJson({
      apiUrl,
      token,
      method: "POST",
      path: `/repos/${owner}/${repo}/labels`,
      body: {
        name: label,
        color: "0e8a16",
        description: "Buildchain production release approval PR",
      },
    });
  }
}

async function addLabel({ apiUrl, token, owner, repo, pullNumber, label }) {
  if (!label) return;
  await ensureLabel({ apiUrl, token, owner, repo, label });
  await githubJson({
    apiUrl,
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${pullNumber}/labels`,
    body: { labels: [label] },
  });
}

async function createOrUpdateBranch({ apiUrl, token, owner, repo, branchName, sourceSha, message }) {
  const baseCommit = await githubJson({
    apiUrl,
    token,
    path: `/repos/${owner}/${repo}/git/commits/${sourceSha}`,
  });
  const createdCommit = await githubJson({
    apiUrl,
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/git/commits`,
    body: {
      message,
      tree: baseCommit.tree.sha,
      parents: [sourceSha],
    },
  });
  const ref = `heads/${branchName}`;
  try {
    await githubJson({
      apiUrl,
      token,
      method: "POST",
      path: `/repos/${owner}/${repo}/git/refs`,
      body: {
        ref: `refs/${ref}`,
        sha: createdCommit.sha,
      },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    await githubJson({
      apiUrl,
      token,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(ref).replace(/%2F/g, "/")}`,
      body: {
        sha: createdCommit.sha,
        force: true,
      },
    });
  }
  return createdCommit.sha;
}

export async function openProductionReleasePr({
  apiUrl = "https://api.github.com",
  token,
  repository,
  sourceSha,
  stagingResult,
  productionReleaseLabel = "buildchain-release",
  productionReleaseHeadPrefix = "release/",
  productionReleaseChannel = "production",
  runId = "",
  serverUrl = "https://github.com",
  releasePassportArtifact = "buildchain-web-surface-staging-release-passport",
} = {}) {
  const [owner, repo] = requiredString(repository, "repository").split("/");
  if (!owner || !repo) throw new Error(`invalid repository: ${repository}`);
  const normalizedToken = requiredString(token, "token");
  const normalizedSourceSha = requiredString(sourceSha, "sourceSha");
  const label = requiredString(productionReleaseLabel, "productionReleaseLabel");
  const branchName = releaseBranchName({
    prefix: productionReleaseHeadPrefix || "release/",
    channel: productionReleaseChannel || "production",
    sourceSha: normalizedSourceSha,
  });
  const workflowRunUrl = runUrl({ serverUrl, repository, runId });
  const body = renderProductionReleasePrBody({
    stagingResult,
    sourceSha: normalizedSourceSha,
    artifactHash: stagingResult.artifactHash || "",
    releasePassportArtifact,
    workflowRunUrl,
    productionReleaseLabel: label,
    branchName,
  });
  const title = `Release production from ${normalizedSourceSha.slice(0, 12)}`;
  const head = `${owner}:${branchName}`;
  const existing = await githubJson({
    apiUrl,
    token: normalizedToken,
    path: `/repos/${owner}/${repo}/pulls?state=open&base=main&head=${encodeURIComponent(head)}`,
  });
  if (Array.isArray(existing) && existing.length > 0) {
    const pull = existing[0];
    await githubJson({
      apiUrl,
      token: normalizedToken,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/pulls/${pull.number}`,
      body: { title, body },
    });
    await addLabel({ apiUrl, token: normalizedToken, owner, repo, pullNumber: pull.number, label });
    return {
      action: "updated",
      branchName,
      pullNumber: pull.number,
      pullUrl: pull.html_url,
      sourceSha: normalizedSourceSha,
    };
  }

  const commitSha = await createOrUpdateBranch({
    apiUrl,
    token: normalizedToken,
    owner,
    repo,
    branchName,
    sourceSha: normalizedSourceSha,
    message: `buildchain release intent: ${productionReleaseChannel} ${normalizedSourceSha.slice(0, 12)}`,
  });
  const pull = await githubJson({
    apiUrl,
    token: normalizedToken,
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls`,
    body: {
      title,
      head: branchName,
      base: "main",
      body,
      maintainer_can_modify: true,
    },
  });
  await addLabel({ apiUrl, token: normalizedToken, owner, repo, pullNumber: pull.number, label });
  return {
    action: "created",
    branchName,
    commitSha,
    pullNumber: pull.number,
    pullUrl: pull.html_url,
    sourceSha: normalizedSourceSha,
  };
}

export async function webSurfaceProductionReleasePrCli(env = process.env) {
  const stagingResult = parseJson(env.STAGING_APPLY_RESULT_JSON, "STAGING_APPLY_RESULT_JSON");
  const sourceSha = optionalString(stagingResult.sourceSha) || requiredString(env.GITHUB_SHA, "GITHUB_SHA");
  const result = await openProductionReleasePr({
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    sourceSha,
    stagingResult,
    productionReleaseLabel: env.PRODUCTION_RELEASE_LABEL || "buildchain-release",
    productionReleaseHeadPrefix: env.PRODUCTION_RELEASE_HEAD_PREFIX || "release/",
    productionReleaseChannel: env.PRODUCTION_RELEASE_CHANNEL || "production",
    runId: env.GITHUB_RUN_ID,
    serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
    releasePassportArtifact: env.RELEASE_PASSPORT_ARTIFACT || "buildchain-web-surface-staging-release-passport",
  });
  for (const [name, value] of Object.entries({
    "production-release-pr-action": result.action,
    "production-release-pr": String(result.pullNumber || ""),
    "production-release-pr-url": result.pullUrl || "",
    "production-release-branch": result.branchName || "",
    "production-release-source-sha": result.sourceSha || "",
  })) {
    console.log(`${name}=${value}`);
    if (env.GITHUB_OUTPUT) {
      const fs = await import("node:fs");
      fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
    }
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  webSurfaceProductionReleasePrCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

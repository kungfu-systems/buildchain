#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

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

function parseBoolean(value, defaultValue = false) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`expected boolean value, got: ${value}`);
}

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] || "";
}

function readJsonFile(filePath, name) {
  const normalized = requiredString(filePath, name);
  try {
    return JSON.parse(fs.readFileSync(path.resolve(normalized), "utf8"));
  } catch (error) {
    throw new Error(`${name} must point to valid JSON: ${error.message}`);
  }
}

function writeJsonFile(filePath, value) {
  const resolved = path.resolve(requiredString(filePath, "output"));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function writeTextFile(filePath, value) {
  const resolved = path.resolve(requiredString(filePath, "filePath"));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, String(value));
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

export function compactProductionReleasePrSummary(result = {}) {
  const manifest = result.manifest && typeof result.manifest === "object" ? result.manifest : {};
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-web-surface-production-release-pr-summary",
    sourceContract: result.contract || "",
    channel: result.channel || manifest.channel || "",
    alias: result.alias || manifest.alias || "",
    status: result.status || "",
    applyMode: result.applyMode || "",
    actor: result.actor || "",
    runId: result.runId || "",
    appliedAt: result.appliedAt || "",
    url: result.url || "",
    urls: urlsFromResult(result),
    sourceSha: result.sourceSha || manifest.sourceSha || "",
    artifactHash: result.artifactHash || manifest.artifactHash || "",
    target: result.target || "",
    manifestKey: result.manifestKey || "",
    surfaceBindings: Array.isArray(result.surfaceBindings)
      ? result.surfaceBindings.map((binding) => ({
          surface: binding.surface || "",
          pathPrefix: binding.pathPrefix || "",
          objectPrefix: binding.objectPrefix || "",
          url: binding.url || "",
          manifestKey: binding.manifestKey || "",
          accessControl: binding.accessControl || "",
          healthStrategy: binding.healthStrategy || "",
        }))
      : [],
  };
}

export function readStagingReleasePrSummary(env = process.env) {
  const summaryPath = optionalString(env.STAGING_RELEASE_PR_SUMMARY_PATH);
  if (summaryPath) {
    return compactProductionReleasePrSummary(readJsonFile(summaryPath, "STAGING_RELEASE_PR_SUMMARY_PATH"));
  }
  const resultPath = optionalString(env.STAGING_APPLY_RESULT_PATH);
  if (resultPath) {
    return compactProductionReleasePrSummary(readJsonFile(resultPath, "STAGING_APPLY_RESULT_PATH"));
  }
  return compactProductionReleasePrSummary(parseJson(env.STAGING_APPLY_RESULT_JSON, "STAGING_APPLY_RESULT_JSON"));
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

export function createProductionReleasePrHandoff({
  repository,
  sourceSha,
  stagingResult = {},
  productionReleaseLabel = "buildchain-release",
  productionReleaseHeadPrefix = "release/",
  productionReleaseChannel = "production",
  runId = "",
  serverUrl = "https://github.com",
  releasePassportArtifact = "buildchain-web-surface-staging-release-passport",
} = {}) {
  const [owner, repo] = requiredString(repository, "repository").split("/");
  if (!owner || !repo) throw new Error(`invalid repository: ${repository}`);
  const normalizedSourceSha = requiredString(sourceSha, "sourceSha");
  const label = requiredString(productionReleaseLabel, "productionReleaseLabel");
  const branchName = releaseBranchName({
    prefix: productionReleaseHeadPrefix || "release/",
    channel: productionReleaseChannel || "production",
    sourceSha: normalizedSourceSha,
  });
  const workflowRunUrl = runUrl({ serverUrl, repository, runId });
  const title = `Release production from ${normalizedSourceSha.slice(0, 12)}`;
  const body = renderProductionReleasePrBody({
    stagingResult,
    sourceSha: normalizedSourceSha,
    artifactHash: stagingResult.artifactHash || "",
    releasePassportArtifact,
    workflowRunUrl,
    productionReleaseLabel: label,
    branchName,
  });
  const emptyCommitMessage = `buildchain release intent: ${productionReleaseChannel} ${normalizedSourceSha.slice(0, 12)}`;
  const bodyPath = ".buildchain/production-release-pr/body.md";
  const manualCommand = [
    "git fetch origin main",
    `git switch -C ${branchName} ${normalizedSourceSha}`,
    `git commit --allow-empty -m ${JSON.stringify(emptyCommitMessage)}`,
    `git push origin HEAD:${branchName}`,
    `gh pr create --repo ${repository} --base main --head ${branchName} --title ${JSON.stringify(title)} --body-file ${bodyPath}`,
  ].join(" && ");
  return {
    contract: "kungfu-buildchain-web-surface-production-release-pr-handoff",
    schemaVersion: 1,
    repository,
    owner,
    repo,
    base: "main",
    head: `${owner}:${branchName}`,
    branchName,
    sourceSha: normalizedSourceSha,
    title,
    body,
    label,
    productionReleaseChannel,
    releasePassportArtifact,
    workflowRunUrl,
    manualCommand,
    staging: {
      channel: stagingResult.channel || "",
      status: stagingResult.status || "",
      urls: urlsFromResult(stagingResult),
      artifactHash: stagingResult.artifactHash || "",
      target: stagingResult.target || "",
      manifestKey: stagingResult.manifestKey || "",
    },
  };
}

function classifyReleasePrError(error) {
  const message = String(error?.message || error || "");
  if (
    error?.status === 403 &&
    /not permitted to create or approve pull requests|Resource not accessible by integration|permission|forbidden/i.test(message)
  ) {
    return "permission-denied";
  }
  return "failed";
}

function renderStepSummary(result = {}) {
  const status = result.status || result.action || "unknown";
  const lines = [
    "## Buildchain production release PR handoff",
    "",
    `- status: \`${status}\``,
    `- mode: \`${result.mode || "auto"}\``,
    `- source: \`${result.sourceSha || ""}\``,
    `- release branch: \`${result.branchName || ""}\``,
  ];
  if (result.pullUrl) lines.push(`- pull request: ${result.pullUrl}`);
  if (result.error?.message) lines.push(`- error: \`${result.error.message.replace(/`/g, "'")}\``);
  if (result.manualCommand) {
    lines.push("", "Manual PR creation command:", "", "```bash", result.manualCommand, "```");
  }
  return `${lines.join("\n")}\n`;
}

function writeGitHubOutputs(env, outputs) {
  for (const [name, value] of Object.entries(outputs)) {
    const normalized = String(value ?? "");
    console.log(`${name}=${normalized}`);
    if (env.GITHUB_OUTPUT) {
      fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${normalized}\n`);
    }
  }
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
  const handoff = createProductionReleasePrHandoff({
    repository,
    sourceSha,
    stagingResult,
    productionReleaseLabel,
    productionReleaseHeadPrefix,
    productionReleaseChannel,
    runId,
    serverUrl,
    releasePassportArtifact,
  });
  const { owner, repo, branchName, title, body, head } = handoff;
  const normalizedToken = requiredString(token, "token");
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
    await addLabel({ apiUrl, token: normalizedToken, owner, repo, pullNumber: pull.number, label: handoff.label });
    return {
      action: "updated",
      status: "updated",
      ...handoff,
      branchName,
      pullNumber: pull.number,
      pullUrl: pull.html_url,
    };
  }

  const commitSha = await createOrUpdateBranch({
    apiUrl,
    token: normalizedToken,
    owner,
    repo,
    branchName,
    sourceSha: handoff.sourceSha,
    message: `buildchain release intent: ${productionReleaseChannel} ${handoff.sourceSha.slice(0, 12)}`,
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
  await addLabel({ apiUrl, token: normalizedToken, owner, repo, pullNumber: pull.number, label: handoff.label });
  return {
    action: "created",
    status: "created",
    ...handoff,
    branchName,
    commitSha,
    pullNumber: pull.number,
    pullUrl: pull.html_url,
  };
}

export async function webSurfaceProductionReleasePrCli(env = process.env) {
  const stagingResult = readStagingReleasePrSummary(env);
  const sourceSha = optionalString(stagingResult.sourceSha) || requiredString(env.GITHUB_SHA, "GITHUB_SHA");
  const mode = optionalString(env.PRODUCTION_RELEASE_PR_MODE || "auto") || "auto";
  if (!["auto", "summary-only", "disabled"].includes(mode)) {
    throw new Error("PRODUCTION_RELEASE_PR_MODE must be auto, summary-only, or disabled");
  }
  const failOnReleasePrError = parseBoolean(env.FAIL_ON_RELEASE_PR_ERROR, false);
  const handoff = createProductionReleasePrHandoff({
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

  const bodyPath = optionalString(env.PRODUCTION_RELEASE_PR_BODY_PATH) || ".buildchain/production-release-pr/body.md";
  const summaryPath = optionalString(env.PRODUCTION_RELEASE_PR_SUMMARY_PATH) || ".buildchain/production-release-pr/handoff.json";
  writeTextFile(bodyPath, `${handoff.body}\n`);

  let result = {
    ...handoff,
    mode,
    status: mode,
    action: "skipped",
    pullNumber: "",
    pullUrl: "",
    bodyPath,
    summaryPath,
  };

  if (mode === "auto") {
    try {
      result = {
        ...result,
        ...(await openProductionReleasePr({
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
        })),
        mode,
      };
    } catch (error) {
      const status = classifyReleasePrError(error);
      result = {
        ...result,
        status,
        action: status,
        error: {
          status: error.status || "",
          message: error.message || String(error),
        },
      };
      if (status !== "permission-denied" || failOnReleasePrError) {
        writeJsonFile(summaryPath, result);
        if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderStepSummary(result));
        throw error;
      }
    }
  }

  writeJsonFile(summaryPath, result);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderStepSummary(result));
  }
  writeGitHubOutputs(env, {
    "release-pr-status": result.status,
    "production-release-pr-status": result.status,
    "production-release-pr-action": result.action,
    "production-release-pr": String(result.pullNumber || ""),
    "production-release-pr-url": result.pullUrl || "",
    "production-release-branch": result.branchName || "",
    "production-release-source-sha": result.sourceSha || "",
    "production-release-pr-summary-path": summaryPath,
    "production-release-pr-body-path": bodyPath,
  });
  return result;
}

export function writeProductionReleasePrSummaryCli(env = process.env) {
  const input = readArg("input", env.STAGING_APPLY_RESULT_PATH || "");
  const output = readArg("output", env.STAGING_RELEASE_PR_SUMMARY_PATH || "");
  const result = input
    ? readJsonFile(input, "input")
    : parseJson(env.STAGING_APPLY_RESULT_JSON, "STAGING_APPLY_RESULT_JSON");
  const summary = compactProductionReleasePrSummary(result);
  writeJsonFile(output, summary);
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv[2] === "write-summary") {
      writeProductionReleasePrSummaryCli();
    } else {
      await webSurfaceProductionReleasePrCli();
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

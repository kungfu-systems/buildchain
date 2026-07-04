#!/usr/bin/env node
import { pathToFileURL } from "node:url";

function readEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function issueBody({
  repository = "",
  workflowRunUrl = "",
  pullRequest = "",
  channel = "",
  version = "",
  friction = "",
  count = "",
  stage = "",
  summary = "",
} = {}) {
  return [
    "## Buildchain workflow friction",
    "",
    `- repository: ${repository || "(unknown)"}`,
    `- workflow run: ${workflowRunUrl || "(unknown)"}`,
    `- pull request: ${pullRequest || "(unknown)"}`,
    `- channel: ${channel || "(unknown)"}`,
    `- version: ${version || "(unknown)"}`,
    `- friction: ${friction || "(unknown)"}`,
    `- duplicate count: ${count || "(unknown)"}`,
    `- failed stage: ${stage || "(unknown)"}`,
    "",
    "### Evidence summary",
    "",
    "```json",
    summary || "{}",
    "```",
  ].join("\n");
}

async function createIssue({ env = process.env, fetchImpl = globalThis.fetch, title, body }) {
  const repository = env.BUILDCHAIN_ISSUE_REPOSITORY || "kungfu-systems/buildchain";
  const token = env.BUILDCHAIN_ISSUE_TOKEN || env.GITHUB_TOKEN || "";
  if (!token) {
    return { created: false, reason: "missing-token" };
  }
  const [owner, repo] = repository.split("/");
  const response = await fetchImpl(`${env.GITHUB_API_URL || "https://api.github.com"}/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "buildchain-workflow-friction-report",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ title, body, labels: ["buildchain-friction"] }),
  });
  if (response.status === 403 || response.status === 404) {
    return { created: false, reason: `permission-${response.status}` };
  }
  if (!response.ok) {
    throw new Error(`GitHub issue creation failed: ${response.status}`);
  }
  const issue = await response.json();
  return { created: true, url: issue.html_url || issue.url || "" };
}

export async function workflowFrictionReportCli({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const friction = readEnv("BUILDCHAIN_FRICTION_KIND", "");
  if (!friction) {
    return { created: false, skipped: true, reason: "no-friction-kind" };
  }
  const title = `[Buildchain friction] ${friction} in ${readEnv("GITHUB_REPOSITORY", "unknown")}`;
  const body = issueBody({
    repository: readEnv("GITHUB_REPOSITORY", ""),
    workflowRunUrl: readEnv("BUILDCHAIN_WORKFLOW_RUN_URL", ""),
    pullRequest: readEnv("BUILDCHAIN_PULL_REQUEST_URL", ""),
    channel: readEnv("BUILDCHAIN_CHANNEL", ""),
    version: readEnv("BUILDCHAIN_VERSION", ""),
    friction,
    count: readEnv("BUILDCHAIN_FRICTION_COUNT", ""),
    stage: readEnv("BUILDCHAIN_FAILED_STAGE", ""),
    summary: readEnv("BUILDCHAIN_FRICTION_SUMMARY_JSON", "{}"),
  });
  const result = await createIssue({ env, fetchImpl, title, body });
  if (!result.created) {
    const summaryPath = env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      const fs = await import("node:fs");
      fs.appendFileSync(summaryPath, `\n### Buildchain friction issue body\n\n\`\`\`markdown\n${body}\n\`\`\`\n`);
    } else {
      console.log(body);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await workflowFrictionReportCli();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`::error::${String(error.message || error).replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveBuildchainConfigPath } from "../packages/core/buildchain-layout.js";

export const RELEASE_REVIEW_MARKER = "<!-- buildchain:web-surface-release-review -->";

export function resolveReleaseReviewState(payload, options = {}) {
  const eventName = options.eventName || "";
  const eventAction = options.eventAction || "";
  const repository = options.repository || "";
  const enabled = options.productionReleaseOnMain === true || options.productionReleaseOnMain === "true";
  const requiredLabel = String(options.productionReleaseLabel || "").trim();
  const requiredHeadPrefix = String(options.productionReleaseHeadPrefix || "").trim();
  const pull = payload?.pull_request;

  if (!enabled) return { shouldComment: false, reason: "release-pr-publish-disabled" };
  if (eventName !== "pull_request") return { shouldComment: false, reason: "not-a-pull-request" };
  if (eventAction === "closed") return { shouldComment: false, reason: "pull-request-closed" };
  if (!pull) return { shouldComment: false, reason: "missing-pull-request-payload" };
  if (!requiredLabel) return { shouldComment: false, reason: "missing-production-release-label" };

  const labels = (pull.labels || []).map((label) => label.name).filter(Boolean);
  if (!labels.includes(requiredLabel)) {
    return { shouldComment: false, reason: "missing-release-label" };
  }

  const baseRef = pull.base?.ref || "";
  if (baseRef !== "main") {
    return { shouldComment: false, reason: "base-is-not-main" };
  }

  const headRef = pull.head?.ref || "";
  if (requiredHeadPrefix && !headRef.startsWith(requiredHeadPrefix)) {
    return { shouldComment: false, reason: "head-prefix-mismatch" };
  }

  const headRepo = pull.head?.repo?.full_name || "";
  if (repository && headRepo && headRepo !== repository) {
    return { shouldComment: false, reason: "head-repo-mismatch" };
  }

  return {
    shouldComment: true,
    reason: "release-pr-review-ready",
    pullNumber: pull.number,
    headRef,
    baseRef,
    labels,
  };
}

export function loadWebSurfaceReleaseUrls(cwd = ".") {
  const configPath = path.join(cwd, resolveBuildchainConfigPath(cwd));
  const raw = fs.readFileSync(configPath, "utf8");
  const config = parseToml(raw);
  const stagingUrl = String(config.channels?.staging?.url || "").trim();
  const productionUrl = String(config.channels?.production?.url || "").trim();
  if (!stagingUrl) {
    throw new Error("channels.staging.url is required for a release PR review comment");
  }
  if (!productionUrl) {
    throw new Error("channels.production.url is required for a release PR review comment");
  }
  return { stagingUrl, productionUrl };
}

export function renderReleaseReviewComment({
  stagingUrl,
  productionUrl,
  label,
  headPrefix,
}) {
  const branchLine = headPrefix
    ? `- Release branch prefix: \`${headPrefix}\``
    : "- Release branch prefix: `(none)`";
  return `${RELEASE_REVIEW_MARKER}
## Buildchain release review

- Staging review URL: ${stagingUrl}
- Production target: ${productionUrl}
- Approval action: merge this release PR after staging has been verified.
- Release label: \`${label}\`
${branchLine}

Buildchain treats this merge as the production approval event. The resulting
\`main\` push will publish production only after Buildchain verifies the merged
same-repository release PR, the required label, and the release branch prefix.`;
}

export async function upsertIssueComment({
  apiUrl = "https://api.github.com",
  token,
  repository,
  issueNumber,
  body,
  marker = RELEASE_REVIEW_MARKER,
  fetchImpl = fetch,
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required to write the release PR review comment");
  if (!repository || !repository.includes("/")) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!issueNumber) throw new Error("pull request number is required to write a comment");

  const [owner, repo] = repository.split("/");
  const base = apiUrl.replace(/\/$/, "");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  const commentsUrl = `${base}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const commentsResponse = await fetchImpl(commentsUrl, { headers });
  if (!commentsResponse.ok) {
    throw new Error(`failed to list release PR comments: HTTP ${commentsResponse.status}`);
  }
  const comments = await commentsResponse.json();
  const existing = comments.find((comment) => String(comment.body || "").includes(marker));

  if (existing) {
    const updateResponse = await fetchImpl(`${base}/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!updateResponse.ok) {
      throw new Error(`failed to update release PR comment: HTTP ${updateResponse.status}`);
    }
    return { action: "updated", commentId: existing.id };
  }

  const createResponse = await fetchImpl(`${base}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
  if (!createResponse.ok) {
    throw new Error(`failed to create release PR comment: HTTP ${createResponse.status}`);
  }
  const created = await createResponse.json();
  return { action: "created", commentId: created.id };
}

export async function webSurfaceReleasePrReviewCli(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const state = resolveReleaseReviewState(payload, {
    eventName: env.GITHUB_EVENT_NAME,
    eventAction: env.GITHUB_EVENT_ACTION,
    repository: env.GITHUB_REPOSITORY,
    productionReleaseOnMain: env.PRODUCTION_RELEASE_ON_MAIN,
    productionReleaseLabel: env.PRODUCTION_RELEASE_LABEL,
    productionReleaseHeadPrefix: env.PRODUCTION_RELEASE_HEAD_PREFIX,
  });

  if (!state.shouldComment) {
    console.log(`release PR review comment skipped: ${state.reason}`);
    return state;
  }

  const { stagingUrl, productionUrl } = loadWebSurfaceReleaseUrls(env.WORKING_DIRECTORY || ".");
  const body = renderReleaseReviewComment({
    stagingUrl,
    productionUrl,
    label: env.PRODUCTION_RELEASE_LABEL,
    headPrefix: env.PRODUCTION_RELEASE_HEAD_PREFIX,
  });
  const result = await upsertIssueComment({
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    issueNumber: state.pullNumber,
    body,
  });
  console.log(`release PR review comment ${result.action}: ${result.commentId}`);
  return { ...state, ...result };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  webSurfaceReleasePrReviewCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

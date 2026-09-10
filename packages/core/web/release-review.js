import { upsertIssueComment } from "../providers/github-issue-comment.js";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { resolveBuildchainConfigPath } from "../contracts/buildchain-layout.js";

export const RELEASE_REVIEW_MARKER =
  "<!-- buildchain:web-surface-release-review -->";

export function resolveReleaseReviewState(payload, options = {}) {
  const eventName = options.eventName || "";
  const eventAction = options.eventAction || "";
  const repository = options.repository || "";
  const enabled = options.productionReleaseOnMain === true;
  const requiredLabel = String(options.productionReleaseLabel || "").trim();
  const requiredHeadPrefix = String(
    options.productionReleaseHeadPrefix || "",
  ).trim();
  const pull = payload?.pull_request;

  if (!enabled)
    return { shouldComment: false, reason: "release-pr-publish-disabled" };
  if (eventName !== "pull_request")
    return { shouldComment: false, reason: "not-a-pull-request" };
  if (eventAction === "closed")
    return { shouldComment: false, reason: "pull-request-closed" };
  if (!pull)
    return { shouldComment: false, reason: "missing-pull-request-payload" };
  if (!requiredLabel)
    return { shouldComment: false, reason: "missing-production-release-label" };

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
    throw new Error(
      "channels.staging.url is required for a release PR review comment",
    );
  }
  if (!productionUrl) {
    throw new Error(
      "channels.production.url is required for a release PR review comment",
    );
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

export async function reviewWebRelease(
  { request, event, workingDirectory, token },
  ports = {},
) {
  const state = resolveReleaseReviewState(event.payload, {
    eventName: event.name,
    eventAction: event.payload.action,
    repository: event.repository,
    productionReleaseOnMain: request["production-release-on-main"],
    productionReleaseLabel: request["production-release-label"],
    productionReleaseHeadPrefix: request["production-release-head-prefix"],
  });
  if (!state.shouldComment) return state;
  const urls = loadWebSurfaceReleaseUrls(workingDirectory);
  return (ports.comment || upsertIssueComment)({
    apiUrl: event.apiUrl,
    token,
    repository: event.repository,
    issueNumber: state.pullNumber,
    marker: RELEASE_REVIEW_MARKER,
    body: renderReleaseReviewComment({
      ...urls,
      label: request["production-release-label"],
      headPrefix: request["production-release-head-prefix"],
    }),
  });
}

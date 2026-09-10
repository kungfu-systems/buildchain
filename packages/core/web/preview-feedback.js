import { upsertIssueComment } from "../providers/github-issue-comment.js";

export const PREVIEW_FEEDBACK_MARKER =
  "<!-- buildchain:web-surface-preview -->";
export function previewFeedbackBody({ result, cleanup, runUrl }) {
  if (cleanup)
    return [
      PREVIEW_FEEDBACK_MARKER,
      "Preview cleanup completed.",
      "",
      `- Aliases: ${result.entries.map((entry) => `\`${entry.alias}\``).join(", ") || "none"}`,
      `- Status: \`${result.status}\``,
      `- Run: ${runUrl}`,
    ].join("\n");
  return [
    PREVIEW_FEEDBACK_MARKER,
    "Preview deployed:",
    ...Object.entries(result.urls || { default: result.url }).map(
      ([surface, url]) => `- ${surface}: ${url}`,
    ),
    "",
    `- Source: \`${result.sourceSha}\``,
    `- Artifact: \`${result.artifactHash}\``,
    `- Status: \`${result.status}\``,
    `- Run: ${runUrl}`,
  ].join("\n");
}
export async function commentPreviewResult(
  { result, cleanup, runUrl, repository, pullNumber, token, apiUrl },
  ports = {},
) {
  return (ports.comment || upsertIssueComment)({
    apiUrl,
    token,
    repository,
    issueNumber: pullNumber,
    marker: PREVIEW_FEEDBACK_MARKER,
    body: previewFeedbackBody({ result, cleanup, runUrl }),
  });
}

export async function commentDeployment({ github, context }) {
  const fs = await import("node:fs");
  const result = JSON.parse(
    fs.readFileSync(".buildchain/web-surface-preview-apply.json", "utf8"),
  );
  const marker = "<!-- buildchain:web-surface-preview -->";
  const urls = result.urls || { default: result.url };
  const urlLines = Object.entries(urls).map(
    ([surface, url]) => `- ${surface}: ${url}`,
  );
  const body = [
    marker,
    "Preview deployed:",
    ...urlLines,
    "",
    `- Source: \`${result.sourceSha}\``,
    `- Artifact: \`${result.artifactHash}\``,
    `- Status: \`${result.status}\``,
    `- Run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  ].join("\n");
  const issue_number = context.payload.pull_request.number;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.body && comment.body.includes(marker),
  );
  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number,
      body,
    });
  }
}

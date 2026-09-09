export async function commentDeployment({ github, context }) {
  const fs = await import("node:fs");
  const result = JSON.parse(
    fs.readFileSync(".buildchain/web-surface-cleanup-apply.json", "utf8"),
  );
  const marker = "<!-- buildchain:web-surface-preview -->";
  const aliases =
    result.entries.map((entry) => `\`${entry.alias}\``).join(", ") || "none";
  const body = [
    marker,
    "Preview cleanup completed.",
    "",
    `- Aliases: ${aliases}`,
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

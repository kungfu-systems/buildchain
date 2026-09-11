export async function upsertIssueComment({
  apiUrl = "https://api.github.com",
  token,
  repository,
  issueNumber,
  body,
  marker,
  fetchImpl = fetch,
}) {
  if (!marker || !body.includes(marker))
    throw new Error("Comment requires a stable marker in its body");
  if (!token)
    throw new Error(
      "GITHUB_TOKEN is required to write the release PR review comment",
    );
  if (!repository || !repository.includes("/"))
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!issueNumber)
    throw new Error("pull request number is required to write a comment");

  const [owner, repo] = repository.split("/");
  const base = apiUrl.replace(/\/$/, "");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  const comments = [];
  for (let page = 1; ; page += 1) {
    const suffix = page === 1 ? "" : `&page=${page}`;
    const response = await fetchImpl(
      `${base}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100${suffix}`,
      { headers },
    );
    if (!response.ok)
      throw new Error(
        `failed to list release PR comments: HTTP ${response.status}`,
      );
    const rows = await response.json();
    if (!Array.isArray(rows))
      throw new Error("GitHub comment listing must be an array");
    comments.push(...rows);
    if (rows.length < 100) break;
  }
  const existing = comments.find((comment) =>
    String(comment.body || "").includes(marker),
  );

  if (existing) {
    const updateResponse = await fetchImpl(
      `${base}/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ body }),
      },
    );
    if (!updateResponse.ok) {
      throw new Error(
        `failed to update release PR comment: HTTP ${updateResponse.status}`,
      );
    }
    return { action: "updated", commentId: existing.id };
  }

  const createResponse = await fetchImpl(
    `${base}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    },
  );
  if (!createResponse.ok) {
    throw new Error(
      `failed to create release PR comment: HTTP ${createResponse.status}`,
    );
  }
  const created = await createResponse.json();
  return { action: "created", commentId: created.id };
}

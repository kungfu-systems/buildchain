export async function readGitHubSourceTree(
  { repository, sourceSha, token, apiUrl },
  request = fetch,
) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository || "") ||
    !/^[0-9a-f]{40}$/.test(sourceSha || "") ||
    !token
  )
    throw new Error(
      "Exact repository, source commit and scoped read credential required",
    );
  const response = await request(
    `${apiUrl || "https://api.github.com"}/repos/${repository}/git/commits/${sourceSha}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (!response.ok)
    throw new Error(
      `could not resolve admitted source tree: GitHub API ${response.status}`,
    );
  const commit = await response.json(),
    treeSha = String(commit.tree?.sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(treeSha))
    throw new Error("GitHub source tree is not an exact commit tree");
  return treeSha;
}

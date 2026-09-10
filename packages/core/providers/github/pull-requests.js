import { getOctokit } from "@actions/github";
export function pullRequestProvider({ repository, token, apiUrl }) {
  if (!token) throw new Error("A scoped pull request credential is required");
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra)
    throw new Error("Pull request repository must be owner/repo");
  const github = getOctokit(token, {
    baseUrl: apiUrl || "https://api.github.com",
  });
  return {
    listOpen: ({ head, base }) =>
      github.paginate(github.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        head: `${owner}:${head}`,
        base,
        per_page: 100,
      }),
    create: async ({ head, base, title, body }) =>
      (await github.rest.pulls.create({ owner, repo, head, base, title, body }))
        .data,
  };
}

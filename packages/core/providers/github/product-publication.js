export function productPublicationReader(github, repository) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || repository.split("/").length !== 2)
    throw new Error("Product publication repository must be owner/repo");
  return {
    commit: async (sha) =>
      (await github.rest.git.getCommit({ owner, repo, commit_sha: sha })).data,
    head: async (targetRef) =>
      (await github.rest.git.getRef({ owner, repo, ref: `heads/${targetRef}` }))
        .data.object.sha,
    states: () =>
      github.paginate(github.rest.git.listMatchingRefs, {
        owner,
        repo,
        ref: "heads/buildchain/v4-product-state/",
        per_page: 100,
      }),
    candidateStates: (sha) =>
      github.paginate(github.rest.git.listMatchingRefs, {
        owner,
        repo,
        ref: `heads/buildchain/v4-product-state/${sha}-`,
        per_page: 100,
      }),
    compare: async (base, head) =>
      (
        await github.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${base}...${head}`,
        })
      ).data.status,
    tag: async (version) => {
      try {
        return (
          await github.rest.git.getRef({ owner, repo, ref: `tags/v${version}` })
        ).data;
      } catch (error) {
        if (error.status !== 404) throw error;
        return undefined;
      }
    },
  };
}

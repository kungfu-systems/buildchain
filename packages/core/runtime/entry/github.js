export function runtimeEntryProvider(
  github,
  { sourceRepository, sourceSha, actor, eventName },
) {
  const parts = (repository) => {
    const [owner, repo] = repository.split("/");
    if (!owner || !repo)
      throw new Error("Runtime entry requires an owner/repository");
    return { owner, repo };
  };
  async function readJson(repository, ref, file, optional = false) {
    try {
      const { data } = await github.rest.repos.getContent({
        ...parts(repository),
        ref,
        path: file,
      });
      if (data.type !== "file" || data.encoding !== "base64")
        throw new Error(`Runtime entry expected a JSON file: ${file}`);
      return JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    } catch (error) {
      if (optional && error.status === 404) return undefined;
      throw error;
    }
  }
  return {
    readLock: (file) => readJson(sourceRepository, sourceSha, file, true),
    readRun: async ({ repository, runId }) =>
      (
        await github.rest.actions.getWorkflowRun({
          ...parts(repository),
          run_id: runId,
        })
      ).data,
    resolveRef: async ({ repository, ref }) =>
      (await github.rest.repos.getCommit({ ...parts(repository), ref })).data
        .sha,
    readProtocol: ({ repository, sha }) =>
      readJson(repository, sha, "architecture/runtime-entry.json"),
    authorize: async ({ origin }) => {
      if (origin !== "runtime-parameter") return;
      // GitHub already authorizes workflow_dispatch using repository Actions
      // write permission, including installation tokens without a collaborator.
      if (eventName === "workflow_dispatch") return;
      const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
        ...parts(sourceRepository),
        username: actor,
      });
      if (!["admin", "maintain", "write"].includes(data.permission))
        throw new Error(
          "Transient runtime selection requires repository write permission",
        );
    },
  };
}

export async function resolveGateRuntime({
  github,
  context,
  core,
  env = process.env,
}) {
  const repository = String(env.BUILDCHAIN_REPOSITORY || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("invalid Buildchain repository");
  const [owner, repo] = repository.split("/");
  const definitionSha = String(env.BUILDCHAIN_WORKFLOW_SHA || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(definitionSha))
    throw new Error("Gate runtime requires the exact defining workflow SHA");
  const requested = String(env.BUILDCHAIN_REQUESTED_REF || "")
    .trim()
    .replace(/^refs\/heads\//, "");
  const runtimeRef = requested || definitionSha;
  const exactSha = /^[0-9a-f]{40}$/i;
  if (
    requested &&
    requested.toLowerCase() !== definitionSha &&
    !/^v4(?:-alpha)?$/.test(requested)
  ) {
    if (
      !exactSha.test(requested) &&
      !/^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/.test(requested)
    ) {
      throw new Error(
        "Gate runtime override must be a current channel, train ref or exact SHA",
      );
    }
    if (context.eventName !== "workflow_dispatch")
      throw new Error(
        "Gate runtime override requires trusted workflow_dispatch",
      );
    const response = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username: context.actor,
    });
    if (!["admin", "maintain", "write"].includes(response.data.permission))
      throw new Error("Gate runtime override requires write permission");
  }
  const sha = exactSha.test(runtimeRef)
    ? runtimeRef.toLowerCase()
    : (await github.rest.repos.getCommit({ owner, repo, ref: runtimeRef })).data
        .sha;
  if (!exactSha.test(sha))
    throw new Error("Gate runtime did not resolve to an exact commit");
  core.setOutput("runtime-ref", runtimeRef);
  core.setOutput("runtime-sha", sha.toLowerCase());
}

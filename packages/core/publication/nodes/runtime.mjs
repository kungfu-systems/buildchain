export function classifyPublicationRuntime(ref) {
  if (/^v4(?:\.\d+\.\d+)?$/.test(ref)) return "stable";
  if (/^v4-alpha$|^v4\.\d+\.\d+-alpha\.\d+$/.test(ref)) return "alpha";
  if (/^[0-9a-f]{40}$/i.test(ref)) return "exact-sha";
  if (/^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/.test(ref)) return "train";
  return "development";
}
export async function resolvePublicationRuntime({
  github,
  context,
  core,
  env = process.env,
}) {
  const repository = String(env.BUILDCHAIN_REPOSITORY || "").trim(),
    requested = String(env.BUILDCHAIN_REQUESTED_REF || "")
      .trim()
      .replace(/^refs\/heads\//, "");
  const definitionSha = String(env.BUILDCHAIN_WORKFLOW_SHA || "").toLowerCase(),
    workflowRef = String(env.BUILDCHAIN_WORKFLOW_REF || "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw Error("Invalid publication runtime repository");
  if (!/^[0-9a-f]{40}$/.test(definitionSha))
    throw Error("Publication runtime requires the exact defining workflow SHA");
  const sameRepository = workflowRef.startsWith(
    `${repository}/.github/workflows/`,
  );
  if (!requested && !sameRepository)
    throw Error(
      "Default publication runtime must belong to its defining workflow repository",
    );
  const sameDefinition =
    sameRepository && requested.toLowerCase() === definitionSha;
  const official = /^v4(?:-alpha)?$/.test(requested),
    override = Boolean(requested && !official && !sameDefinition);
  if (override) {
    if (
      !/^[0-9a-f]{40}$/i.test(requested) &&
      !/^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/.test(requested)
    )
      throw Error(
        "Publication runtime override must be a current v4 train or exact SHA",
      );
    if (context.eventName !== "workflow_dispatch")
      throw Error(
        "Publication runtime override requires trusted workflow_dispatch",
      );
    const response = await github.rest.repos.getCollaboratorPermissionLevel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      username: context.actor,
    });
    if (!["admin", "maintain", "write"].includes(response.data.permission))
      throw Error("Publication runtime override requires write permission");
  }
  const ref = requested || definitionSha,
    [owner, repo] = repository.split("/");
  const sha = /^[0-9a-f]{40}$/i.test(ref)
    ? ref.toLowerCase()
    : (await github.rest.repos.getCommit({ owner, repo, ref })).data.sha;
  if (!/^[0-9a-f]{40}$/i.test(sha || ""))
    throw Error("Publication runtime did not resolve to a commit");
  const definitionRef = workflowRef
    .split("@")
    .at(-1)
    .replace(/^refs\/(?:heads|tags)\//, "");
  const result = {
    "runtime-ref": ref,
    "runtime-sha": sha.toLowerCase(),
    "runtime-class": classifyPublicationRuntime(requested || definitionRef),
    "runtime-override": String(override),
    "runtime-trust-decision": override
      ? "override-accepted"
      : official
        ? "official-channel"
        : "workflow-definition",
  };
  for (const [key, value] of Object.entries(result)) core.setOutput(key, value);
  return result;
}

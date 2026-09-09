const exactSha = /^[0-9a-f]{40}$/i;
const trainRef = /^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/;
const officialChannel = /^v4(?:-alpha)?$/;
function runtimeClass(ref) {
  if (exactSha.test(ref)) return "exact-sha";
  if (trainRef.test(ref)) return "train";
  if (/^v4(?:\.\d+\.\d+)?$/.test(ref)) return "stable";
  if (/^v4-alpha$|^v4\.\d+\.\d+-alpha\.\d+$/.test(ref)) return "alpha";
  return "development";
}
export async function resolveWebRuntime({
  github,
  context,
  core,
  env = process.env,
}) {
  const repository = String(env.BUILDCHAIN_REPOSITORY || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("invalid Buildchain repository");
  const [owner, repo] = repository.split("/");
  const workflowRef = String(env.BUILDCHAIN_WORKFLOW_REF || "");
  const sameRepository = workflowRef.startsWith(
    `${repository}/.github/workflows/`,
  );
  const definitionSha = String(env.BUILDCHAIN_WORKFLOW_SHA || "").toLowerCase();
  if (!exactSha.test(definitionSha))
    throw new Error("Web runtime requires the exact defining workflow SHA");
  const definitionRef = workflowRef
    .split("@")
    .at(-1)
    .replace(/^refs\/(?:heads|tags)\//, "");
  const requested = String(env.BUILDCHAIN_REQUESTED_REF || "")
    .trim()
    .replace(/^refs\/heads\//, "");
  if (!requested && !sameRepository)
    throw new Error(
      "Default Web runtime must belong to the defining workflow repository",
    );
  const override = requested !== "" && !officialChannel.test(requested);
  const decision = await authorizeWebRuntimeOverride({ requested, override, sameRepository, definitionSha, github, context });
  const selected = requested || definitionSha;
  const fullRef = trainRef.test(selected) ? `refs/heads/${selected}` : selected;
  const sha = exactSha.test(selected)
    ? selected.toLowerCase()
    : (await github.rest.repos.getCommit({ owner, repo, ref: fullRef })).data
        .sha;
  if (!exactSha.test(sha || ""))
    throw new Error("Web runtime did not resolve to a commit");
  const outputs = {
    "runtime-ref": selected,
    "runtime-full-ref": fullRef,
    "runtime-sha": sha.toLowerCase(),
    "runtime-class": runtimeClass(requested || definitionRef),
    "runtime-override": String(override),
    "runtime-trust-decision": decision,
    "workflow-shell-ref": definitionSha,
    "rollback-ref": definitionSha,
  };
  for (const [name, value] of Object.entries(outputs))
    core.setOutput(name, value);
  await core.summary
    .addHeading("Buildchain runtime")
    .addRaw(`- defining workflow: \`${workflowRef}\`\n`)
    .addRaw(`- workflow SHA: \`${definitionSha}\`\n`)
    .addRaw(`- requested runtime: \`${requested || "(default)"}\`\n`)
    .addRaw(`- resolved runtime SHA: \`${sha}\`\n`)
    .addRaw(`- stability: \`${outputs["runtime-class"]}\`\n`)
    .addRaw(`- trust decision: \`${decision}\`\n`)
    .write();
}

async function authorizeWebRuntimeOverride({ requested, override, sameRepository, definitionSha, github, context }) {
  let decision = requested ? "official-channel" : "workflow-definition";
  if (override) {
    if (!exactSha.test(requested) && !trainRef.test(requested))
      throw new Error(
        "Web runtime override must be a current v4 train or exact SHA",
      );
    const closedRelease =
      sameRepository &&
      context.eventName === "pull_request" &&
      context.payload.action === "closed" &&
      requested.toLowerCase() === definitionSha;
    if (!closedRelease) {
      if (context.eventName !== "workflow_dispatch")
        throw new Error(
          "Web runtime override requires trusted workflow_dispatch",
        );
      const response = await github.rest.repos.getCollaboratorPermissionLevel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        username: context.actor,
      });
      if (!["admin", "maintain", "write"].includes(response.data.permission))
        throw new Error("Web runtime override requires write permission");
    }
    decision = closedRelease
      ? "closed-release-pr-shell-runtime"
      : "override-accepted";
  }
  return decision;
}

import { repositoryActorPermission } from "../providers/github-permission.js";
const exactSha = /^[0-9a-f]{40}$/iu;
const train = /^train\/v4\/v4\.\d+\/[A-Za-z0-9._/-]+$/u;
const channel = /^v4(?:-alpha)?$/u;

export function classifyRuntime(ref) {
  if (/^v4(?:\.\d+\.\d+)?$/u.test(ref)) return "stable";
  if (/^v4-alpha$|^v4\.\d+\.\d+-alpha\.\d+$/u.test(ref)) return "alpha";
  if (exactSha.test(ref)) return "exact-sha";
  if (train.test(ref)) return "train";
  return "development";
}

function runtimeAdmission({
  purpose,
  repository,
  requestedRef = "",
  workflowSha,
  workflowRef = "",
}) {
  if (!["publication", "web", "gate"].includes(purpose))
    throw new Error("Unknown runtime admission purpose");
  repository = String(repository || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
    throw new Error("Invalid Buildchain repository");
  const definition = String(workflowSha || "").toLowerCase();
  if (!exactSha.test(definition))
    throw new Error("Runtime requires the exact defining workflow SHA");
  const requested = String(requestedRef)
    .trim()
    .replace(/^refs\/heads\//u, "");
  const sameRepository = workflowRef.startsWith(
    `${repository}/.github/workflows/`,
  );
  if (!requested && purpose !== "gate" && !sameRepository)
    throw new Error(
      "Default runtime must belong to the defining workflow repository",
    );
  const sameDefinition = requested.toLowerCase() === definition;
  // These are different existing authority contracts: Web accepts an explicit
  // same-definition selection only for a closed release PR or trusted dispatch.
  const implicitDefinition =
    purpose === "gate"
      ? sameDefinition
      : purpose === "publication" && sameRepository && sameDefinition;
  const override = Boolean(
    requested && !channel.test(requested) && !implicitDefinition,
  );
  const decision =
    requested && channel.test(requested)
      ? "official-channel"
      : "workflow-definition";
  return {
    purpose,
    repository,
    workflowRef,
    definition,
    requested,
    sameRepository,
    sameDefinition,
    override,
    decision,
  };
}
async function authorizeRuntimeOverride(
  { purpose, requested, sameRepository, sameDefinition },
  { github, context },
) {
  if (!exactSha.test(requested) && !train.test(requested))
    throw new Error(
      "Runtime override must be a current v4 train or exact SHA; current channel selectors are v4 and v4-alpha",
    );
  const closedRelease =
    purpose === "web" &&
    sameRepository &&
    sameDefinition &&
    context.eventName === "pull_request" &&
    context.payload?.action === "closed";
  if (!closedRelease) {
    if (context.eventName !== "workflow_dispatch")
      throw new Error("Runtime override requires trusted workflow_dispatch");
    const permission = await repositoryActorPermission(
      { ...context.repo, actor: context.actor },
      github,
    );
    if (!["admin", "maintain", "write"].includes(permission))
      throw new Error("Runtime override requires write permission");
  }
  return closedRelease
    ? "closed-release-pr-shell-runtime"
    : "override-accepted";
}
export async function selectRuntime(request, { github, context }) {
  const admitted = runtimeAdmission(request);
  const { purpose, repository, workflowRef, definition, requested, override } =
    admitted;
  const decision = override
    ? await authorizeRuntimeOverride(admitted, { github, context })
    : admitted.decision;
  const selected = requested || definition;
  const fullRef =
    purpose === "web" && train.test(selected)
      ? `refs/heads/${selected}`
      : selected;
  const [owner, repo] = repository.split("/");
  const sha = exactSha.test(selected)
    ? selected.toLowerCase()
    : (await github.rest.repos.getCommit({ owner, repo, ref: fullRef })).data
        .sha;
  if (!exactSha.test(sha || ""))
    throw new Error("Runtime did not resolve to an exact commit");
  const coordinate = {
    "runtime-ref": selected,
    "runtime-sha": sha.toLowerCase(),
  };
  if (purpose === "gate") return coordinate;
  const result = {
    ...coordinate,
    "runtime-class": classifyRuntime(
      requested ||
        workflowRef
          .split("@")
          .at(-1)
          .replace(/^refs\/(?:heads|tags)\//u, ""),
    ),
    "runtime-override": String(override),
    "runtime-trust-decision": decision,
  };
  if (purpose === "web")
    Object.assign(result, {
      "runtime-full-ref": fullRef,
      "workflow-shell-ref": definition,
      "rollback-ref": definition,
    });
  return result;
}

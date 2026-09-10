import { resolvePromotionChannel } from "./channel.js";
import { resolvePromotionIdentities } from "./identities.js";
import * as override from "../runtime-override-authorization.js";
import { normalizePromotionRequest } from "../promotion-request.js";

export async function routePromotion({
  github,
  context,
  request: requestValue,
  workflowRepository,
  workflowSha,
  workflowRef,
  packageVersion,
}) {
  const request = normalizePromotionRequest(requestValue);
  const repository = workflowRepository;
  const sha = String(workflowSha || "").toLowerCase();
  const coordinate = workflowRef || "";
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !coordinate.startsWith(`${repository}/.github/workflows/`)
  )
    throw Error("Promotion requires its exact defining workflow identity");
  if (request["buildchain-repository"] !== repository)
    throw Error(
      "Promotion runtime repository must match its defining workflow repository",
    );
  const routerRef = coordinate
    .split("@")
    .at(-1)
    .replace(/^refs\/(?:heads|tags)\//, "");
  const requestedRef = String(request["buildchain-ref"] || sha).replace(
    /^refs\/(?:heads|tags)\//,
    "",
  );
  if (
    !/^(?:v4(?:-alpha)?|[0-9a-f]{40}|(?:train|authority)\/v4\/v4\.\d+\/[\w./-]+)$/.test(
      requestedRef,
    ) ||
    requestedRef.includes("..")
  )
    throw Error(
      "Promotion runtime selection is outside the current v4 authority",
    );
  const route = resolvePromotionChannel({
    requestedChannel: request["buildchain-channel"],
    requestedRef,
    publicationChannel: request.channel,
    targetRef:
      request["target-ref"] || context.ref.replace(/^refs\/heads\//, ""),
    routerRef,
    routerSha: sha,
    packageVersion,
  });
  if (route.overrideUsed)
    await override.authorizePromotionRuntimeOverride({ github, context });
  const [owner, repo] = repository.split("/");
  const identities = await resolvePromotionIdentities({
    routerRef,
    routerSha: sha,
    shellRef: route.shellRef,
    shellCallRef: sha,
    runtimeRef: route.runtimeRef,
    resolveRef: async (ref) =>
      (await github.rest.repos.getCommit({ owner, repo, ref })).data.sha,
  });
  if (
    request["resume-candidate-run-id"] &&
    identities.runtimeSha !==
      String(request["resume-buildchain-runtime-sha"] || "").toLowerCase()
  )
    throw Error(
      "Recovery runtime does not match resume-buildchain-runtime-sha",
    );
  const output = {
    "request-json": JSON.stringify(request),
    repository,
    channel: route.channel,
    "publication-channel": route.publicationChannel,
    "target-ref": route.targetRef,
    "router-ref": routerRef,
    "router-sha": sha,
    "shell-ref": route.shellRef,
    "shell-call-ref": sha,
    "shell-sha": sha,
    "runtime-ref": route.runtimeRef,
    "runtime-sha": identities.runtimeSha,
    "override-used": String(route.overrideUsed),
    "selection-source": route.selectionSource,
    reason: route.reason,
  };
  return output;
}

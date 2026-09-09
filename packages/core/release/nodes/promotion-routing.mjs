import fs from "node:fs";
import path from "node:path";
import { resolvePromotionChannel } from "../commands/promotion-channel-router.mjs";
import { resolvePromotionIdentities } from "../commands/promotion-identity-resolver.mjs";
import * as override from "../runtime-override-authorization.js";
import { normalizePromotionRequest } from "../promotion-request.js";

export async function routePromotion({
  github,
  context,
  core,
  env = process.env,
}) {
  const request = normalizePromotionRequest(
    env.BUILDCHAIN_PROMOTION_REQUEST_JSON,
  );
  const repository = env.BUILDCHAIN_WORKFLOW_REPOSITORY;
  const sha = String(env.BUILDCHAIN_WORKFLOW_SHA || "").toLowerCase();
  const coordinate = env.BUILDCHAIN_WORKFLOW_REF || "";
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
  const packageVersion = JSON.parse(
    fs.readFileSync(
      new URL("../../../../package.json", import.meta.url),
      "utf8",
    ),
  ).version;
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
  for (const [key, value] of Object.entries(output)) core.setOutput(key, value);
  return output;
}

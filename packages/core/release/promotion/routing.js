import { resolvePromotionChannel } from "./channel.js";
import { normalizePromotionRequest } from "../promotion-request.js";

export async function routePromotion({ context, request: requestValue, workflowRepository, workflowSha, workflowRef, runtime }) {
  const request = normalizePromotionRequest(requestValue);
  const route = resolvePromotionChannel({
    publicationChannel: request.channel,
    targetRef: request["target-ref"] || context.ref.replace(/^refs\/heads\//u, ""),
  });
  const entryRef = workflowRef.split("@").at(-1).replace(/^refs\/(?:heads|tags)\//u, "");
  return {
    "request-json": JSON.stringify(request),
    repository: runtime.repository,
    channel: route.channel,
    "publication-channel": route.publicationChannel,
    "target-ref": route.targetRef,
    "router-ref": entryRef,
    "router-sha": workflowSha,
    "shell-ref": entryRef,
    "shell-call-ref": workflowSha,
    "shell-sha": workflowSha,
    "contract-lock-path": runtime.contract?.path,
    "runtime-ref": runtime.ref,
    "runtime-sha": runtime.sha,
    "override-used": String(runtime.origin === "runtime-parameter"),
    "selection-source": runtime.origin,
    reason: `Execute publication using the runtime selected by the entry (${runtime.origin})`,
  };
}

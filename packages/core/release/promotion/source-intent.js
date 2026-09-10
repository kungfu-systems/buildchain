import { planReleaseRoute } from "../release-invocation.js";
export async function qualifyPromotionSource(
  { requestedSha, targetRef, requestedChannel, dryRun, resume },
  reader,
) {
  const currentSha = await reader.head(targetRef),
    sourceCommit = await reader.commit(requestedSha);
  const timestamp = sourceCommit.committer?.date || sourceCommit.author?.date;
  if (!timestamp)
    throw new Error("requested source commit has no provider timestamp");
  const comparisonStatus =
    currentSha === requestedSha
      ? "identical"
      : await reader.compare(requestedSha, currentSha);
  const route = planReleaseRoute({
    requestedSha,
    observedSha: currentSha,
    comparisonStatus,
    requestedChannel,
    targetRef,
    dryRun,
    resume,
  });
  if (route.decision === "Blocked")
    throw new Error(`release route blocked: ${route.reason}`);
  return {
    action: route.decision === "NoOp" ? "noop" : "promote",
    reason: route.reason,
    channel: route.channel,
    "target-ref": route.targetRef,
    "requested-sha": route.requestedSha,
    "source-timestamp": new Date(timestamp).toISOString(),
    "current-sha": currentSha,
  };
}

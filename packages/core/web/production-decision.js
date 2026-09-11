import { createWebSurfaceProductionDecision } from "./web-surface-publication-candidate.js";

const TRUSTED_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export function resolveWebSurfaceProductionDecision({
  eventName,
  eventAction = "",
  refName,
  repository,
  sourceSha,
  actor,
  productionApply,
  productionApproved,
  productionReleaseOnMain,
  actorPermission = "",
  releaseApproved = false,
  releasePr = 0,
  releaseSource = "",
} = {}) {
  if (
    eventName === "workflow_dispatch" &&
    productionApply === true &&
    productionApproved === true
  ) {
    const trusted = TRUSTED_PERMISSIONS.has(String(actorPermission));
    return createWebSurfaceProductionDecision({
      approved: trusted,
      kind: trusted ? "manual-dispatch" : "none",
      repository,
      sourceSha,
      actor,
      actorPermission,
      reason: trusted
        ? "trusted-manual-dispatch"
        : "manual-actor-permission-insufficient",
    });
  }
  const reviewedReleaseEvent = eventName === "push" && refName === "main";
  if (
    reviewedReleaseEvent &&
    productionApply === true &&
    productionReleaseOnMain === true &&
    releaseApproved === true
  ) {
    return createWebSurfaceProductionDecision({
      approved: true,
      kind: "release-pr",
      repository,
      sourceSha,
      actor,
      releasePr,
      releaseSource,
      reason: "reviewed-release-pr-merged",
    });
  }
  if (
    eventName === "pull_request" &&
    eventAction === "closed" &&
    productionApply === true &&
    productionReleaseOnMain === true &&
    releaseApproved === true
  ) {
    return createWebSurfaceProductionDecision({
      approved: false,
      kind: "none",
      repository,
      sourceSha,
      actor,
      releasePr,
      releaseSource,
      reason: "release-pr-verified-awaiting-main-push",
    });
  }
  return createWebSurfaceProductionDecision({
    approved: false,
    kind: "none",
    repository,
    sourceSha,
    actor,
    actorPermission,
    releasePr,
    releaseSource,
    reason: "no-authorizing-production-event",
  });
}

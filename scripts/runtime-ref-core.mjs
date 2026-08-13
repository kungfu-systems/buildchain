import { parseBuildchainRefIdentity } from "../packages/core/buildchain-channel-identity.js";

const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;
const TRAIN_REF_RE = /^train\/v\d+\/v\d+\.\d+\/[A-Za-z0-9._/-]+$/;
const AUTHORITY_REF_RE = /^authority\/v\d+\/v\d+\.\d+\/[A-Za-z0-9._/-]+$/;
const OFFICIAL_CHANNEL_REF_RE = /^v\d+(?:\.\d+)?(?:-alpha)?$/;

export function parseWorkflowShellRef(workflowRef = "", fallback = "v3", buildchainRepository = "kungfu-systems/buildchain") {
  const value = String(workflowRef || "");
  const expectedPrefix = `${buildchainRepository}/.github/workflows/`;
  if (!value.startsWith(expectedPrefix)) {
    return fallback;
  }
  const ref = value.split("@").pop()?.trim();
  return (ref || fallback).replace(/^refs\/(?:heads|tags)\//, "");
}

export function classifyBuildchainRuntimeRef(ref = "") {
  const identity = parseBuildchainRefIdentity(ref);
  return identity.channel || (identity.kind === "missing" ? "development" : identity.kind);
}

export function isOfficialBuildchainChannelRef(ref = "") {
  const value = String(ref || "").trim().replace(/^refs\/tags\//, "");
  return OFFICIAL_CHANNEL_REF_RE.test(value);
}

export function normalizeRequestedRuntimeRef(requestedRef = "") {
  const requested = String(requestedRef || "").trim();
  if (!requested) {
    return { ref: "", fullRef: "", class: "", exactSha: false, officialChannel: false };
  }
  if (isOfficialBuildchainChannelRef(requested)) {
    const channelRef = requested.replace(/^refs\/tags\//, "");
    return {
      ref: channelRef,
      fullRef: channelRef,
      class: classifyBuildchainRuntimeRef(channelRef),
      exactSha: false,
      officialChannel: true,
    };
  }
  if (EXACT_SHA_RE.test(requested)) {
    return {
      ref: requested,
      fullRef: requested,
      class: "exact-sha",
      exactSha: true,
      officialChannel: false,
    };
  }
  const protectedRef = requested.replace(/^refs\/heads\//, "");
  if (!TRAIN_REF_RE.test(protectedRef) && !AUTHORITY_REF_RE.test(protectedRef)) {
    throw new Error(
      "buildchain-ref override must be train/vN/vN.M/<capability>, refs/heads/train/vN/vN.M/<capability>, authority/vN/vN.M/<capability>, refs/heads/authority/vN/vN.M/<capability>, or an exact 40-character SHA",
    );
  }
  return {
    ref: protectedRef,
    fullRef: `refs/heads/${protectedRef}`,
    class: AUTHORITY_REF_RE.test(protectedRef) ? "authority" : "train",
    exactSha: false,
    officialChannel: false,
  };
}

export function resolveRuntimeSelection({
  requestedRef = "",
  workflowRef = "",
  defaultStableRef = "v3",
  buildchainRepository = "kungfu-systems/buildchain",
} = {}) {
  const requested = String(requestedRef || "").trim();
  const workflowShellRef = parseWorkflowShellRef(workflowRef, defaultStableRef, buildchainRepository);
  if (!requested) {
    return {
      requestedRef: "",
      runtimeRef: workflowShellRef || defaultStableRef,
      runtimeFullRef: workflowShellRef || defaultStableRef,
      runtimeClass: classifyBuildchainRuntimeRef(workflowShellRef || defaultStableRef),
      runtimeOverride: false,
      workflowShellRef: workflowShellRef || defaultStableRef,
      rollbackRef: workflowShellRef || defaultStableRef,
      trustDecision: "stable-default",
    };
  }
  const normalized = normalizeRequestedRuntimeRef(requested);
  const sameRepositoryWorkflow = String(workflowRef || "").startsWith(
    `${buildchainRepository}/.github/workflows/`,
  );
  const pinnedSelfRuntime =
    sameRepositoryWorkflow &&
    normalized.exactSha &&
    EXACT_SHA_RE.test(workflowShellRef) &&
    normalized.ref.toLowerCase() === workflowShellRef.toLowerCase();
  const runtimeOverride = !normalized.officialChannel && !pinnedSelfRuntime;
  return {
    requestedRef: requested,
    runtimeRef: normalized.ref,
    runtimeFullRef: normalized.fullRef,
    runtimeClass: normalized.class,
    runtimeOverride,
    workflowShellRef: workflowShellRef || defaultStableRef,
    rollbackRef: workflowShellRef || defaultStableRef,
    trustDecision: normalized.officialChannel
      ? "official-channel"
      : pinnedSelfRuntime
        ? "pinned-self"
        : "override-requested",
  };
}

export function validateRuntimeOverrideTrust({
  requestedRef = "",
  eventName = "",
  eventAction = "",
  actorPermission = "",
  sameRepositoryPullRequest = false,
  sameRepositoryWorkflow = false,
  pullRequestHeadSha = "",
  workflowShellSha = "",
} = {}) {
  if (!String(requestedRef || "").trim()) {
    return { ok: true, decision: "stable-default" };
  }
  if (isOfficialBuildchainChannelRef(requestedRef)) {
    return { ok: true, decision: "official-channel" };
  }
  const normalizedRequested = String(requestedRef || "").trim().toLowerCase();
  const normalizedHeadSha = String(pullRequestHeadSha || "").trim().toLowerCase();
  const normalizedWorkflowShellSha = String(workflowShellSha || "").trim().toLowerCase();
  if (
    sameRepositoryWorkflow === true &&
    EXACT_SHA_RE.test(normalizedRequested) &&
    EXACT_SHA_RE.test(normalizedWorkflowShellSha) &&
    normalizedRequested === normalizedWorkflowShellSha
  ) {
    return { ok: true, decision: "pinned-self" };
  }
  if (
    eventName === "pull_request" &&
    eventAction === "closed" &&
    EXACT_SHA_RE.test(normalizedRequested) &&
    normalizedRequested === normalizedWorkflowShellSha
  ) {
    return { ok: true, decision: "closed-release-pr-shell-runtime" };
  }
  if (
    eventName === "pull_request" &&
    sameRepositoryPullRequest === true &&
    EXACT_SHA_RE.test(normalizedRequested) &&
    normalizedRequested === normalizedHeadSha
  ) {
    return { ok: true, decision: "same-repository-pr-head" };
  }
  if (eventName !== "workflow_dispatch") {
    return {
      ok: false,
      decision: "rejected-untrusted-event",
      reason: "buildchain-ref override is only allowed for trusted workflow_dispatch runs",
    };
  }
  if (!new Set(["admin", "maintain", "write"]).has(String(actorPermission || ""))) {
    return {
      ok: false,
      decision: "rejected-insufficient-permission",
      reason: "buildchain-ref override requires actor write, maintain, or admin permission",
    };
  }
  return { ok: true, decision: "override-accepted" };
}

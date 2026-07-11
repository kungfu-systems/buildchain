const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;
const TRAIN_REF_RE = /^train\/v\d+\/v\d+\.\d+\/[A-Za-z0-9._/-]+$/;
const OFFICIAL_CHANNEL_REF_RE = /^v\d+(?:\.\d+)?(?:-alpha)?$/;

export function parseWorkflowShellRef(workflowRef = "", fallback = "v2", buildchainRepository = "kungfu-systems/buildchain") {
  const value = String(workflowRef || "");
  const expectedPrefix = `${buildchainRepository}/.github/workflows/`;
  if (!value.startsWith(expectedPrefix)) {
    return fallback;
  }
  const ref = value.split("@").pop()?.trim();
  return (ref || fallback).replace(/^refs\/(?:heads|tags)\//, "");
}

export function classifyBuildchainRuntimeRef(ref = "") {
  const value = String(ref || "").trim().replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
  if (EXACT_SHA_RE.test(value)) {
    return "exact-sha";
  }
  if (TRAIN_REF_RE.test(value)) {
    return "train";
  }
  if (/^v\d+(?:\.\d+)?$/.test(value) || /^v\d+\.\d+\.\d+$/.test(value)) {
    return "stable";
  }
  if (/^v\d+(?:\.\d+)?-alpha$/.test(value) || /^v\d+\.\d+\.\d+-alpha\.\d+$/.test(value)) {
    return "alpha";
  }
  return "development";
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
  const trainRef = requested.replace(/^refs\/heads\//, "");
  if (!TRAIN_REF_RE.test(trainRef)) {
    throw new Error(
      "buildchain-ref override must be train/vN/vN.M/<capability>, refs/heads/train/vN/vN.M/<capability>, or an exact 40-character SHA",
    );
  }
  return {
    ref: trainRef,
    fullRef: `refs/heads/${trainRef}`,
    class: "train",
    exactSha: false,
    officialChannel: false,
  };
}

export function resolveRuntimeSelection({
  requestedRef = "",
  workflowRef = "",
  defaultStableRef = "v2",
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
  const runtimeOverride = !normalized.officialChannel;
  return {
    requestedRef: requested,
    runtimeRef: normalized.ref,
    runtimeFullRef: normalized.fullRef,
    runtimeClass: normalized.class,
    runtimeOverride,
    workflowShellRef: workflowShellRef || defaultStableRef,
    rollbackRef: workflowShellRef || defaultStableRef,
    trustDecision: normalized.officialChannel ? "official-channel" : "override-requested",
  };
}

export function validateRuntimeOverrideTrust({
  requestedRef = "",
  eventName = "",
  actorPermission = "",
} = {}) {
  if (!String(requestedRef || "").trim()) {
    return { ok: true, decision: "stable-default" };
  }
  if (isOfficialBuildchainChannelRef(requestedRef)) {
    return { ok: true, decision: "official-channel" };
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

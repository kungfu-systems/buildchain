const EXACT_SHA_RE = /^[0-9a-f]{40}$/i;
const TRAIN_REF_RE = /^train\/v\d+\/v\d+\.\d+\/[A-Za-z0-9._/-]+$/;

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

export function normalizeRequestedRuntimeRef(requestedRef = "") {
  const requested = String(requestedRef || "").trim();
  if (!requested) {
    return { ref: "", fullRef: "", class: "", exactSha: false };
  }
  if (EXACT_SHA_RE.test(requested)) {
    return { ref: requested, fullRef: requested, class: "exact-sha", exactSha: true };
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
  return {
    requestedRef: requested,
    runtimeRef: normalized.ref,
    runtimeFullRef: normalized.fullRef,
    runtimeClass: normalized.class,
    runtimeOverride: true,
    workflowShellRef: workflowShellRef || defaultStableRef,
    rollbackRef: workflowShellRef || defaultStableRef,
    trustDecision: "override-requested",
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

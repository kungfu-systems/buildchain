export const DEV_ALPHA_CANDIDATE_STATE_SCHEMA =
  "kungfu-buildchain-dev-alpha-candidate-state/v1";
export const STATE_MARKER_START = "<!-- buildchain-dev-alpha-candidate-state";
export const STATE_MARKER_END = "-->";
export const CANDIDATE_BODY_HEADING =
  "Buildchain exact-source channel candidate.";
export const EXACT_SHA = /^[0-9a-f]{40}$/u;
export const EVIDENCE_ROOT = /^sha256:[0-9a-f]{64}$/u;
export const ABSENT_STATE_ROOT = "absent";

export function text(value = "") {
  return String(value ?? "").trim();
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

export function autoMergeMethod(value, fallback = "merge") {
  const normalized = text(value || fallback).toLowerCase();
  if (!["merge", "squash", "rebase"].includes(normalized)) {
    throw new Error(
      `mergeMethod must be merge, squash, or rebase, got ${value || "<empty>"}`,
    );
  }
  return normalized;
}

export function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized))
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  return normalized;
}

export function branch(value, name) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (
    !normalized ||
    normalized.startsWith("-") ||
    /[\s~^:?*[\\]/.test(normalized)
  ) {
    throw new Error(`${name} is not a valid branch name`);
  }
  return normalized;
}

export function workflowPath(value, name) {
  const normalized = text(value);
  if (!/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(normalized)) {
    throw new Error(`${name} must be a repository workflow path`);
  }
  return normalized;
}

export function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function pullRequestBodyPrefix(value) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > 32768)
    throw new Error("pullRequestBodyPrefix exceeds 32768 characters");
  if (normalized.includes(STATE_MARKER_START))
    throw new Error(
      "pullRequestBodyPrefix must not contain the managed candidate state marker",
    );
  return normalized;
}

export function optionalExactSha(value, name) {
  const normalized = text(value);
  if (normalized && !EXACT_SHA.test(normalized))
    throw new Error(`${name} must be an exact 40-character commit SHA`);
  return normalized;
}

export function optionalStateRoot(value, name) {
  const normalized = text(value);
  if (
    normalized &&
    normalized !== ABSENT_STATE_ROOT &&
    !EVIDENCE_ROOT.test(normalized)
  ) {
    throw new Error(`${name} must be absent or an exact sha256 root`);
  }
  return normalized;
}

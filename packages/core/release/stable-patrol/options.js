export const LEDGER_PATH = ".buildchain/stable-candidate-ledger.json";

export function text(value = "") {
  return String(value ?? "").trim();
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase(),
  );
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

export function shouldEnableAutoMerge(options, pullRequest) {
  return options.autoMerge && !pullRequest.auto_merge;
}

function list(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  }
  return normalized;
}

function targetBranch(value) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!/^release\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error(
      `target branch must be release/vN/vN.M, got ${value || "<empty>"}`,
    );
  }
  return normalized;
}

function defaultLedgerRef(branch) {
  return `buildchain/candidate-ledger/${branch.replace(/^release\//, "")}`;
}

export function normalizeStableCandidatePatrolOptions(options = {}) {
  const target = targetBranch(options.targetBranch);
  return {
    repository: repository(options.repository),
    targetBranch: target,
    ledgerRef: text(options.ledgerRef) || defaultLedgerRef(target),
    minimumSoakSeconds: integer(options.minimumSoakSeconds, 3600),
    requiredChecks: list(options.requiredChecks || "alpha-release"),
    revokedVersions: list(options.revokedVersions),
    revokeReason: text(options.revokeReason) || "repository-policy-revocation",
    hold: bool(options.hold, false),
    holdReason: text(options.holdReason),
    releaseNow: text(options.releaseNow).replace(/^v/, ""),
    autoPromote: bool(options.autoPromote, false),
    autoMerge: bool(options.autoMerge, false),
    mergeMethod: autoMergeMethod(options.mergeMethod),
    dryRun: bool(options.dryRun, true),
    now: text(options.now) || new Date().toISOString(),
    outputPath:
      text(options.outputPath) || ".buildchain/patrol/stable-candidate.json",
  };
}

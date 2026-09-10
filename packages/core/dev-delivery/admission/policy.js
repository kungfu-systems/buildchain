import crypto from "node:crypto";
export const DEFAULT_BLOCK_LABELS = [
  "blocked",
  "do-not-merge",
  "work-in-progress",
];
export const DEFAULT_ALLOWED_HEAD_PREFIXES = [
  "feature/",
  "fix/",
  "chore/",
  "docs/",
  "ci/",
  "refactor/",
];
export const DEFAULT_REQUIRED_CHECKS = ["check"];
export const DEFAULT_READY_LABEL = "ready";
export const SUCCESS_STATES = new Set(["success"]);
export const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
export const VALID_LANDING_MODES = new Set(["auto", "direct", "queue"]);
export const VALID_WARRANT_MODES = new Set(["off", "required"]);
export const STATIC_SKIP_REASONS = new Set([
  "draft",
  "fork-or-cross-repository-head",
  "head-prefix-not-allowed",
  "missing-ready-label",
  "blocked-label",
]);
export const ADMISSION_CONTRACT = "kungfu-buildchain-dev-merge-queue-admission";
export const AGENT_ADMISSION_RESULT_SCHEMA =
  "kungfu.buildchain.dev-pr-admission-result/v1";
export const AGENT_ADMISSION_MARKER = "buildchain-dev-pr-admission:v1";
export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export function splitList(value, fallback = []) {
  if (Array.isArray(value))
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  if (!text) return [...fallback];
  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function boolOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

export function intOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function positiveIntOption(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function choiceOption(value, valid, fallback, field) {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  if (!valid.has(normalized)) {
    throw new Error(
      `${field} must be one of ${[...valid].join(", ")}, got: ${value || "<empty>"}`,
    );
  }
  return normalized;
}

export function normalizeRepo(value) {
  const text = String(value?.fullName || value || "").trim();
  const match = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match)
    throw new Error(`repository must be owner/repo, got: ${text || "<empty>"}`);
  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`,
  };
}

export function normalizeOptions(options = {}) {
  return {
    repository: normalizeRepo(options.repository),
    targetBranch: String(options.targetBranch || "").replace(
      /^refs\/heads\//,
      "",
    ),
    readyLabel: String(options.readyLabel || DEFAULT_READY_LABEL).trim(),
    blockLabels: splitList(options.blockLabels, DEFAULT_BLOCK_LABELS).map(
      (label) => label.toLowerCase(),
    ),
    allowedHeadPrefixes: splitList(
      options.allowedHeadPrefixes,
      DEFAULT_ALLOWED_HEAD_PREFIXES,
    ),
    requiredChecks: splitList(options.requiredChecks, DEFAULT_REQUIRED_CHECKS),
    queueAdmissionContext: String(options.queueAdmissionContext || "").trim(),
    activeLeaseContext: String(
      options.activeLeaseContext ||
        (choiceOption(
          options.warrantMode,
          VALID_WARRANT_MODES,
          "off",
          "delivery Warrant mode",
        ) === "required"
          ? "Queue family lease/exact"
          : ""),
    ).trim(),
    requireApproval: boolOption(options.requireApproval, true),
    sameRepositoryOnly: boolOption(options.sameRepositoryOnly, true),
    maxMerges: intOption(options.maxMerges, 1),
    mergeMethod: String(options.mergeMethod || "merge").trim(),
    landingMode: choiceOption(
      options.landingMode,
      VALID_LANDING_MODES,
      "auto",
      "landing mode",
    ),
    dryRun: boolOption(options.dryRun, true),
    pollMergeableAttempts: intOption(options.pollMergeableAttempts, 3),
    pollMergeableDelayMs: intOption(options.pollMergeableDelayMs, 1000),
    outputPath: String(
      options.outputPath || ".buildchain/dev-pr-auto-merge/result.json",
    ),
    targetPullRequestNumber: positiveIntOption(
      options.targetPullRequestNumber,
      0,
    ),
    expectedHeadSha: String(options.expectedHeadSha || "")
      .trim()
      .toLowerCase(),
    diagnosticContext: String(
      options.diagnosticContext || "Buildchain delivery intent",
    ).trim(),
    warrantMode: choiceOption(
      options.warrantMode,
      VALID_WARRANT_MODES,
      "off",
      "delivery Warrant mode",
    ),
    warrantResultPath: String(options.warrantResultPath || "").trim(),
    projectCutProofPath: String(options.projectCutProofPath || "").trim(),
    sourceProofPath: String(
      options.sourceProofPath || ".buildchain/dev-delivery/source-proof.json",
    ).trim(),
    sourcePatchRoot: String(options.sourcePatchRoot || "")
      .trim()
      .toLowerCase(),
    qualificationOnly: boolOption(options.qualificationOnly, false),
    verifiedDeliveryWarrant: options.verifiedDeliveryWarrant || null,
  };
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function contentRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(`${JSON.stringify(stableValue(value))}\n`)
    .digest("hex")}`;
}

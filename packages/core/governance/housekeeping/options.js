import path from "node:path";
const VALID_MODES = new Set(["report", "apply"]);
const DEFAULT_OUTPUT_DIRECTORY = ".buildchain/engineering-housekeeper";

function requiredString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function boolOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`boolean input must be true or false, got: ${value}`);
}

export function positiveInteger(value, fallback, field) {
  const selected =
    value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return selected;
}

function splitPatterns(value, fallback) {
  const normalized = String(value || "").trim();
  if (!normalized) return [...fallback];
  return [
    ...new Set(
      normalized
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeRepository(value) {
  const repository = requiredString(value, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`repository must be owner/repo, got: ${repository}`);
  }
  return repository;
}

function normalizeMode(value) {
  const mode = String(value || "report")
    .trim()
    .toLowerCase();
  if (!VALID_MODES.has(mode)) {
    throw new Error(`mode must be report or apply, got: ${value || "<empty>"}`);
  }
  return mode;
}

export function normalizeHousekeeperWorkflowOptions(options = {}) {
  const mode = normalizeMode(options.mode);
  const applyEnabled = boolOption(options.applyEnabled, false);
  if (mode === "apply" && !applyEnabled) {
    throw new Error("apply mode requires apply-enabled=true");
  }
  if (mode === "report" && applyEnabled) {
    throw new Error("apply-enabled=true is only valid when mode=apply");
  }
  return {
    mode,
    applyEnabled,
    repository: normalizeRepository(options.repository),
    targetBranch: String(options.targetBranch || "")
      .trim()
      .replace(/^refs\/heads\//, ""),
    staleDays: positiveInteger(options.staleDays, 30, "stale-days"),
    maxActions: positiveInteger(options.maxActions, 20, "max-actions"),
    protectedPatterns: splitPatterns(options.protectedPatterns, [
      "dev/**",
      "alpha/**",
      "release/**",
      "publish-gate/**",
    ]),
    retainedPatterns: splitPatterns(options.retainedPatterns, [
      "train/**",
      "authority/**",
    ]),
    temporaryBranchPatterns: splitPatterns(options.temporaryBranchPatterns, [
      "feature/**",
      "fix/**",
      "chore/**",
      "docs/**",
      "ci/**",
      "refactor/**",
    ]),
    stalePullRequestLabel: String(options.stalePullRequestLabel ?? "").trim(),
    observedAt: String(options.observedAt || new Date().toISOString()),
    appliedAt: String(options.appliedAt || new Date().toISOString()),
    outputDirectory: path.resolve(
      String(options.outputDirectory || DEFAULT_OUTPUT_DIRECTORY),
    ),
  };
}

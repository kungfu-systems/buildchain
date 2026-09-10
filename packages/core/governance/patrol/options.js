const DEFAULT_TARGET_BRANCH = "";
const DEFAULT_OUTPUT_PATH = ".buildchain/patrol/result.json";
const VALID_CADENCES = new Set(["daily", "weekly", "monthly"]);
const VALID_MODES = new Set([
  "cadence-default",
  "inspect",
  "merge-ready-dev-prs",
  "cleanup-safe",
]);

function splitList(value, fallback = []) {
  if (Array.isArray(value))
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  if (!text) return [...fallback];
  return text
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function boolOption(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(text);
}

function intOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeChoice(value, valid, fallback, field) {
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

function normalizeRepository(value) {
  const repository = String(value || "").trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(
      `repository must be owner/repo, got: ${repository || "<empty>"}`,
    );
  }
  return repository;
}

function normalizeTargetBranch(value) {
  const branch = String(value || DEFAULT_TARGET_BRANCH).replace(
    /^refs\/heads\//,
    "",
  );
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(branch)) {
    throw new Error(
      `target-branch must be a semver dev branch such as dev/v4/v4.1, got: ${branch || "<empty>"}`,
    );
  }
  return branch;
}

function defaultCapabilities(cadence) {
  if (cadence === "daily") return ["inspect", "merge-ready-dev-prs"];
  if (cadence === "weekly")
    return ["inspect", "release-health", "stale-state-health"];
  return ["inspect", "governance-health", "workflow-drift-health"];
}

function capabilitiesFor({ cadence, mode, capabilities }) {
  const explicit = splitList(capabilities);
  if (explicit.length > 0) return explicit;
  if (mode === "cadence-default") return defaultCapabilities(cadence);
  if (mode === "merge-ready-dev-prs") return ["inspect", "merge-ready-dev-prs"];
  if (mode === "cleanup-safe") return ["inspect", "cleanup-safe"];
  return ["inspect"];
}

export function normalizePatrolOptions(options = {}) {
  const cadence = normalizeChoice(
    options.cadence,
    VALID_CADENCES,
    "daily",
    "cadence",
  );
  const mode = normalizeChoice(
    options.mode,
    VALID_MODES,
    "cadence-default",
    "mode",
  );
  const targetBranch = normalizeTargetBranch(options.targetBranch);
  return {
    cadence,
    mode,
    capabilities: capabilitiesFor({
      cadence,
      mode,
      capabilities: options.capabilities,
    }),
    repository: normalizeRepository(options.repository),
    targetBranch,
    requiredChecks: options.requiredChecks,
    readyLabel: options.readyLabel,
    blockLabels: options.blockLabels,
    allowedHeadPrefixes: options.allowedHeadPrefixes,
    requireApproval: options.requireApproval,
    sameRepositoryOnly: options.sameRepositoryOnly,
    maxActions: intOption(options.maxActions, 1),
    mergeMethod: String(options.mergeMethod || "merge").trim(),
    landingMode: String(options.landingMode || "auto").trim(),
    dryRun: boolOption(options.dryRun, true),
    outputPath: String(options.outputPath || DEFAULT_OUTPUT_PATH),
  };
}

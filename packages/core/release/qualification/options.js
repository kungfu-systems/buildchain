const DEFAULTS = {
  buildWorkflowFile: "self-build-fixture.yml",
  buildWorkflowName: "Build Surface Fixture",
  canaryRepository: "kungfu-systems/site-libkungfu-dev",
  canaryWorkflowFile: "buildchain-stable-canary.yml",
  canaryWorkflowName: "Buildchain Stable Canary",
  canaryStatusContext: "buildchain-canary/site-libkungfu-dev",
  pollAttempts: 80,
  pollIntervalMs: 15_000,
};

export function text(value = "") {
  return String(value ?? "").trim();
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function repository(value) {
  const normalized = text(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`repository must be owner/repo, got ${value || "<empty>"}`);
  }
  return normalized;
}

export function optionalSha(value, label) {
  const normalized = text(value);
  if (normalized && !/^[0-9a-f]{40}$/i.test(normalized)) {
    throw new Error(
      `${label} must be an exact 40-character commit SHA, got ${normalized}`,
    );
  }
  return normalized;
}

function optionalRef(value, label) {
  const normalized = text(value);
  if (
    normalized &&
    (!/^[A-Za-z0-9._/-]+$/.test(normalized) ||
      normalized.includes("..") ||
      normalized.startsWith("/") ||
      normalized.endsWith("/"))
  ) {
    throw new Error(
      `${label} must be a safe branch or tag ref, got ${normalized}`,
    );
  }
  return normalized;
}

export function normalizeStableCandidateQualificationOptions(options = {}) {
  const candidateSha = text(options.candidateSha);
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error(
      `candidate SHA must be 40 hexadecimal characters, got ${candidateSha || "<empty>"}`,
    );
  }
  const canaryRef = optionalRef(options.canaryRef, "canary ref");
  const canarySha = optionalSha(options.canarySha, "canary SHA");
  if (Boolean(canaryRef) !== Boolean(canarySha)) {
    throw new Error("canary ref and canary SHA must be provided together");
  }
  return {
    repository: repository(options.repository),
    candidateSha,
    buildWorkflowFile:
      text(options.buildWorkflowFile) || DEFAULTS.buildWorkflowFile,
    buildWorkflowName:
      text(options.buildWorkflowName) || DEFAULTS.buildWorkflowName,
    canaryRepository: repository(
      options.canaryRepository ?? DEFAULTS.canaryRepository,
    ),
    canaryWorkflowFile:
      text(options.canaryWorkflowFile) || DEFAULTS.canaryWorkflowFile,
    canaryWorkflowName:
      text(options.canaryWorkflowName) || DEFAULTS.canaryWorkflowName,
    canaryStatusContext:
      text(options.canaryStatusContext) || DEFAULTS.canaryStatusContext,
    canaryRef,
    canarySha,
    pollAttempts: integer(options.pollAttempts, DEFAULTS.pollAttempts),
    pollIntervalMs: integer(options.pollIntervalMs, DEFAULTS.pollIntervalMs),
    dryRun: bool(options.dryRun, false),
  };
}

export function successful(run) {
  return run?.status === "completed" && run?.conclusion === "success";
}

export function active(run) {
  return run && run.status !== "completed";
}

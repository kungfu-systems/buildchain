import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RELEASE_TRANSACTION_STATES = Object.freeze([
  "prepared",
  "publishing",
  "publish_failed",
  "published",
  "finalizing",
  "complete",
  "repair_required",
  "abandoned",
  "failed_permanently",
]);

const TERMINAL_STATES = new Set(["complete", "abandoned", "failed_permanently"]);
const BLOCKED_RECOVERY_STATES = new Set(["abandoned", "failed_permanently"]);

const ALLOWED_TRANSITIONS = new Map([
  ["prepared", new Set(["publishing", "abandoned", "failed_permanently"])],
  ["publishing", new Set(["publish_failed", "published", "repair_required", "abandoned", "failed_permanently"])],
  ["publish_failed", new Set(["publishing", "repair_required", "abandoned", "failed_permanently"])],
  ["published", new Set(["finalizing", "complete", "repair_required", "abandoned", "failed_permanently"])],
  ["finalizing", new Set(["complete", "repair_required", "failed_permanently"])],
  ["repair_required", new Set(["publishing", "abandoned", "failed_permanently"])],
  ["complete", new Set([])],
  ["abandoned", new Set(["publishing"])],
  ["failed_permanently", new Set(["publishing"])],
]);

function nowIso() {
  return new Date().toISOString();
}

function assertKnownState(state, label = "transaction state") {
  if (!RELEASE_TRANSACTION_STATES.includes(state)) {
    throw new Error(`${label} must be one of ${RELEASE_TRANSACTION_STATES.join(", ")}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function releaseTransactionId({ repository, version, sourceSha, targetRef }) {
  return sha256(
    stableJson({
      repository: assertNonEmptyString(repository, "repository"),
      version: assertNonEmptyString(version, "version"),
      source_sha: assertNonEmptyString(sourceSha, "sourceSha"),
      target_ref: assertNonEmptyString(targetRef, "targetRef"),
    }),
  );
}

export function releaseTransactionStateRef(version) {
  const safeVersion = encodeURIComponent(assertNonEmptyString(version, "version"))
    .replaceAll("%", "_")
    .replaceAll(".", "-");
  return `buildchain/release-state/${safeVersion}`;
}

export function defaultReleaseStatePath(version, workspace = process.cwd()) {
  return path.join(workspace, ".buildchain", "release-state", `${version}.json`);
}

export function defaultPublishEvidenceDir(version, workspace = process.cwd()) {
  return path.join(workspace, ".buildchain", "release-evidence", version);
}

export function defaultPublishEvidencePath(version, workspace = process.cwd()) {
  return path.join(defaultPublishEvidenceDir(version, workspace), "evidence.json");
}

export function createReleaseTransaction({
  repository,
  version,
  exactTag = "",
  channel,
  line = "",
  sourceSha,
  targetRef,
  releaseSha,
  releaseMaterialSha = releaseSha,
  publishToolingSha = "",
  lifecycleIdentity = "lifecycle.publish",
  statePath = "",
  evidencePath = "",
  actor = "",
  runId = "",
} = {}) {
  const id = releaseTransactionId({ repository, version, sourceSha, targetRef });
  const createdAt = nowIso();
  return {
    schema: 1,
    id,
    repository: assertNonEmptyString(repository, "repository"),
    target_ref: assertNonEmptyString(targetRef, "targetRef"),
    source_sha: assertNonEmptyString(sourceSha, "sourceSha"),
    release_sha: assertNonEmptyString(releaseSha, "releaseSha"),
    release_material_sha: assertNonEmptyString(releaseMaterialSha, "releaseMaterialSha"),
    publish_tooling_sha: optionalString(publishToolingSha || releaseSha),
    version: assertNonEmptyString(version, "version"),
    exact_tag: assertNonEmptyString(exactTag || version, "exactTag"),
    channel: assertNonEmptyString(channel, "channel"),
    line: optionalString(line),
    version_strategy: "",
    lifecycle_identity: assertNonEmptyString(lifecycleIdentity, "lifecycleIdentity"),
    state_ref: releaseTransactionStateRef(version),
    state_path: statePath ? posixPath(statePath) : "",
    evidence_path: evidencePath ? posixPath(evidencePath) : "",
    state: "prepared",
    previous_state: "",
    actor: optionalString(actor),
    run_id: optionalString(runId),
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function transitionReleaseTransaction(record, nextState, metadata = {}) {
  if (!record || typeof record !== "object") {
    throw new Error("release transaction record must be an object");
  }
  const currentState = record.state || "prepared";
  assertKnownState(currentState, "current transaction state");
  assertKnownState(nextState, "next transaction state");
  if (currentState !== nextState) {
    const allowed = ALLOWED_TRANSITIONS.get(currentState) || new Set();
    if (!allowed.has(nextState)) {
      throw new Error(`cannot transition release transaction from ${currentState} to ${nextState}`);
    }
  }
  const nextFailure = nextState === "complete"
    ? optionalString(metadata.failure ?? "")
    : optionalString(metadata.failure ?? record.failure);
  return {
    ...record,
    previous_state: currentState === nextState ? record.previous_state || "" : currentState,
    state: nextState,
    actor: optionalString(metadata.actor ?? record.actor),
    run_id: optionalString(metadata.runId ?? record.run_id),
    superseded_by: optionalString(metadata.supersededBy ?? record.superseded_by),
    failure: nextFailure,
    updated_at: nowIso(),
  };
}

export function readReleaseTransaction(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assertKnownState(record.state || "prepared");
  return record;
}

export function writeReleaseTransaction(filePath, record) {
  if (!filePath) {
    return record;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function artifactIdentity(artifact) {
  return [
    artifact.group || "",
    artifact.kind,
    artifact.name,
    artifact.ref || "",
  ].join("\0");
}

function artifactMatchesRequirement(actual, required) {
  return (
    actual.kind === required.kind &&
    actual.name === required.name &&
    (!required.ref || actual.ref === required.ref) &&
    (!required.group || actual.group === required.group)
  );
}

export function normalizePublishArtifact(artifact, label = "artifact") {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`${label} must be an object`);
  }
  const role = optionalString(artifact.role);
  if (role && !["main", "platform"].includes(role)) {
    throw new Error(`${label}.role must be one of main or platform`);
  }
  return {
    group: optionalString(artifact.group),
    kind: assertNonEmptyString(artifact.kind, `${label}.kind`),
    name: assertNonEmptyString(artifact.name, `${label}.name`),
    ref: optionalString(artifact.ref),
    digest: assertNonEmptyString(artifact.digest, `${label}.digest`),
    role,
    required: artifact.required === undefined ? true : Boolean(artifact.required),
  };
}

export function parsePublishArtifactsJson(value, label = "publish artifacts") {
  const raw = String(value || "").trim();
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed.map((artifact, index) =>
    normalizePublishArtifact(artifact, `${label}[${index}]`),
  );
}

export function normalizePublishEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("publish evidence must be an object");
  }
  if (Number(evidence.schema) !== 1) {
    throw new Error("publish evidence schema must be 1");
  }
  const artifacts = Array.isArray(evidence.artifacts)
    ? evidence.artifacts.map((artifact, index) =>
        normalizePublishArtifact(artifact, `artifacts[${index}]`),
      )
    : [];
  return {
    schema: 1,
    version: assertNonEmptyString(evidence.version, "evidence.version"),
    channel: assertNonEmptyString(evidence.channel, "evidence.channel"),
    source_sha: assertNonEmptyString(evidence.source_sha, "evidence.source_sha"),
    release_sha: assertNonEmptyString(evidence.release_sha, "evidence.release_sha"),
    target_ref: optionalString(evidence.target_ref),
    release_material_sha: optionalString(evidence.release_material_sha || evidence.release_sha),
    publish_tooling_sha: optionalString(evidence.publish_tooling_sha || evidence.release_sha),
    artifacts,
  };
}

export function readPublishEvidence(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  return normalizePublishEvidence(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

export function planArtifactPublish({ requiredArtifacts = [], existingArtifacts = [] } = {}) {
  const required = requiredArtifacts.map((artifact, index) =>
    normalizePublishArtifact(artifact, `requiredArtifacts[${index}]`),
  );
  const existing = existingArtifacts.map((artifact, index) =>
    normalizePublishArtifact(artifact, `existingArtifacts[${index}]`),
  );
  const existingByIdentity = new Map(existing.map((artifact) => [artifactIdentity(artifact), artifact]));
  const publish = [];
  const accepted = [];
  const conflicts = [];
  for (const artifact of required) {
    const current =
      existingByIdentity.get(artifactIdentity(artifact)) ||
      existing.find((candidate) => artifactMatchesRequirement(candidate, artifact));
    if (!current) {
      publish.push(artifact);
      continue;
    }
    if (current.digest !== artifact.digest) {
      conflicts.push({ expected: artifact, actual: current });
      continue;
    }
    accepted.push(current);
  }
  return {
    publish,
    accepted,
    conflicts,
    complete: publish.length === 0 && conflicts.length === 0,
    repairRequired: conflicts.length > 0,
  };
}

export function validatePublishEvidence({
  evidence,
  version,
  channel,
  sourceSha,
  releaseSha,
  targetRef = "",
  releaseMaterialSha = releaseSha,
  publishToolingSha = "",
  requiredArtifacts = [],
} = {}) {
  const normalized = normalizePublishEvidence(evidence);
  const errors = [];
  const check = (actual, expected, label) => {
    if (expected && actual !== expected) {
      errors.push(`${label} mismatch: expected ${expected}, got ${actual || "<empty>"}`);
    }
  };
  check(normalized.version, version, "version");
  check(normalized.channel, channel, "channel");
  check(normalized.source_sha, sourceSha, "source_sha");
  check(normalized.release_sha, releaseSha, "release_sha");
  check(normalized.target_ref, targetRef, "target_ref");
  check(normalized.release_material_sha, releaseMaterialSha, "release_material_sha");
  if (publishToolingSha) {
    check(normalized.publish_tooling_sha, publishToolingSha, "publish_tooling_sha");
  }

  const artifactPlan = planArtifactPublish({
    requiredArtifacts,
    existingArtifacts: normalized.artifacts,
  });
  for (const artifact of artifactPlan.publish) {
    errors.push(
      `required artifact missing: ${[artifact.kind, artifact.name, artifact.ref]
        .filter(Boolean)
        .join(":")}`,
    );
  }
  for (const conflict of artifactPlan.conflicts) {
    errors.push(
      `artifact digest mismatch: ${conflict.expected.kind}:${conflict.expected.name}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    evidence: normalized,
    artifactPlan,
  };
}

export function assertTransactionIdentity(record, expected, { allowToolingDrift = true } = {}) {
  const errors = [];
  const check = (actual, wanted, label) => {
    if (wanted && actual !== wanted) {
      errors.push(`${label} mismatch: expected ${wanted}, got ${actual || "<empty>"}`);
    }
  };
  check(record.repository, expected.repository, "repository");
  check(record.version, expected.version, "version");
  check(record.source_sha, expected.sourceSha, "source_sha");
  check(record.target_ref, expected.targetRef, "target_ref");
  check(record.release_material_sha, expected.releaseMaterialSha, "release_material_sha");
  if (!allowToolingDrift) {
    check(record.publish_tooling_sha, expected.publishToolingSha, "publish_tooling_sha");
  }
  if (errors.length > 0) {
    throw new Error(`release transaction identity mismatch: ${errors.join("; ")}`);
  }
}

export function planTransactionRecovery({
  transaction,
  evidence,
  validation,
  explicitOverride = false,
} = {}) {
  if (!transaction) {
    return { action: "prepare", blocked: false, reason: "no existing transaction" };
  }
  const state = transaction.state || "prepared";
  assertKnownState(state);
  if (BLOCKED_RECOVERY_STATES.has(state) && !explicitOverride) {
    return {
      action: "blocked",
      blocked: true,
      reason: `transaction is ${state}${transaction.superseded_by ? ` by ${transaction.superseded_by}` : ""}`,
    };
  }
  if (state === "complete") {
    return { action: "inspect", blocked: false, reason: "transaction is complete" };
  }
  if (state === "repair_required" && !explicitOverride) {
    return { action: "blocked", blocked: true, reason: "transaction requires explicit repair" };
  }
  const result = validation || (evidence ? { valid: true } : undefined);
  if (result?.valid) {
    return { action: "finalize", blocked: false, reason: "publish evidence is valid" };
  }
  if (state === "published" || state === "finalizing") {
    return { action: "repair", blocked: true, reason: "published transaction has invalid or missing evidence" };
  }
  return { action: "publish", blocked: false, reason: "publish evidence is missing or incomplete" };
}

export function isReleaseTransactionTerminal(record) {
  return TERMINAL_STATES.has(record?.state);
}

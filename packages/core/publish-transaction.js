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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function normalizeArtifactCoordinate(value, label, { partial = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const field = (key) => {
    if (partial && !hasOwn(value, key)) {
      return undefined;
    }
    return assertNonEmptyString(value[key], `${label}.${key}`);
  };
  const normalized = {};
  for (const key of ["version", "ref", "source_sha", "material_sha"]) {
    const item = field(key);
    if (item !== undefined) {
      normalized[key] = item;
    }
  }
  if (hasOwn(value, "target_ref")) {
    normalized.target_ref = assertNonEmptyString(value.target_ref, `${label}.target_ref`);
  }
  return normalized;
}

function normalizeArtifactVerification(value, label, { partial = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const normalized = {};
  const stringField = (key) => {
    if (hasOwn(value, key)) {
      normalized[key] = assertNonEmptyString(value[key], `${label}.${key}`);
    }
  };
  for (const key of ["ref", "digest", "platform", "parent_digest", "evidence"]) {
    stringField(key);
  }
  if (hasOwn(value, "public_manifest")) {
    normalized.public_manifest = value.public_manifest === true;
  }
  const contractMajor = optionalPositiveInteger(value.contract_major, `${label}.contract_major`);
  if (contractMajor !== undefined) {
    normalized.contract_major = contractMajor;
  }
  if (hasOwn(value, "smoke")) {
    if (!value.smoke || typeof value.smoke !== "object" || Array.isArray(value.smoke)) {
      throw new Error(`${label}.smoke must be an object`);
    }
    normalized.smoke = {};
    for (const key of ["policy", "evidence"]) {
      if (hasOwn(value.smoke, key)) {
        normalized.smoke[key] = assertNonEmptyString(value.smoke[key], `${label}.smoke.${key}`);
      }
    }
    if (hasOwn(value.smoke, "passed")) {
      normalized.smoke.passed = value.smoke.passed === true;
    }
  }
  if (!partial) {
    for (const key of ["ref", "digest", "platform", "evidence"]) {
      assertNonEmptyString(normalized[key], `${label}.${key}`);
    }
    if (normalized.public_manifest !== true) {
      throw new Error(`${label}.public_manifest must be true`);
    }
    if (normalized.contract_major === undefined) {
      throw new Error(`${label}.contract_major must be a positive integer`);
    }
    if (!normalized.smoke || normalized.smoke.passed !== true) {
      throw new Error(`${label}.smoke.passed must be true`);
    }
    assertNonEmptyString(normalized.smoke.policy, `${label}.smoke.policy`);
    assertNonEmptyString(normalized.smoke.evidence, `${label}.smoke.evidence`);
  }
  return normalized;
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

export function normalizePublishArtifact(
  artifact,
  label = "artifact",
  { requireDigest = true, partialProvenance = !requireDigest } = {},
) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw new Error(`${label} must be an object`);
  }
  const role = optionalString(artifact.role);
  if (role && !["main", "platform"].includes(role)) {
    throw new Error(`${label}.role must be one of main or platform`);
  }
  const action = optionalString(artifact.action);
  if (action && !["built", "reused"].includes(action)) {
    throw new Error(`${label}.action must be one of built or reused`);
  }
  const digest = requireDigest
    ? assertNonEmptyString(artifact.digest, `${label}.digest`)
    : optionalString(artifact.digest);
  const contractMajor = optionalPositiveInteger(artifact.contract_major, `${label}.contract_major`);
  const normalized = {
    group: optionalString(artifact.group),
    kind: assertNonEmptyString(artifact.kind, `${label}.kind`),
    name: assertNonEmptyString(artifact.name, `${label}.name`),
    ref: optionalString(artifact.ref),
    digest,
    role,
    required: artifact.required === undefined ? true : Boolean(artifact.required),
  };
  if (action) {
    normalized.action = action;
  }
  for (const key of ["platform", "parent_digest"]) {
    if (hasOwn(artifact, key)) {
      normalized[key] = assertNonEmptyString(artifact[key], `${label}.${key}`);
    }
  }
  if (contractMajor !== undefined) {
    normalized.contract_major = contractMajor;
  }
  for (const key of ["content", "release"]) {
    if (hasOwn(artifact, key)) {
      normalized[key] = normalizeArtifactCoordinate(
        artifact[key],
        `${label}.${key}`,
        { partial: partialProvenance },
      );
    }
  }
  if (hasOwn(artifact, "verification")) {
    normalized.verification = normalizeArtifactVerification(
      artifact.verification,
      `${label}.verification`,
      { partial: partialProvenance },
    );
  }
  if (requireDigest && action) {
    for (const key of ["content", "release"]) {
      if (!normalized[key]) {
        throw new Error(`${label}.${key} is required when action is ${action}`);
      }
    }
    if (normalized.kind === "oci") {
      if (!normalized.platform) {
        throw new Error(`${label}.platform is required for OCI provenance`);
      }
      if (!normalized.contract_major) {
        throw new Error(`${label}.contract_major is required for OCI provenance`);
      }
      if (!normalized.verification) {
        throw new Error(`${label}.verification is required for OCI provenance`);
      }
      const verification = normalized.verification;
      const comparisons = [
        [verification.ref, normalized.ref, "ref"],
        [verification.digest, normalized.digest, "digest"],
        [verification.platform, normalized.platform, "platform"],
        [verification.contract_major, normalized.contract_major, "contract_major"],
        [verification.parent_digest || "", normalized.parent_digest || "", "parent_digest"],
      ];
      for (const [actual, expected, field] of comparisons) {
        if (actual !== expected) {
          throw new Error(
            `${label}.verification.${field} mismatch: expected ${expected || "<empty>"}, got ${actual || "<empty>"}`,
          );
        }
      }
    }
  }
  return normalized;
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
    normalizePublishArtifact(artifact, `${label}[${index}]`, { requireDigest: false }),
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
  const identities = new Set();
  for (const artifact of artifacts) {
    const identity = artifactIdentity(artifact);
    if (identities.has(identity)) {
      throw new Error(`duplicate publish artifact: ${artifact.kind}:${artifact.name}:${artifact.ref}`);
    }
    identities.add(identity);
  }
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
    normalizePublishArtifact(artifact, `requiredArtifacts[${index}]`, { requireDigest: false }),
  );
  const existing = existingArtifacts.map((artifact, index) =>
    normalizePublishArtifact(artifact, `existingArtifacts[${index}]`),
  );
  const publish = [];
  const accepted = [];
  const conflicts = [];
  for (const artifact of required) {
    const candidates = existing.filter((candidate) => (
      candidate.kind === artifact.kind &&
      candidate.name === artifact.name &&
      (!artifact.group || candidate.group === artifact.group)
    ));
    const current = candidates.find((candidate) => artifactMatchesRequirement(candidate, artifact));
    if (!current) {
      if (candidates.length > 0) {
        conflicts.push({ expected: artifact, actual: candidates[0], fields: ["ref"] });
        continue;
      }
      publish.push(artifact);
      continue;
    }
    const fields = [];
    if (artifact.digest && current.digest !== artifact.digest) {
      fields.push("digest");
    }
    const compareSubset = (actual, expected, prefix = "") => {
      for (const [key, value] of Object.entries(expected || {})) {
        if (["group", "kind", "name", "ref", "digest", "role", "required"].includes(key) && !prefix) {
          continue;
        }
        const field = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          compareSubset(actual?.[key], value, field);
        } else if (actual?.[key] !== value) {
          fields.push(field);
        }
      }
    };
    compareSubset(current, artifact);
    if (fields.length > 0) {
      conflicts.push({ expected: artifact, actual: current, fields });
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

export function resolvePublishArtifactRequirements(
  requiredArtifacts,
  { version, targetRef, sourceSha, releaseMaterialSha } = {},
) {
  return requiredArtifacts.map((artifact, index) => {
    const normalized = normalizePublishArtifact(
      artifact,
      `requiredArtifacts[${index}]`,
      { requireDigest: false },
    );
    normalized.ref ||= assertNonEmptyString(version, "version");
    if (!normalized.action) {
      return normalized;
    }
    const current = {
      version: assertNonEmptyString(version, "version"),
      ref: normalized.ref,
      source_sha: assertNonEmptyString(sourceSha, "sourceSha"),
      material_sha: assertNonEmptyString(releaseMaterialSha, "releaseMaterialSha"),
    };
    if (normalized.action === "built") {
      normalized.content = { ...current, ...(normalized.content || {}) };
    } else if (!normalized.content) {
      throw new Error(`requiredArtifacts[${index}].content is required when action is reused`);
    }
    normalized.release = {
      ...current,
      target_ref: assertNonEmptyString(targetRef, "targetRef"),
      ...(normalized.release || {}),
    };
    return normalized;
  });
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
    const fields = conflict.fields || ["digest"];
    const category = fields.length === 1 && fields[0] === "digest"
      ? "artifact digest mismatch"
      : "artifact coordinate or provenance mismatch";
    errors.push(`${category}: ${conflict.expected.kind}:${conflict.expected.name}:${fields.join(",")}`);
  }
  for (const [index, artifact] of normalized.artifacts.entries()) {
    if (!artifact.action) {
      continue;
    }
    const checks = [
      [artifact.release?.version, version, "release.version"],
      [artifact.release?.ref, artifact.ref, "release.ref"],
      [artifact.release?.target_ref, targetRef, "release.target_ref"],
      [artifact.release?.source_sha, sourceSha, "release.source_sha"],
      [artifact.release?.material_sha, releaseMaterialSha, "release.material_sha"],
    ];
    for (const [actual, expected, field] of checks) {
      if (actual !== expected) {
        errors.push(
          `artifact provenance mismatch: artifacts[${index}].${field}: expected ${expected || "<empty>"}, got ${actual || "<empty>"}`,
        );
      }
    }
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

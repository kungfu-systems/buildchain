import crypto from "node:crypto";

export const PUBLICATION_AUTHORITY_REGISTRY_CONTRACT =
  "kungfu-buildchain-publication-authority-registry";
export const PUBLICATION_ADMISSION_CONTRACT =
  "kungfu-buildchain-publication-admission";
export const PUBLICATION_CAPABILITY_CONTRACT =
  "kungfu-buildchain-publication-capability";
export const RUNNER_PROVENANCE_CONTRACT =
  "kungfu-buildchain-runner-provenance";
export const PUBLICATION_CONTROL_PLANE_AUDIT_CONTRACT =
  "kungfu-buildchain-publication-control-plane-audit";

export const PUBLICATION_AUTHORITY_CLASSES = Object.freeze([
  "product-publication",
  "evidence-publication",
  "governance-write",
  "non-publication-oidc",
  "dry-run-only",
  "retired-deny",
]);

export const RUNNER_PROVENANCE_CLASSES = Object.freeze([
  "ephemeral",
  "reimaged",
  "persistent-measured",
  "unqualified",
]);

const QUALIFIED_RUNNER_CLASSES = new Set([
  "ephemeral",
  "reimaged",
  "persistent-measured",
]);
const REQUIRED_CONTROL_PLANE_FACTS = Object.freeze([
  "actions-policy",
  "branch-policy",
  "environment-policy",
  "oidc-policy",
  "publisher-policy",
  "runner-policy",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function publicationAuthorityDigest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function requiredString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function normalizeDigest(value, label) {
  const normalized = requiredString(value, label).replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return normalized.toLowerCase();
}

function parseTime(value, label) {
  const time = Date.parse(requiredString(value, label));
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`);
  return time;
}

export function detectPublicationAuthoritySignals(workflowText = "") {
  const text = String(workflowText);
  const signals = [];
  const rules = [
    ["write-all", /permissions\s*:\s*write-all|permissions\s*:\s*\{[^}]*write-all/i],
    ["write-permission", /^\s*(?:contents|packages|deployments|checks|issues|pull-requests|actions)\s*:\s*write\s*$/im],
    ["oidc", /^\s*id-token\s*:\s*write\s*$/im],
    ["environment", /^\s*environment\s*:/im],
    ["npm-publish", /\bnpm\s+(?:stage\s+)?publish\b/i],
    ["github-release", /\bgh\s+release\b|repos\.createRelease|repos\.updateRelease/i],
    ["git-push", /\bgit\s+push\b/i],
    ["cloud-credential", /configure-aws-credentials|google-github-actions\/auth|azure\/login/i],
  ];
  for (const [id, pattern] of rules) if (pattern.test(text)) signals.push(id);
  return signals;
}

export function createPublicationAuthorityRegistry({ descriptors = [], workflows = [] } = {}) {
  const byPath = new Map();
  for (const descriptor of descriptors) {
    const workflowPath = requiredString(descriptor.workflowPath, "descriptor.workflowPath");
    const authorityClass = requiredString(descriptor.authorityClass, `${workflowPath}.authorityClass`);
    if (!PUBLICATION_AUTHORITY_CLASSES.includes(authorityClass)) {
      throw new Error(`${workflowPath} has unknown publication authority class: ${authorityClass}`);
    }
    if (byPath.has(workflowPath)) throw new Error(`duplicate publication authority descriptor: ${workflowPath}`);
    byPath.set(workflowPath, {
      workflowPath,
      authorityClass,
      publicationCapable: descriptor.publicationCapable === true,
      capabilityIds: [...new Set((descriptor.capabilityIds || []).map(String))].sort(),
      credentialMode: String(descriptor.credentialMode || "none"),
      environment: String(descriptor.environment || ""),
      runnerPolicy: String(descriptor.runnerPolicy || "unqualified"),
      notes: String(descriptor.notes || ""),
    });
  }

  const workflowFacts = workflows.map((workflow) => {
    const workflowPath = requiredString(workflow.path, "workflow.path");
    const signals = detectPublicationAuthoritySignals(workflow.text);
    const descriptor = byPath.get(workflowPath);
    if (signals.length > 0 && !descriptor) {
      throw new Error(`authority-bearing workflow is not classified: ${workflowPath} (${signals.join(", ")})`);
    }
    return { path: workflowPath, signals, classified: Boolean(descriptor) };
  });

  const entries = [...byPath.values()].sort((left, right) => left.workflowPath.localeCompare(right.workflowPath));
  const registry = {
    schemaVersion: 1,
    contract: PUBLICATION_AUTHORITY_REGISTRY_CONTRACT,
    defaultDecision: "deny",
    entries,
    workflowFacts: workflowFacts.sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { ...registry, registryDigest: publicationAuthorityDigest(registry) };
}

export function createRunnerProvenance({
  runnerClass,
  os,
  architecture,
  imageDigest,
  measurementDigest,
  isolation = "",
} = {}) {
  const normalizedClass = requiredString(runnerClass, "runnerClass");
  if (!RUNNER_PROVENANCE_CLASSES.includes(normalizedClass)) {
    throw new Error(`unknown runner provenance class: ${normalizedClass}`);
  }
  const receipt = {
    schemaVersion: 1,
    contract: RUNNER_PROVENANCE_CONTRACT,
    runnerClass: normalizedClass,
    os: requiredString(os, "os"),
    architecture: requiredString(architecture, "architecture"),
    imageDigest: normalizeDigest(imageDigest, "imageDigest"),
    measurementDigest: normalizeDigest(measurementDigest, "measurementDigest"),
    isolation: String(isolation),
  };
  return { ...receipt, receiptDigest: publicationAuthorityDigest(receipt) };
}

export function createPublicationControlPlaneAudit({
  repository,
  workflowPath,
  environment,
  facts = [],
  observedAt,
  expiresAt,
} = {}) {
  const normalizedFacts = facts.map((fact, index) => ({
    id: requiredString(fact.id, `facts[${index}].id`),
    status: requiredString(fact.status, `facts[${index}].status`),
    digest: normalizeDigest(fact.digest, `facts[${index}].digest`),
  }));
  const receipt = {
    schemaVersion: 1,
    contract: PUBLICATION_CONTROL_PLANE_AUDIT_CONTRACT,
    repository: requiredString(repository, "repository"),
    workflowPath: requiredString(workflowPath, "workflowPath"),
    environment: requiredString(environment, "environment"),
    observedAt: new Date(parseTime(observedAt, "observedAt")).toISOString(),
    expiresAt: new Date(parseTime(expiresAt, "expiresAt")).toISOString(),
    facts: normalizedFacts.sort((left, right) => left.id.localeCompare(right.id)),
  };
  return { ...receipt, receiptDigest: publicationAuthorityDigest(receipt) };
}

function validateRunnerProvenance(receipt, expectedDigest) {
  if (receipt?.contract !== RUNNER_PROVENANCE_CONTRACT) throw new Error("runner provenance contract mismatch");
  if (!QUALIFIED_RUNNER_CLASSES.has(receipt.runnerClass)) {
    throw new Error(`runner provenance is not qualified: ${receipt.runnerClass || "unknown"}`);
  }
  const { receiptDigest: supplied, ...payload } = receipt;
  const actual = publicationAuthorityDigest(payload);
  if (normalizeDigest(supplied, "runnerProvenance.receiptDigest") !== actual) {
    throw new Error("runner provenance digest mismatch");
  }
  if (expectedDigest && normalizeDigest(expectedDigest, "runnerProvenanceDigest") !== actual) {
    throw new Error("runner provenance binding mismatch");
  }
  return actual;
}

function validateControlPlaneAudit(receipt, { workflowPath, environment, now, expectedDigest }) {
  if (receipt?.contract !== PUBLICATION_CONTROL_PLANE_AUDIT_CONTRACT) {
    throw new Error("publication control-plane audit contract mismatch");
  }
  if (receipt.workflowPath !== workflowPath) throw new Error("control-plane workflow binding mismatch");
  if (receipt.environment !== environment) throw new Error("control-plane environment binding mismatch");
  if (parseTime(receipt.observedAt, "controlPlaneAudit.observedAt") > now) {
    throw new Error("control-plane audit is from the future");
  }
  if (parseTime(receipt.expiresAt, "controlPlaneAudit.expiresAt") <= now) {
    throw new Error("control-plane audit is stale");
  }
  const facts = new Map((receipt.facts || []).map((fact) => [fact.id, fact]));
  for (const id of REQUIRED_CONTROL_PLANE_FACTS) {
    const fact = facts.get(id);
    if (!fact) throw new Error(`control-plane audit is missing required fact: ${id}`);
    if (fact.status !== "pass") throw new Error(`control-plane audit fact did not pass: ${id}`);
    normalizeDigest(fact.digest, `controlPlaneAudit.${id}.digest`);
  }
  const { receiptDigest: supplied, ...payload } = receipt;
  const actual = publicationAuthorityDigest(payload);
  if (normalizeDigest(supplied, "controlPlaneAudit.receiptDigest") !== actual) {
    throw new Error("control-plane audit digest mismatch");
  }
  if (expectedDigest && normalizeDigest(expectedDigest, "controlPlaneAuditDigest") !== actual) {
    throw new Error("control-plane audit binding mismatch");
  }
  return actual;
}

export function verifyPublicationAdmission({
  admission,
  registry,
  runnerProvenance,
  controlPlaneAudit,
  expected = {},
  usedNonces = [],
  now = new Date(),
} = {}) {
  if (admission?.contract !== PUBLICATION_ADMISSION_CONTRACT) {
    throw new Error("publication admission contract mismatch");
  }
  if (registry?.contract !== PUBLICATION_AUTHORITY_REGISTRY_CONTRACT) {
    throw new Error("publication authority registry contract mismatch");
  }
  const { registryDigest: suppliedRegistryDigest, ...registryPayload } = registry;
  const actualRegistryDigest = publicationAuthorityDigest(registryPayload);
  if (normalizeDigest(suppliedRegistryDigest, "registry.registryDigest") !== actualRegistryDigest) {
    throw new Error("publication authority registry digest mismatch");
  }
  if (normalizeDigest(admission.registryDigest, "admission.registryDigest") !== actualRegistryDigest) {
    throw new Error("publication authority registry binding mismatch");
  }

  const workflowPath = requiredString(admission.workflowPath, "admission.workflowPath");
  const descriptor = registry.entries?.find((entry) => entry.workflowPath === workflowPath);
  if (!descriptor) throw new Error(`unknown publication workflow: ${workflowPath}`);
  if (!descriptor.publicationCapable || descriptor.authorityClass !== "product-publication") {
    throw new Error(`workflow is not product-publication capable: ${workflowPath}`);
  }
  if (!descriptor.environment) throw new Error("publication authority descriptor has no protected environment");

  const nowMs = now instanceof Date ? now.getTime() : parseTime(now, "now");
  const issuedAt = parseTime(admission.issuedAt, "admission.issuedAt");
  const expiresAt = parseTime(admission.expiresAt, "admission.expiresAt");
  if (issuedAt > nowMs) throw new Error("publication admission is from the future");
  if (expiresAt <= nowMs) throw new Error("publication admission is stale");
  if (expiresAt - issuedAt > 15 * 60 * 1000) throw new Error("publication admission lifetime exceeds 15 minutes");
  const nonce = requiredString(admission.nonce, "admission.nonce");
  if (new Set(usedNonces.map(String)).has(nonce)) throw new Error("publication admission nonce was replayed");

  const bindings = [
    "repository",
    "sourceSha",
    "runtimeSha",
    "contractDigest",
    "policyDigest",
    "controllerReceiptDigest",
    "product",
    "target",
    "version",
    "channel",
    "artifactDigest",
  ];
  for (const key of bindings) {
    const actual = requiredString(admission[key], `admission.${key}`);
    if (expected[key] !== undefined && String(expected[key]) !== actual) {
      throw new Error(`publication admission ${key} binding mismatch`);
    }
  }
  for (const key of ["sourceSha", "runtimeSha", "contractDigest", "policyDigest", "controllerReceiptDigest", "artifactDigest"]) {
    normalizeDigest(admission[key], `admission.${key}`);
  }

  const runnerDigest = validateRunnerProvenance(runnerProvenance, admission.runnerProvenanceDigest);
  const controlPlaneDigest = validateControlPlaneAudit(controlPlaneAudit, {
    workflowPath,
    environment: descriptor.environment,
    now: nowMs,
    expectedDigest: admission.controlPlaneAuditDigest,
  });
  const { admissionDigest: suppliedAdmissionDigest, producerDecision: _ignored, ...admissionPayload } = admission;
  const actualAdmissionDigest = publicationAuthorityDigest(admissionPayload);
  if (normalizeDigest(suppliedAdmissionDigest, "admission.admissionDigest") !== actualAdmissionDigest) {
    throw new Error("publication admission digest mismatch");
  }

  const capability = {
    schemaVersion: 1,
    contract: PUBLICATION_CAPABILITY_CONTRACT,
    decision: "allow",
    workflowPath,
    capabilityIds: descriptor.capabilityIds,
    repository: admission.repository,
    product: admission.product,
    target: admission.target,
    version: admission.version,
    channel: admission.channel,
    artifactDigest: normalizeDigest(admission.artifactDigest, "admission.artifactDigest"),
    admissionDigest: actualAdmissionDigest,
    runnerProvenanceDigest: runnerDigest,
    controlPlaneAuditDigest: controlPlaneDigest,
    nonce,
    expiresAt: admission.expiresAt,
  };
  return { ...capability, capabilityDigest: publicationAuthorityDigest(capability) };
}

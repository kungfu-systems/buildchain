import crypto from "node:crypto";

import { validateControllerReceipt } from "./controller-evidence.js";
import { sha256Json, validateReleaseCandidatePassport } from "./release-candidate.js";

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
export const PUBLICATION_GATE_DECISION_CONTRACT =
  "kungfu-buildchain-publication-gate-decision";
export const PUBLICATION_ARTIFACT_MANIFEST_SET_CONTRACT =
  "kungfu-buildchain-publication-artifact-manifest-set";

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

function normalizeGitSha(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(normalized)) {
    throw new Error(`${label} must be a 40- or 64-character Git commit SHA`);
  }
  return normalized;
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
      environmentMode: String(descriptor.environmentMode || "fixed"),
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
  baselineDigest = "",
  toolchainDigest = "",
  cacheContractDigest = "",
  taskIsolationDigest = "",
  cleanBaselineProven = false,
  isolation = "",
} = {}) {
  const normalizedClass = requiredString(runnerClass, "runnerClass");
  if (!RUNNER_PROVENANCE_CLASSES.includes(normalizedClass)) {
    throw new Error(`unknown runner provenance class: ${normalizedClass}`);
  }
  const measuredFloor = [baselineDigest, toolchainDigest, cacheContractDigest, taskIsolationDigest].every(Boolean);
  const qualificationStatus = normalizedClass === "ephemeral"
    ? (String(isolation).trim() ? "qualifying" : "unqualified")
    : ["reimaged", "persistent-measured"].includes(normalizedClass)
      ? (cleanBaselineProven === true && measuredFloor ? "qualifying" : "unqualified")
      : "unqualified";
  const receipt = {
    schemaVersion: 1,
    contract: RUNNER_PROVENANCE_CONTRACT,
    runnerClass: normalizedClass,
    os: requiredString(os, "os"),
    architecture: requiredString(architecture, "architecture"),
    imageDigest: normalizeDigest(imageDigest, "imageDigest"),
    measurementDigest: normalizeDigest(measurementDigest, "measurementDigest"),
    baselineDigest: baselineDigest ? normalizeDigest(baselineDigest, "baselineDigest") : "",
    toolchainDigest: toolchainDigest ? normalizeDigest(toolchainDigest, "toolchainDigest") : "",
    cacheContractDigest: cacheContractDigest ? normalizeDigest(cacheContractDigest, "cacheContractDigest") : "",
    taskIsolationDigest: taskIsolationDigest ? normalizeDigest(taskIsolationDigest, "taskIsolationDigest") : "",
    cleanBaselineProven: cleanBaselineProven === true,
    qualificationStatus,
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

export function createPublicationAdmission(input = {}) {
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_ADMISSION_CONTRACT,
    registryDigest: normalizeDigest(input.registryDigest, "registryDigest"),
    workflowPath: requiredString(input.workflowPath, "workflowPath"),
    repository: requiredString(input.repository, "repository"),
    sourceSha: normalizeGitSha(input.sourceSha, "sourceSha"),
    runtimeSha: normalizeGitSha(input.runtimeSha, "runtimeSha"),
    contractDigest: normalizeDigest(input.contractDigest, "contractDigest"),
    policyDigest: normalizeDigest(input.policyDigest, "policyDigest"),
    controllerReceiptDigest: normalizeDigest(input.controllerReceiptDigest, "controllerReceiptDigest"),
    runnerProvenanceDigest: normalizeDigest(input.runnerProvenanceDigest, "runnerProvenanceDigest"),
    controlPlaneAuditDigest: normalizeDigest(input.controlPlaneAuditDigest, "controlPlaneAuditDigest"),
    gateAggregateDigest: normalizeDigest(input.gateAggregateDigest, "gateAggregateDigest"),
    environment: requiredString(input.environment, "environment"),
    product: requiredString(input.product, "product"),
    target: requiredString(input.target, "target"),
    version: requiredString(input.version, "version"),
    channel: requiredString(input.channel, "channel"),
    artifactDigest: normalizeDigest(input.artifactDigest, "artifactDigest"),
    nonce: requiredString(input.nonce, "nonce"),
    issuedAt: new Date(parseTime(input.issuedAt, "issuedAt")).toISOString(),
    expiresAt: new Date(parseTime(input.expiresAt, "expiresAt")).toISOString(),
  };
  return { ...payload, admissionDigest: publicationAuthorityDigest(payload) };
}

export function createPublicationGateDecision({
  sourceSha,
  profile,
  required = false,
  rationale,
  policy = {},
} = {}) {
  const normalizedPolicy = {
    profile: requiredString(profile, "profile"),
    required: required === true,
    rationale: requiredString(rationale, "rationale"),
    policy,
  };
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_GATE_DECISION_CONTRACT,
    sourceSha: normalizeGitSha(sourceSha, "sourceSha"),
    policyDigest: publicationAuthorityDigest(normalizedPolicy),
    ...normalizedPolicy,
  };
  return { ...payload, digest: publicationAuthorityDigest(payload) };
}

export function createPublicationArtifactManifestSet({
  repository,
  sourceSha,
  sourceTreeSha,
  manifests = [],
  payloads = [],
} = {}) {
  const normalizedRepository = requiredString(repository, "repository");
  const normalizedSourceSha = normalizeGitSha(sourceSha, "sourceSha");
  const normalizedSourceTreeSha = normalizeGitSha(sourceTreeSha, "sourceTreeSha");
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new Error("publication artifact manifest set requires at least one manifest");
  }
  if (!Array.isArray(payloads) || payloads.length !== manifests.length) {
    throw new Error("publication artifact payload set must exactly match the manifest set");
  }
  const payloadMap = new Map();
  for (const [index, payload] of payloads.entries()) {
    const artifactName = requiredString(payload?.artifactName, `artifactPayloads[${index}].artifactName`);
    if (payloadMap.has(artifactName)) throw new Error(`duplicate publication artifact payload: ${artifactName}`);
    if (!Array.isArray(payload.files)) throw new Error(`artifactPayloads[${index}].files must be an array`);
    payloadMap.set(artifactName, payload.files);
  }
  const artifacts = manifests.map((manifest, index) => {
    if (manifest?.contract !== "kungfu-buildchain-artifact") {
      throw new Error(`artifactManifests[${index}] contract mismatch`);
    }
    if (manifest.git?.repository !== normalizedRepository) {
      throw new Error(`artifactManifests[${index}] repository mismatch`);
    }
    if (manifest.git?.sha !== normalizedSourceSha) {
      throw new Error(`artifactManifests[${index}] source SHA mismatch`);
    }
    if (manifest.expectedArtifacts?.ok !== true) {
      throw new Error(`artifactManifests[${index}] expected artifacts did not qualify`);
    }
    const artifactName = requiredString(manifest.artifactName, `artifactManifests[${index}].artifactName`);
    if (manifest.summary?.contract !== "kungfu-buildchain-artifact-summary") {
      throw new Error(`artifactManifests[${index}] summary contract mismatch`);
    }
    if (manifest.summary?.artifactName !== artifactName || manifest.summary?.platform?.id !== manifest.platform?.id) {
      throw new Error(`artifactManifests[${index}] summary identity mismatch`);
    }
    if (!Array.isArray(manifest.files)) throw new Error(`artifactManifests[${index}].files must be an array`);
    const declaredFiles = manifest.files.map((file, fileIndex) => {
      const filePath = requiredString(file?.path, `artifactManifests[${index}].files[${fileIndex}].path`);
      if (filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) {
        throw new Error(`artifactManifests[${index}] contains an unsafe file path`);
      }
      return {
        path: filePath,
        size: Number(file?.size),
        sha256: normalizeDigest(file?.sha256, `artifactManifests[${index}].files[${fileIndex}].sha256`),
      };
    });
    if (new Set(declaredFiles.map((file) => file.path)).size !== declaredFiles.length) {
      throw new Error(`artifactManifests[${index}] contains duplicate file paths`);
    }
    if (declaredFiles.some((file) => !Number.isSafeInteger(file.size) || file.size < 0)) {
      throw new Error(`artifactManifests[${index}] contains an invalid file size`);
    }
    const totalBytes = declaredFiles.reduce((sum, file) => sum + file.size, 0);
    const contentHash = crypto.createHash("sha256");
    for (const file of declaredFiles) contentHash.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
    const contentDigest = contentHash.digest("hex");
    if (manifest.summary.fileCount !== declaredFiles.length || manifest.summary.totalBytes !== totalBytes) {
      throw new Error(`artifactManifests[${index}] summary counts mismatch`);
    }
    if (normalizeDigest(manifest.summary.digest, `artifactManifests[${index}].summary.digest`) !== contentDigest) {
      throw new Error(`artifactManifests[${index}] summary digest mismatch`);
    }
    const declaredPayloadFiles = declaredFiles.filter((file) => !file.path.startsWith(".buildchain/"));
    if (declaredPayloadFiles.length === 0) {
      throw new Error(`artifactManifests[${index}] declares no independently verifiable product payload files`);
    }
    const actualFiles = payloadMap.get(artifactName);
    if (!actualFiles) throw new Error(`publication artifact payload is missing: ${artifactName}`);
    const normalizedActualFiles = actualFiles.map((file, fileIndex) => ({
      path: requiredString(file?.path, `artifactPayloads[${index}].files[${fileIndex}].path`),
      size: Number(file?.size),
      sha256: normalizeDigest(file?.sha256, `artifactPayloads[${index}].files[${fileIndex}].sha256`),
    }));
    const byPath = (left, right) => left.path.localeCompare(right.path);
    if (JSON.stringify([...declaredPayloadFiles].sort(byPath)) !== JSON.stringify([...normalizedActualFiles].sort(byPath))) {
      throw new Error(`publication artifact payload bytes do not match manifest: ${artifactName}`);
    }
    return {
      artifactName,
      platformId: requiredString(manifest.platform?.id, `artifactManifests[${index}].platform.id`),
      manifestDigest: publicationAuthorityDigest(manifest),
      contentDigest,
      productPayloadDigest: publicationAuthorityDigest([...normalizedActualFiles].sort(byPath)),
    };
  }).sort((left, right) => left.artifactName.localeCompare(right.artifactName));
  const payload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_MANIFEST_SET_CONTRACT,
    repository: normalizedRepository,
    sourceSha: normalizedSourceSha,
    sourceTreeSha: normalizedSourceTreeSha,
    artifacts,
  };
  return { ...payload, manifestSetDigest: publicationAuthorityDigest(payload) };
}

function validateGateAggregate(gateAggregate, { admission, passport }) {
  if (gateAggregate?.contract === "buildchain.shifu-gate-aggregate/v1") {
    const { digest, ...payload } = gateAggregate;
    const actualDigest = sha256Json(payload);
    if (normalizeDigest(digest, "gateAggregate.digest") !== actualDigest) {
      throw new Error("gate aggregate digest mismatch");
    }
    if (gateAggregate.status !== "pass" || gateAggregate.qualifying !== true) {
      throw new Error("gate aggregate is not qualifying");
    }
    if (![admission.sourceSha, passport.source?.headSha].includes(gateAggregate.sourceSha)) {
      throw new Error("gate aggregate source SHA mismatch");
    }
    normalizeDigest(gateAggregate.registry?.digest, "gateAggregate.registry.digest");
    const policyDigest = normalizeDigest(gateAggregate.matrixDigest, "gateAggregate.matrixDigest");
    return { gateAggregateDigest: actualDigest, policyDigest };
  }
  if (gateAggregate?.contract !== PUBLICATION_GATE_DECISION_CONTRACT) {
    throw new Error("gate evidence must be a Shifu Gate aggregate or explicit publication Gate decision");
  }
  const { digest, ...payload } = gateAggregate;
  const actualDigest = publicationAuthorityDigest(payload);
  if (normalizeDigest(digest, "gateDecision.digest") !== actualDigest) {
    throw new Error("publication Gate decision digest mismatch");
  }
  if (gateAggregate.required !== false) {
    throw new Error("a required Gate policy must supply a qualifying Shifu Gate aggregate");
  }
  if (![admission.sourceSha, passport.source?.headSha].includes(gateAggregate.sourceSha)) {
    throw new Error("publication Gate decision source SHA mismatch");
  }
  const normalizedPolicy = {
    profile: requiredString(gateAggregate.profile, "gateDecision.profile"),
    required: false,
    rationale: requiredString(gateAggregate.rationale, "gateDecision.rationale"),
    policy: gateAggregate.policy || {},
  };
  const policyDigest = publicationAuthorityDigest(normalizedPolicy);
  if (normalizeDigest(gateAggregate.policyDigest, "gateDecision.policyDigest") !== policyDigest) {
    throw new Error("publication Gate policy digest mismatch");
  }
  return { gateAggregateDigest: actualDigest, policyDigest };
}

function validatePublicationEvidence(publicationEvidence, admission) {
  if (!publicationEvidence || typeof publicationEvidence !== "object" || Array.isArray(publicationEvidence)) {
    throw new Error("independent publication evidence is required");
  }
  const passport = publicationEvidence.releaseCandidatePassport;
  const buildSummary = publicationEvidence.buildSummary;
  const passportValidation = validateReleaseCandidatePassport({
    passport,
    buildSummary,
    repository: admission.repository,
    targetChannel: admission.channel,
  });
  if (!passportValidation.ok) {
    throw new Error(`release-candidate passport did not qualify: ${passportValidation.errors.join("; ")}`);
  }
  const candidateHash = sha256Json({
    repository: passport.repository,
    target: passport.target,
    source: passport.source,
    platformMatrix: passport.platformMatrix,
    buildchain: passport.buildchain,
    ...(passport.gateProfileEvidence ? { gateProfileEvidence: passport.gateProfileEvidence } : {}),
    ...(passport.controllerReceipts ? { controllerReceipts: passport.controllerReceipts } : {}),
  });
  if (normalizeDigest(passport.candidateHash, "releaseCandidatePassport.candidateHash") !== candidateHash) {
    throw new Error("release-candidate passport candidate hash mismatch");
  }
  const sourceTreeSha = normalizeGitSha(publicationEvidence.sourceTreeSha, "publicationEvidence.sourceTreeSha");
  if (passport.source?.treeHash !== sourceTreeSha) {
    throw new Error("release-candidate source tree does not match the admitted source commit");
  }
  const controllerReceipt = publicationEvidence.controllerReceipt;
  const controllerValidation = validateControllerReceipt(controllerReceipt, {
    expectedSourceSha: passport.source?.headSha || "",
    expectedRuntimeSha: passport.buildchain?.sha || "",
  });
  if (!controllerValidation.ok || !controllerValidation.qualifying) {
    throw new Error(`controller receipt did not qualify: ${controllerValidation.issues.join("; ")}`);
  }
  const reference = (passport.controllerReceipts || []).find(
    (entry) => entry.controllerId === controllerReceipt.controller?.id,
  );
  if (!reference || reference.receiptDigest !== controllerReceipt.digest) {
    throw new Error("release-candidate controller receipt reference mismatch");
  }
  const controllerReceiptDigest = normalizeDigest(controllerReceipt.digest, "controllerReceipt.digest");
  if (controllerReceiptDigest !== normalizeDigest(admission.controllerReceiptDigest, "admission.controllerReceiptDigest")) {
    throw new Error("controller receipt evidence binding mismatch");
  }
  const contractDigest = normalizeDigest(controllerReceipt.runtime?.contractDigest, "controllerReceipt.runtime.contractDigest");
  if (contractDigest !== normalizeDigest(admission.contractDigest, "admission.contractDigest")) {
    throw new Error("runtime contract evidence binding mismatch");
  }
  const gate = validateGateAggregate(publicationEvidence.gateAggregate, { admission, passport });
  if (passport.gateProfileEvidence?.digest && passport.gateProfileEvidence.digest !== `sha256:${gate.gateAggregateDigest}`) {
    throw new Error("release-candidate passport Gate evidence binding mismatch");
  }
  if (gate.gateAggregateDigest !== normalizeDigest(admission.gateAggregateDigest, "admission.gateAggregateDigest")) {
    throw new Error("Gate aggregate evidence binding mismatch");
  }
  if (gate.policyDigest !== normalizeDigest(admission.policyDigest, "admission.policyDigest")) {
    throw new Error("Gate policy evidence binding mismatch");
  }
  const manifestSet = createPublicationArtifactManifestSet({
    repository: admission.repository,
    sourceSha: passport.source?.headSha,
    sourceTreeSha,
    manifests: publicationEvidence.artifactManifests,
    payloads: publicationEvidence.artifactPayloads,
  });
  const passportPlatforms = (passport.platformMatrix || [])
    .map((entry) => `${entry.platformId}\0${entry.artifactName}`)
    .sort();
  const manifestPlatforms = manifestSet.artifacts
    .map((entry) => `${entry.platformId}\0${entry.artifactName}`)
    .sort();
  if (JSON.stringify(passportPlatforms) !== JSON.stringify(manifestPlatforms)) {
    throw new Error("artifact manifest set does not match the release-candidate platform matrix");
  }
  if (manifestSet.manifestSetDigest !== normalizeDigest(admission.artifactDigest, "admission.artifactDigest")) {
    throw new Error("artifact manifest evidence binding mismatch");
  }
  return {
    sourceTreeSha,
    controllerReceiptDigest,
    contractDigest,
    gateAggregateDigest: gate.gateAggregateDigest,
    policyDigest: gate.policyDigest,
    artifactDigest: manifestSet.manifestSetDigest,
    evidenceDigest: publicationAuthorityDigest({
      passportCandidateHash: passport.candidateHash,
      sourceTreeSha,
      controllerReceiptDigest,
      gateAggregateDigest: gate.gateAggregateDigest,
      artifactDigest: manifestSet.manifestSetDigest,
    }),
  };
}

function validateRunnerProvenance(receipt, expectedDigest) {
  if (receipt?.contract !== RUNNER_PROVENANCE_CONTRACT) throw new Error("runner provenance contract mismatch");
  if (!QUALIFIED_RUNNER_CLASSES.has(receipt.runnerClass)) {
    throw new Error(`runner provenance is not qualified: ${receipt.runnerClass || "unknown"}`);
  }
  if (receipt.qualificationStatus !== "qualifying") {
    throw new Error(`runner provenance qualification floor was not met: ${receipt.runnerClass}`);
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

function validateControlPlaneAudit(receipt, { repository, workflowPath, environment, now, expectedDigest }) {
  if (receipt?.contract !== PUBLICATION_CONTROL_PLANE_AUDIT_CONTRACT) {
    throw new Error("publication control-plane audit contract mismatch");
  }
  if (receipt.workflowPath !== workflowPath) throw new Error("control-plane workflow binding mismatch");
  if (receipt.repository !== repository) throw new Error("control-plane repository binding mismatch");
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
  publicationEvidence,
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
  const environmentMode = descriptor.environmentMode || "fixed";
  if (!["fixed", "caller-bound"].includes(environmentMode)) {
    throw new Error(`unsupported publication environment mode: ${environmentMode}`);
  }
  const environment = environmentMode === "caller-bound"
    ? requiredString(admission.environment, "admission.environment")
    : descriptor.environment;
  if (!environment) throw new Error("publication authority descriptor has no protected environment");
  if (environmentMode === "fixed" && admission.environment !== environment) {
    throw new Error("publication admission environment binding mismatch");
  }

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
    "gateAggregateDigest",
    "environment",
    "product",
    "target",
    "version",
    "channel",
    "artifactDigest",
  ];
  for (const key of bindings) {
    const actual = requiredString(admission[key], `admission.${key}`);
    if (expected[key] === undefined) {
      throw new Error(`publication admission expected ${key} binding is required`);
    }
    if (String(expected[key]) !== actual) {
      throw new Error(`publication admission ${key} binding mismatch`);
    }
  }
  for (const key of ["sourceSha", "runtimeSha"]) {
    normalizeGitSha(admission[key], `admission.${key}`);
  }
  for (const key of ["contractDigest", "policyDigest", "controllerReceiptDigest", "gateAggregateDigest", "artifactDigest"]) {
    normalizeDigest(admission[key], `admission.${key}`);
  }

  const runnerDigest = validateRunnerProvenance(runnerProvenance, admission.runnerProvenanceDigest);
  const controlPlaneDigest = validateControlPlaneAudit(controlPlaneAudit, {
    repository: admission.repository,
    workflowPath,
    environment,
    now: nowMs,
    expectedDigest: admission.controlPlaneAuditDigest,
  });
  const evidence = validatePublicationEvidence(publicationEvidence, admission);
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
    sourceSha: normalizeGitSha(admission.sourceSha, "admission.sourceSha"),
    runtimeSha: normalizeGitSha(admission.runtimeSha, "admission.runtimeSha"),
    contractDigest: normalizeDigest(admission.contractDigest, "admission.contractDigest"),
    policyDigest: normalizeDigest(admission.policyDigest, "admission.policyDigest"),
    controllerReceiptDigest: normalizeDigest(admission.controllerReceiptDigest, "admission.controllerReceiptDigest"),
    product: admission.product,
    target: admission.target,
    version: admission.version,
    channel: admission.channel,
    artifactDigest: normalizeDigest(admission.artifactDigest, "admission.artifactDigest"),
    sourceTreeSha: evidence.sourceTreeSha,
    publicationEvidenceDigest: evidence.evidenceDigest,
    admissionDigest: actualAdmissionDigest,
    runnerProvenanceDigest: runnerDigest,
    controlPlaneAuditDigest: controlPlaneDigest,
    gateAggregateDigest: normalizeDigest(admission.gateAggregateDigest, "admission.gateAggregateDigest"),
    environment,
    nonce,
    expiresAt: admission.expiresAt,
  };
  return { ...capability, capabilityDigest: publicationAuthorityDigest(capability) };
}

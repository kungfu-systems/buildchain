import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import kfdPackageJson from "@kungfu-tech/kfd/package.json" with { type: "json" };
import kfdStandards from "@kungfu-tech/kfd/standards.json" with { type: "json" };

export const KFD_PRODUCT_GATE_INPUT_CONTRACT =
  "kungfu-buildchain-kfd-product-gate-input";
export const KFD_PRODUCT_GATE_CONTRACT =
  "kungfu-buildchain-kfd-product-gate";
export const KFD_SUPPORT_PROJECTION_CONTRACT =
  "kungfu-buildchain-kfd-support-projection";
export const KFD_PRODUCT_GATE_INPUT_SCHEMA_ID =
  "https://buildchain.libkungfu.dev/schemas/kfd-product-gate-input-v1.schema.json";
export const KFD_SUPPORT_PROJECTION_SCHEMA_ID =
  "https://buildchain.libkungfu.dev/schemas/kfd-support-projection-v1.schema.json";

const SUPPORTED_GATE_STANDARDS = Object.freeze(["kfd-4", "kfd-5", "kfd-7"]);
const SUPPORTED_GATE_STANDARD_SET = new Set(SUPPORTED_GATE_STANDARDS);
const SHA256_PATTERN = "^sha256:[0-9a-f]{64}$";
const GIT_SHA_PATTERN = "^[0-9a-f]{40}(?:[0-9a-f]{24})?$";
const REQUIRED_KFD7_EVIDENCE_CATEGORIES = Object.freeze([
  "semantic-component-deletion-or-fusion",
  "invalid-transition",
  "export-import-rebuild",
  "backend-migration",
  "concurrency-retry-compensation",
  "warrant-decay-revocation",
  "atlas-staleness-loss",
  "pursuit-continuity-settlement",
  "episode-replay-contraction",
  "cold-start-continuation",
  "session-round-trip-refinement",
  "session-complexity-breakpoint",
  "context-insufficiency-counterexample",
]);
const REQUIRED_RECORDS = Object.freeze({
  "kfd-4": Object.freeze({
    "observer-perspective": "kfd-4-observer-perspective",
    "perspective-replay": "kfd-4-perspective-replay",
  }),
  "kfd-5": Object.freeze({
    "primitive-discovery": "kfd-5-primitive-discovery",
  }),
  "kfd-7": Object.freeze({
    "domain-profile": "kfd-7-domain-profile",
  }),
});

const STRING = { type: "string", minLength: 1 };
const SHA256 = { type: "string", pattern: SHA256_PATTERN };

export const KFD_PRODUCT_GATE_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: KFD_PRODUCT_GATE_INPUT_SCHEMA_ID,
  title: "Buildchain KFD product gate input v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "contract",
    "standard",
    "standardRevision",
    "source",
    "evidenceCut",
    "records",
    "evidence",
    "responsibility",
    "nonClaims",
  ],
  properties: {
    schemaVersion: { const: 1 },
    contract: { const: KFD_PRODUCT_GATE_INPUT_CONTRACT },
    standard: { enum: SUPPORTED_GATE_STANDARDS },
    standardRevision: { type: "integer", minimum: 1 },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["repository", "sha"],
      properties: {
        repository: STRING,
        sha: { type: "string", pattern: GIT_SHA_PATTERN },
      },
    },
    evidenceCut: {
      type: "object",
      additionalProperties: false,
      required: ["generatedAt", "expiresAt"],
      properties: {
        generatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
    records: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "path", "sha256"],
        properties: { role: STRING, path: STRING, sha256: SHA256 },
      },
    },
    evidence: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "path", "sha256"],
        properties: { id: STRING, kind: STRING, path: STRING, sha256: SHA256 },
      },
    },
    responsibility: {
      type: "object",
      additionalProperties: false,
      required: ["owner", "evidenceOwner", "proofOwner"],
      properties: { owner: STRING, evidenceOwner: STRING, proofOwner: STRING },
    },
    nonClaims: {
      type: "array",
      minItems: 1,
      items: STRING,
    },
  },
};

export const KFD_SUPPORT_PROJECTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: KFD_SUPPORT_PROJECTION_SCHEMA_ID,
  title: "Buildchain KFD support projection v1",
  description:
    "A release-bound, non-authoritative projection of one product-owned KFD support matrix.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "contract",
    "matrix",
    "standardPackage",
    "gateResults",
    "rows",
    "status",
    "projectionRoot",
    "nonClaims",
  ],
  properties: {
    schemaVersion: { const: 1 },
    contract: { const: KFD_SUPPORT_PROJECTION_CONTRACT },
    matrix: {
      type: "object",
      additionalProperties: false,
      required: ["contract", "root", "authorityPath"],
      properties: { contract: STRING, root: SHA256, authorityPath: STRING },
    },
    standardPackage: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "standardsSha256"],
      properties: { name: STRING, version: STRING, standardsSha256: SHA256 },
    },
    gateResults: { type: "array", minItems: 3, items: { type: "object" } },
    rows: { type: "array", minItems: 13, maxItems: 13, items: { type: "object" } },
    status: { enum: ["passed", "failed"] },
    projectionRoot: SHA256,
    nonClaims: { type: "array", minItems: 1, items: STRING },
  },
};

const require = createRequire(import.meta.url);
let verifierPromise;

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

export function kfdProductGateDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function fileDigest(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}

function issue(code, pathName, message, detail = {}) {
  return { level: "error", code, path: pathName, message, ...detail };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function standardMetadata(standard) {
  return kfdStandards?.standards?.[standard] || {};
}

function standardsFileDigest() {
  return fileDigest(require.resolve("@kungfu-tech/kfd/standards.json"));
}

function normalizeSha256(value) {
  const normalized = optionalString(value).toLowerCase();
  if (!normalized) return "";
  return normalized.startsWith("sha256:") ? normalized : `sha256:${normalized}`;
}

function parseDate(value) {
  const timestamp = Date.parse(optionalString(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function checkEvidenceCut(input, { checkedAt, expectedSourceSha }, issues) {
  const sourceSha = optionalString(input?.source?.sha).toLowerCase();
  if (!new RegExp(GIT_SHA_PATTERN).test(sourceSha)) {
    issues.push(issue("source-sha", "source.sha", "source.sha must be a 40- or 64-character Git SHA"));
  }
  if (expectedSourceSha && sourceSha !== optionalString(expectedSourceSha).toLowerCase()) {
    issues.push(issue("source-sha-mismatch", "source.sha", "gate source must match the expected release source", {
      expected: expectedSourceSha,
      actual: sourceSha,
    }));
  }
  const checked = parseDate(checkedAt);
  const generated = parseDate(input?.evidenceCut?.generatedAt);
  const expires = parseDate(input?.evidenceCut?.expiresAt);
  if (!Number.isFinite(generated)) {
    issues.push(issue("generated-at", "evidenceCut.generatedAt", "evidenceCut.generatedAt must be an ISO date-time"));
  }
  if (!Number.isFinite(expires)) {
    issues.push(issue("expires-at", "evidenceCut.expiresAt", "evidenceCut.expiresAt must be an ISO date-time"));
  }
  if (Number.isFinite(generated) && Number.isFinite(checked) && generated > checked) {
    issues.push(issue("future-evidence", "evidenceCut.generatedAt", "evidence was generated after the gate check"));
  }
  if (Number.isFinite(expires) && Number.isFinite(checked) && expires <= checked) {
    issues.push(issue("stale-evidence", "evidenceCut.expiresAt", "evidence cut has expired"));
  }
  if (Number.isFinite(generated) && Number.isFinite(expires) && expires <= generated) {
    issues.push(issue("invalid-evidence-window", "evidenceCut", "expiresAt must be later than generatedAt"));
  }
}

function resolveBoundFile(cwd, reference, label, issues) {
  const relativePath = optionalString(reference?.path).replace(/\\/g, "/");
  if (!relativePath || path.isAbsolute(relativePath)) {
    issues.push(issue("evidence-path", `${label}.path`, `${label}.path must be a repository-relative path`));
    return undefined;
  }
  const root = fs.realpathSync(cwd);
  const candidate = path.resolve(root, relativePath);
  if (!fs.existsSync(candidate)) {
    issues.push(issue("evidence-missing", `${label}.path`, `${relativePath} does not exist`));
    return undefined;
  }
  const real = fs.realpathSync(candidate);
  const withinRoot = real === root || real.startsWith(`${root}${path.sep}`);
  if (!withinRoot || fs.lstatSync(candidate).isSymbolicLink() || !fs.statSync(real).isFile()) {
    issues.push(issue("evidence-boundary", `${label}.path`, `${relativePath} must resolve to a regular file inside the product repository`));
    return undefined;
  }
  const actual = fileDigest(real);
  const expected = normalizeSha256(reference?.sha256);
  if (!new RegExp(SHA256_PATTERN).test(expected)) {
    issues.push(issue("evidence-digest", `${label}.sha256`, `${label}.sha256 must be a sha256 digest`));
  } else if (actual !== expected) {
    issues.push(issue("evidence-drift", `${label}.sha256`, `${relativePath} digest does not match the declared evidence cut`, {
      expected,
      actual,
    }));
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(real, "utf8"));
  } catch (error) {
    issues.push(issue("evidence-json", `${label}.path`, `${relativePath} must contain valid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  return { path: relativePath, realPath: real, sha256: actual, value };
}

async function instantiateVerifier() {
  const wasmPath = require.resolve("@kungfu-tech/kfd/verifier/wasm");
  const module = await WebAssembly.instantiate(fs.readFileSync(wasmPath), {});
  return module.instance;
}

async function kfdVerifierInstance() {
  verifierPromise ||= instantiateVerifier();
  return verifierPromise;
}

export async function verifyKfdRecord(record) {
  const instance = await kfdVerifierInstance();
  const { memory, kfd_alloc: alloc, kfd_free: free, kfd_verify: verify } = instance.exports;
  const bundle = {
    schemaVersion: 1,
    contract: "kfd.verification-bundle/v1",
    kind: "kfd-record",
    primary: JSON.stringify(record),
    artifacts: {},
  };
  const input = new TextEncoder().encode(JSON.stringify(bundle));
  const inputPointer = alloc(input.length);
  new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
  let packed;
  try {
    packed = verify(inputPointer, input.length);
  } finally {
    free(inputPointer, input.length);
  }
  const outputPointer = Number(packed >> 32n);
  const outputLength = Number(packed & 0xffffffffn);
  const output = new Uint8Array(memory.buffer, outputPointer, outputLength).slice();
  free(outputPointer, outputLength);
  return JSON.parse(new TextDecoder().decode(output));
}

function validateGateInputEnvelope(input, issues) {
  if (!isObject(input)) {
    issues.push(issue("input-type", "", "gate input must be a JSON object"));
    return;
  }
  if (input.schemaVersion !== 1) {
    issues.push(issue("schema-version", "schemaVersion", "schemaVersion must be 1"));
  }
  if (input.contract !== KFD_PRODUCT_GATE_INPUT_CONTRACT) {
    issues.push(issue("contract", "contract", `contract must be ${KFD_PRODUCT_GATE_INPUT_CONTRACT}`));
  }
  if (!SUPPORTED_GATE_STANDARD_SET.has(input.standard)) {
    issues.push(issue("standard", "standard", "standard must be kfd-4, kfd-5, or kfd-7"));
    return;
  }
  const metadata = standardMetadata(input.standard);
  if (input.standardRevision !== metadata.revision) {
    issues.push(issue("standard-revision", "standardRevision", "gate input revision must match the installed KFD standard", {
      expected: metadata.revision,
      actual: input.standardRevision,
    }));
  }
  if (!optionalString(input?.source?.repository)) {
    issues.push(issue("source-repository", "source.repository", "source.repository is required"));
  }
  if (!isObject(input.responsibility)) {
    issues.push(issue("responsibility", "responsibility", "responsibility is required"));
  } else {
    for (const field of ["owner", "evidenceOwner", "proofOwner"]) {
      if (!optionalString(input.responsibility[field])) {
        issues.push(issue("responsibility-field", `responsibility.${field}`, `responsibility.${field} is required`));
      }
    }
  }
  if (!Array.isArray(input.nonClaims) || input.nonClaims.length === 0) {
    issues.push(issue("non-claims", "nonClaims", "nonClaims must be non-empty"));
  }
}

function validateKfd4(records, evidence, issues) {
  const perspective = records.get("observer-perspective")?.value;
  const replay = records.get("perspective-replay")?.value;
  if (perspective?.verification?.result !== "pass") {
    issues.push(issue("kfd4-perspective-verification", "records.observer-perspective.verification.result", "observer perspective verification must pass"));
  }
  if (replay?.mode !== "contrastive") {
    issues.push(issue("kfd4-contrastive-replay", "records.perspective-replay.mode", "KFD-4 product qualification requires contrastive replay"));
  }
  const sourceViews = Array.isArray(replay?.sourceViews) ? replay.sourceViews : [];
  const viewIds = sourceViews.map((entry) => optionalString(entry?.id)).filter(Boolean);
  if (sourceViews.length < 2 || new Set(viewIds).size !== sourceViews.length) {
    issues.push(issue("kfd4-view-identity", "records.perspective-replay.sourceViews", "contrastive replay requires at least two uniquely identified source views"));
  }
  if (!Array.isArray(replay?.reconstruction?.declaredLoss)) {
    issues.push(issue("kfd4-declared-loss", "records.perspective-replay.reconstruction.declaredLoss", "reconstruction must explicitly declare transformation loss"));
  }
  const preserved = new Set(replay?.reconstruction?.preservedElements || []);
  for (const element of ["observer", "accepted-fact-cut", "evidence-boundary"]) {
    if (!preserved.has(element)) {
      issues.push(issue("kfd4-preservation", "records.perspective-replay.reconstruction.preservedElements", `reconstruction must preserve ${element}`));
    }
  }
  if (replay?.verification?.result !== "pass" || !Array.isArray(replay?.verification?.evidence) || replay.verification.evidence.length === 0) {
    issues.push(issue("kfd4-replay-verification", "records.perspective-replay.verification", "perspective replay verification must pass with retained evidence"));
  }
  for (const kind of ["projection-fsck", "negative-fixture"]) {
    if (!evidence.some((entry) => entry.kind === kind)) {
      issues.push(issue("kfd4-gate-evidence", "evidence", `KFD-4 gate requires ${kind} evidence`));
    }
  }
}

function validateKfd5(records, evidence, issues) {
  const discovery = records.get("primitive-discovery")?.value;
  if (discovery?.decision?.outcome !== "accepted") {
    issues.push(issue("kfd5-decision", "records.primitive-discovery.decision.outcome", "Primitive qualification requires an accepted decision"));
  }
  for (const testName of ["minimumClosure", "deletion", "fuse", "dogfood"]) {
    const result = discovery?.tests?.[testName];
    if (result?.result !== "pass" || !Array.isArray(result?.evidence) || result.evidence.length === 0) {
      issues.push(issue("kfd5-test", `records.primitive-discovery.tests.${testName}`, `${testName} must pass with retained evidence`));
    }
  }
  if (!Array.isArray(discovery?.tests?.falsifiers) || discovery.tests.falsifiers.length === 0) {
    issues.push(issue("kfd5-falsifiers", "records.primitive-discovery.tests.falsifiers", "Primitive qualification requires explicit falsifiers"));
  }
  if (!evidence.some((entry) => entry.kind === "negative-fixture")) {
    issues.push(issue("kfd5-negative-fixture", "evidence", "KFD-5 gate requires a negative fixture"));
  }
}

function validateKfd7(records, evidence, issues) {
  const profile = records.get("domain-profile")?.value;
  if (profile?.domainProfile?.qualificationStatus !== "qualified") {
    issues.push(issue("kfd7-qualification", "records.domain-profile.domainProfile.qualificationStatus", "KFD-7 Domain Profile must be qualified"));
  }
  if (profile?.activation?.decision !== "activate") {
    issues.push(issue("kfd7-activation", "records.domain-profile.activation.decision", "KFD-7 gate requires an explicit activate decision"));
  }
  const independentReview = optionalString(profile?.activation?.independentReview);
  if (!independentReview || /^(?:pending|none|not[- ]yet|not[- ]performed)/i.test(independentReview)) {
    issues.push(issue("kfd7-independent-review", "records.domain-profile.activation.independentReview", "activation requires a retained independent review"));
  }
  if (!Array.isArray(profile?.activation?.productWitnesses) || profile.activation.productWitnesses.length === 0) {
    issues.push(issue("kfd7-product-witness", "records.domain-profile.activation.productWitnesses", "activation requires product witnesses"));
  }
  const obligations = Array.isArray(profile?.evidenceObligations) ? profile.evidenceObligations : [];
  const byCategory = new Map(obligations.map((entry) => [entry?.category, entry]));
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  for (const category of REQUIRED_KFD7_EVIDENCE_CATEGORIES) {
    const obligation = byCategory.get(category);
    if (!obligation || obligation.status !== "passed" || !Array.isArray(obligation.artifactRefs) || obligation.artifactRefs.length === 0) {
      issues.push(issue("kfd7-evidence-obligation", "records.domain-profile.evidenceObligations", `${category} must pass with retained artifact refs`));
      continue;
    }
    for (const artifactRef of obligation.artifactRefs) {
      if (!evidenceIds.has(artifactRef)) {
        issues.push(issue("kfd7-evidence-binding", "evidence", `artifact ref ${artifactRef} is not bound by the gate evidence cut`));
      }
    }
  }
  if (new Set(obligations.map((entry) => entry?.category)).size !== obligations.length) {
    issues.push(issue("kfd7-evidence-duplicate", "records.domain-profile.evidenceObligations", "evidence obligation categories must be unique"));
  }
  for (const kind of ["independent-review", "negative-fixture"]) {
    if (!evidence.some((entry) => entry.kind === kind)) {
      issues.push(issue("kfd7-gate-evidence", "evidence", `KFD-7 gate requires ${kind} evidence`));
    }
  }
}

export async function evaluateKfdProductGate({
  cwd = process.cwd(),
  input,
  expectedSourceSha = "",
  checkedAt = new Date().toISOString(),
} = {}) {
  const issues = [];
  validateGateInputEnvelope(input, issues);
  checkEvidenceCut(input, { checkedAt, expectedSourceSha }, issues);
  const standard = optionalString(input?.standard).toLowerCase();
  const requiredRecords = REQUIRED_RECORDS[standard] || {};
  const recordEntries = Array.isArray(input?.records) ? input.records : [];
  const evidenceEntries = Array.isArray(input?.evidence) ? input.evidence : [];
  const records = new Map();
  const recordResults = [];
  const roleCounts = new Map();
  for (const reference of recordEntries) {
    const role = optionalString(reference?.role);
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    const resolved = resolveBoundFile(cwd, reference, `records.${role || "unknown"}`, issues);
    if (!resolved) continue;
    const verifier = await verifyKfdRecord(resolved.value);
    const expectedContract = requiredRecords[role];
    if (!expectedContract) {
      issues.push(issue("record-role", `records.${role}`, `${role || "empty role"} is not admitted for ${standard}`));
    } else if (resolved.value?.contract !== expectedContract || resolved.value?.standard !== standard) {
      issues.push(issue("record-contract", `records.${role}`, `${role} must contain ${expectedContract} for ${standard}`));
    }
    if (!verifier.valid) {
      issues.push(issue("kfd-verifier", `records.${role}`, `${role} failed the KFD offline verifier`, {
        verifierIssues: verifier.issues || [],
      }));
    }
    records.set(role, resolved);
    recordResults.push({
      role,
      path: resolved.path,
      sha256: resolved.sha256,
      contract: resolved.value?.contract || "",
      verifier: {
        valid: verifier.valid === true,
        reportRoot: kfdProductGateDigest(verifier),
        qualifying: verifier.qualifying === true,
        selfCertified: verifier.selfCertified === true,
      },
    });
  }
  for (const role of Object.keys(requiredRecords)) {
    if ((roleCounts.get(role) || 0) !== 1) {
      issues.push(issue("record-cardinality", `records.${role}`, `${standard} requires exactly one ${role} record`));
    }
  }
  const evidence = [];
  const evidenceIds = new Set();
  for (const [index, reference] of evidenceEntries.entries()) {
    const id = optionalString(reference?.id);
    if (!id || evidenceIds.has(id)) {
      issues.push(issue("evidence-id", `evidence[${index}].id`, "evidence ids must be non-empty and unique"));
    }
    evidenceIds.add(id);
    const resolved = resolveBoundFile(cwd, reference, `evidence[${index}]`, issues);
    if (resolved) {
      evidence.push({
        id,
        kind: optionalString(reference.kind),
        path: resolved.path,
        sha256: resolved.sha256,
      });
    }
  }
  if (standard === "kfd-4") validateKfd4(records, evidence, issues);
  if (standard === "kfd-5") validateKfd5(records, evidence, issues);
  if (standard === "kfd-7") validateKfd7(records, evidence, issues);
  const result = {
    schemaVersion: 1,
    contract: KFD_PRODUCT_GATE_CONTRACT,
    standard,
    standardRevision: standardMetadata(standard).revision || 0,
    standardPackage: {
      name: kfdPackageJson.name,
      version: kfdPackageJson.version,
      standardsSha256: standardsFileDigest(),
    },
    source: isObject(input?.source) ? { ...input.source, sha: optionalString(input.source.sha).toLowerCase() } : {},
    evidenceCut: isObject(input?.evidenceCut) ? { ...input.evidenceCut } : {},
    checkedAt,
    status: issues.length === 0 ? "passed" : "failed",
    qualifying: false,
    selfCertified: false,
    records: recordResults.sort((left, right) => left.role.localeCompare(right.role)),
    evidence: evidence.sort((left, right) => left.id.localeCompare(right.id)),
    responsibility: isObject(input?.responsibility) ? { ...input.responsibility } : {},
    nonClaims: Array.isArray(input?.nonClaims) ? [...input.nonClaims] : [],
    issues,
    inputRoot: kfdProductGateDigest(input),
  };
  result.gateRoot = kfdProductGateDigest(result);
  return result;
}

export function validateKfdProductGateResult(result, {
  expectedSourceSha = "",
  checkedAt = new Date().toISOString(),
} = {}) {
  const issues = [];
  if (!isObject(result) || result.schemaVersion !== 1 || result.contract !== KFD_PRODUCT_GATE_CONTRACT) {
    issues.push(issue("gate-contract", "", `gate result must use ${KFD_PRODUCT_GATE_CONTRACT} v1`));
    return { valid: false, issues };
  }
  if (!SUPPORTED_GATE_STANDARD_SET.has(result.standard)) {
    issues.push(issue("gate-standard", "standard", "gate result standard must be kfd-4, kfd-5, or kfd-7"));
  }
  const expectedRevision = standardMetadata(result.standard).revision;
  if (result.standardRevision !== expectedRevision) {
    issues.push(issue("gate-standard-revision", "standardRevision", "gate result uses a stale KFD revision", {
      expected: expectedRevision,
      actual: result.standardRevision,
    }));
  }
  if (
    result?.standardPackage?.name !== kfdPackageJson.name ||
    result?.standardPackage?.version !== kfdPackageJson.version ||
    result?.standardPackage?.standardsSha256 !== standardsFileDigest()
  ) {
    issues.push(issue("gate-standard-package", "standardPackage", "gate result must bind the installed KFD package and standards bytes"));
  }
  const copy = structuredClone(result);
  const root = copy.gateRoot;
  delete copy.gateRoot;
  if (root !== kfdProductGateDigest(copy)) {
    issues.push(issue("gate-root", "gateRoot", "gate result root does not match its content"));
  }
  checkEvidenceCut(result, { checkedAt, expectedSourceSha }, issues);
  if (!["passed", "failed"].includes(result.status)) {
    issues.push(issue("gate-status", "status", "gate status must be passed or failed"));
  }
  if (result.qualifying !== false || result.selfCertified !== false) {
    issues.push(issue("gate-non-qualification", "", "Buildchain product gates must not self-qualify or self-certify a KFD adoption"));
  }
  return { valid: issues.length === 0, issues };
}

function expectedKfdIds() {
  return Array.from({ length: 13 }, (_, index) => `KFD-${index + 1}`);
}

function normalizeMatrixRoot(matrix, matrixRoot) {
  const normalized = normalizeSha256(matrixRoot);
  return normalized || kfdProductGateDigest(matrix);
}

function projectMatrixRow(row) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    supportStatus: row.supportStatus,
    normative: row.normative,
    implementation: row.implementation,
    verification: row.verification,
    buildchain: row.buildchain,
    releaseQualification: row.releaseQualification,
    claimClass: row.claimClass,
    knownLimitations: row.knownLimitations,
    owner: row.owner,
    nextGate: row.nextGate,
  };
}

function validateMatrixRows(matrix, gatesByStandard, issues) {
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const expectedIds = expectedKfdIds();
  const ids = rows.map((row) => row?.id);
  if (rows.length !== expectedIds.length || new Set(ids).size !== expectedIds.length) {
    issues.push(issue("matrix-row-set", "rows", "support matrix must contain exactly one row for KFD-1 through KFD-13"));
  }
  for (const id of expectedIds) {
    const row = rows.find((entry) => entry?.id === id);
    if (!row) {
      issues.push(issue("matrix-row-missing", "rows", `${id} is missing`));
      continue;
    }
    const key = id.toLowerCase();
    const metadata = standardMetadata(key);
    if (row.key !== key || row?.normative?.status !== metadata.status || row?.normative?.revision !== metadata.revision) {
      issues.push(issue("matrix-normative-drift", `rows.${id}.normative`, `${id} must match installed KFD status and revision`, {
        expected: { key, status: metadata.status, revision: metadata.revision },
        actual: { key: row.key, status: row?.normative?.status, revision: row?.normative?.revision },
      }));
    }
    const shipped = row?.releaseQualification?.shippedSupport === true;
    if (
      shipped &&
      (
        row?.implementation?.status !== "implemented" ||
        row?.verification?.status !== "passed" ||
        row?.buildchain?.gateStatus !== "passed" ||
        !String(row.supportStatus || "").includes("supported")
      )
    ) {
      issues.push(issue("matrix-shipped-widening", `rows.${id}`, `${id} cannot be shipped without implemented, verified, and passed Buildchain evidence`));
    }
  }
  for (const id of ["KFD-4", "KFD-5"]) {
    const row = rows.find((entry) => entry?.id === id);
    if (row?.supportStatus !== "candidate" || row?.releaseQualification?.shippedSupport !== false) {
      issues.push(issue("matrix-candidate-widening", `rows.${id}`, `${id} must remain a non-shipped candidate`));
    }
  }
  const kfd6 = rows.find((entry) => entry?.id === "KFD-6");
  if (
    kfd6?.supportStatus !== "unsupported" ||
    kfd6?.releaseQualification?.shippedSupport !== false ||
    kfd6?.buildchain?.gateStatus === "passed"
  ) {
    issues.push(issue("matrix-kfd6-barrier", "rows.KFD-6", "KFD-6 must remain explicitly unsupported and non-shipped"));
  }
  for (let number = 8; number <= 13; number += 1) {
    const id = `KFD-${number}`;
    const row = rows.find((entry) => entry?.id === id);
    if (
      row?.supportStatus !== "draft-adopter-evidence" ||
      row?.releaseQualification?.shippedSupport !== false ||
      row?.buildchain?.gateStatus === "passed"
    ) {
      issues.push(issue("matrix-draft-barrier", `rows.${id}`, `${id} must remain draft adopter evidence and non-shipped`));
    }
  }
  for (const standard of SUPPORTED_GATE_STANDARDS) {
    const id = standard.toUpperCase();
    const row = rows.find((entry) => entry?.id === id);
    const gate = gatesByStandard.get(standard);
    if (!gate) {
      issues.push(issue("matrix-gate-missing", `rows.${id}.buildchain`, `${id} requires a Buildchain product-gate result`));
      continue;
    }
    const rowPassed = row?.buildchain?.gateStatus === "passed";
    const gatePassed = gate.status === "passed";
    if (rowPassed !== gatePassed) {
      issues.push(issue("matrix-gate-disagreement", `rows.${id}.buildchain.gateStatus`, `${id} matrix and Buildchain gate disagree`, {
        matrix: row?.buildchain?.gateStatus,
        gate: gate.status,
      }));
    }
    if (row?.buildchain?.protocol !== `${KFD_PRODUCT_GATE_CONTRACT}/v1`) {
      issues.push(issue("matrix-gate-protocol", `rows.${id}.buildchain.protocol`, `${id} must name the versioned Buildchain product-gate protocol`));
    }
  }
  return rows;
}

export function createKfdSupportProjection({
  matrix,
  matrixRoot = "",
  gateResults = [],
  authorityPath = ".buildchain/kfd/support-matrix.json",
  expectedSourceSha = "",
  checkedAt = new Date().toISOString(),
} = {}) {
  const issues = [];
  if (!isObject(matrix) || matrix.contract !== "kungfu-kfd-support-matrix" || matrix.schemaVersion !== 1) {
    issues.push(issue("matrix-contract", "", "support matrix must use kungfu-kfd-support-matrix v1"));
  }
  if (
    matrix?.upstream?.package !== kfdPackageJson.name ||
    matrix?.upstream?.version !== kfdPackageJson.version ||
    matrix?.upstream?.standardsSha256 !== standardsFileDigest()
  ) {
    issues.push(issue("matrix-standard-package", "upstream", "support matrix must bind the installed KFD package and standards bytes", {
      expected: {
        package: kfdPackageJson.name,
        version: kfdPackageJson.version,
        standardsSha256: standardsFileDigest(),
      },
      actual: matrix?.upstream,
    }));
  }
  const gatesByStandard = new Map();
  for (const [index, gate] of gateResults.entries()) {
    const validation = validateKfdProductGateResult(gate, { expectedSourceSha, checkedAt });
    if (!validation.valid) {
      issues.push(issue("gate-result-invalid", `gateResults[${index}]`, "gate result is invalid", {
        gateIssues: validation.issues,
      }));
    }
    if (gatesByStandard.has(gate?.standard)) {
      issues.push(issue("gate-result-duplicate", `gateResults[${index}].standard`, `${gate.standard} gate result is duplicated`));
    }
    gatesByStandard.set(gate?.standard, gate);
  }
  const rows = validateMatrixRows(matrix, gatesByStandard, issues);
  const projection = {
    schemaVersion: 1,
    contract: KFD_SUPPORT_PROJECTION_CONTRACT,
    matrix: {
      contract: matrix?.contract || "",
      root: normalizeMatrixRoot(matrix, matrixRoot),
      authorityPath: optionalString(matrix?.authority?.path || authorityPath),
    },
    standardPackage: {
      name: kfdPackageJson.name,
      version: kfdPackageJson.version,
      standardsSha256: standardsFileDigest(),
    },
    gateResults: SUPPORTED_GATE_STANDARDS.map((standard) => {
      const gate = gatesByStandard.get(standard);
      return gate
        ? {
            standard,
            standardRevision: gate.standardRevision,
            sourceSha: gate?.source?.sha || "",
            evidenceCut: gate.evidenceCut,
            status: gate.status,
            gateRoot: gate.gateRoot,
            issueCount: Array.isArray(gate.issues) ? gate.issues.length : 0,
          }
        : { standard, status: "missing", gateRoot: "", issueCount: 1 };
    }),
    rows: rows.map(projectMatrixRow),
    status: issues.length === 0 ? "passed" : "failed",
    nonClaims: [
      "This projection does not replace the product-owned support matrix.",
      "A passed Buildchain gate does not by itself activate, ship, or certify a KFD adoption.",
      "Candidate, unsupported, draft, and non-qualifying matrix states cannot be widened by this projection.",
    ],
    issues,
  };
  projection.projectionRoot = kfdProductGateDigest(projection);
  return projection;
}

export function validateKfdSupportProjection(projection, {
  expectedSourceSha = "",
  checkedAt = new Date().toISOString(),
} = {}) {
  const issues = [];
  if (!isObject(projection) || projection.schemaVersion !== 1 || projection.contract !== KFD_SUPPORT_PROJECTION_CONTRACT) {
    issues.push(issue("projection-contract", "", `projection must use ${KFD_SUPPORT_PROJECTION_CONTRACT} v1`));
    return { valid: false, issues };
  }
  const copy = structuredClone(projection);
  const root = copy.projectionRoot;
  delete copy.projectionRoot;
  if (root !== kfdProductGateDigest(copy)) {
    issues.push(issue("projection-root", "projectionRoot", "support projection root does not match its content"));
  }
  if (projection.status !== "passed" || (projection.issues || []).length !== 0) {
    issues.push(issue("projection-status", "status", "release passport requires a passed support projection"));
  }
  if (
    projection?.standardPackage?.name !== kfdPackageJson.name ||
    projection?.standardPackage?.version !== kfdPackageJson.version ||
    projection?.standardPackage?.standardsSha256 !== standardsFileDigest()
  ) {
    issues.push(issue("projection-standard-package", "standardPackage", "support projection uses stale KFD package metadata"));
  }
  if (!new RegExp(SHA256_PATTERN).test(optionalString(projection?.matrix?.root))) {
    issues.push(issue("projection-matrix-root", "matrix.root", "support projection must bind the exact support matrix bytes"));
  }
  if (!optionalString(projection?.matrix?.authorityPath)) {
    issues.push(issue("projection-matrix-authority", "matrix.authorityPath", "support projection must retain the product-owned matrix authority path"));
  }
  const gatesByStandard = new Map();
  for (const [index, gate] of (projection.gateResults || []).entries()) {
    if (!SUPPORTED_GATE_STANDARD_SET.has(gate?.standard)) {
      issues.push(issue("projection-gate-standard", `gateResults[${index}].standard`, "projected gate must be kfd-4, kfd-5, or kfd-7"));
      continue;
    }
    if (gatesByStandard.has(gate.standard)) {
      issues.push(issue("projection-gate-duplicate", `gateResults[${index}].standard`, `${gate.standard} is duplicated`));
    }
    gatesByStandard.set(gate.standard, gate);
    if (gate.standardRevision !== standardMetadata(gate.standard).revision) {
      issues.push(issue("projection-gate-revision", `gateResults[${index}].standardRevision`, "projected gate revision is stale"));
    }
    if (!new RegExp(SHA256_PATTERN).test(optionalString(gate.gateRoot))) {
      issues.push(issue("projection-gate-root", `gateResults[${index}].gateRoot`, "projected gate must retain its gate root"));
    }
    if (expectedSourceSha && gate.sourceSha !== expectedSourceSha) {
      issues.push(issue("projection-source", `gateResults[${index}].sourceSha`, "gate source must match the release source"));
    }
    const checked = parseDate(checkedAt);
    const expires = parseDate(gate?.evidenceCut?.expiresAt);
    if (!Number.isFinite(expires) || (Number.isFinite(checked) && expires <= checked)) {
      issues.push(issue("projection-stale-gate", `gateResults[${index}].evidenceCut.expiresAt`, "projected gate evidence is stale"));
    }
  }
  validateMatrixRows({ rows: projection.rows }, gatesByStandard, issues);
  if (!Array.isArray(projection.nonClaims) || projection.nonClaims.length === 0) {
    issues.push(issue("projection-non-claims", "nonClaims", "support projection must preserve non-claims"));
  }
  return { valid: issues.length === 0, issues };
}

export const kfdProductGates = Object.freeze({
  evaluate: evaluateKfdProductGate,
  projectSupport: createKfdSupportProjection,
  validateGateResult: validateKfdProductGateResult,
  validateSupportProjection: validateKfdSupportProjection,
  verifyRecord: verifyKfdRecord,
});

import crypto from "node:crypto";

export const ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT =
  "kungfu-buildchain-artifact-verification-envelope";
export const ARTIFACT_VERIFICATION_ENVELOPE_CHECK_CONTRACT =
  "kungfu-buildchain-artifact-verification-envelope-check";
export const KFX_ADMISSION_INPUTS_CONTRACT =
  "kungfu-buildchain-kfx-admission-inputs";

const ARTIFACT_VERIFICATION_CONTRACT =
  "kungfu-buildchain-artifact-verification";
const KFX_TRUST_INPUTS_SCHEMA = "kungfu.kfx-trust-inputs/v1";
const KFD_ASSESSMENT_SCHEMA = "kungfu.trust.assessment/v1";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROOT_FIELDS = Object.freeze([
  "packageRoot",
  "sourceRoot",
  "dependencyRoot",
  "buildPlanRoot",
  "toolchainRoot",
  "artifactRoot",
  "qualificationRoot",
  "verifierRoot",
]);
const BINDING_FIELDS = Object.freeze([
  "schema",
  ...ROOT_FIELDS,
  "issuer",
  "publisher",
  "contractVersion",
]);

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

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function artifactVerificationEnvelopeDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function issue(code, message, details = {}) {
  return { level: "error", code, message, details };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRoot(value) {
  return SHA256_PATTERN.test(String(value || ""));
}

function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeBindings(value = {}) {
  if (!isObject(value)) {
    throw new Error("bindings must be an object");
  }
  const supplied = Object.keys(value).sort();
  const expected = [...BINDING_FIELDS].sort();
  if (stableJson(supplied) !== stableJson(expected)) {
    throw new Error(`bindings must contain exactly: ${BINDING_FIELDS.join(", ")}`);
  }
  if (value.schema !== KFX_TRUST_INPUTS_SCHEMA) {
    throw new Error(`bindings.schema must be ${KFX_TRUST_INPUTS_SCHEMA}`);
  }
  const normalized = { schema: KFX_TRUST_INPUTS_SCHEMA };
  for (const field of ROOT_FIELDS) {
    const root = String(value[field] || "");
    if (!isRoot(root)) {
      throw new Error(`bindings.${field} must be a canonical lowercase sha256 root`);
    }
    normalized[field] = root;
  }
  normalized.issuer = nonEmptyString(value.issuer, "bindings.issuer");
  normalized.publisher = nonEmptyString(value.publisher, "bindings.publisher");
  normalized.contractVersion = nonEmptyString(value.contractVersion, "bindings.contractVersion");
  return normalized;
}

function normalizeRevocation(value = {}, { issuedAt } = {}) {
  if (!isObject(value)) {
    throw new Error("revocation must be an object");
  }
  const revoked = value.revoked === true;
  const status = nonEmptyString(value.status || (revoked ? "revoked" : "active"), "revocation.status");
  if (!new Set(["active", "revoked"]).has(status) || revoked !== (status === "revoked")) {
    throw new Error("revocation.status must agree with revocation.revoked");
  }
  const checkedAt = nonNegativeInteger(value.checkedAt ?? issuedAt, "revocation.checkedAt");
  const root = String(value.root || "");
  if (!isRoot(root)) {
    throw new Error("revocation.root must be a canonical lowercase sha256 root");
  }
  return {
    status,
    revoked,
    checkedAt,
    source: nonEmptyString(value.source, "revocation.source"),
    root,
  };
}

function envelopeRoot(value) {
  const basis = jsonClone(value);
  if (isObject(basis.envelope)) {
    delete basis.envelope.root;
  }
  return artifactVerificationEnvelopeDigest(basis);
}

function recomputeKfdReportRoot(report) {
  const basis = jsonClone(report);
  delete basis.report_hash;
  return artifactVerificationEnvelopeDigest(basis);
}

export function verifyArtifactVerificationEnvelope({
  envelope,
  assessmentTime = Math.floor(Date.now() / 1000),
  expectedEnvelopeRoot = "",
  expectedIssuer = "",
  expectedPublisher = "",
  expectedContractVersion = "",
} = {}) {
  const issues = [];
  const at = Number.isSafeInteger(assessmentTime) && assessmentTime >= 0
    ? assessmentTime
    : -1;
  if (!isObject(envelope)) {
    issues.push(issue("envelope.object", "artifact verification envelope must be an object"));
    return {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_ENVELOPE_CHECK_CONTRACT,
      ok: false,
      outcome: "fail",
      assessmentTime,
      issues,
    };
  }

  const metadata = isObject(envelope.envelope) ? envelope.envelope : {};
  if (
    metadata.contract !== ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT ||
    metadata.schemaVersion !== 1 ||
    metadata.canonicalization !== "buildchain-stable-json/v1"
  ) {
    issues.push(issue("envelope.contract", "artifact verification envelope contract metadata is invalid"));
  }
  const computedEnvelopeRoot = envelopeRoot(envelope);
  if (!isRoot(metadata.root) || metadata.root !== computedEnvelopeRoot) {
    issues.push(issue("envelope.root", "artifact verification envelope root does not match canonical content", {
      expected: computedEnvelopeRoot,
      actual: metadata.root || "",
    }));
  }
  if (expectedEnvelopeRoot && metadata.root !== expectedEnvelopeRoot) {
    issues.push(issue("envelope.root.expected", "artifact verification envelope root does not match the pinned root"));
  }

  const verificationOk =
    envelope.contract === ARTIFACT_VERIFICATION_CONTRACT &&
    envelope.schemaVersion === 1 &&
    envelope.outcome === "pass" &&
    envelope.ok === true &&
    envelope.trust === "pass" &&
    envelope.passport?.verification?.ok === true &&
    envelope.passport?.verification?.trust === "pass";
  if (!verificationOk) {
    issues.push(issue("verification.invalid", "base artifact verification must be a passing v1 report"));
  }

  let bindings;
  try {
    bindings = normalizeBindings(envelope.bindings);
  } catch (error) {
    issues.push(issue("bindings.invalid", error.message));
  }
  if (bindings) {
    const subjectRoot = String(envelope.subject?.digest || "");
    const matchedRoot = String(envelope.match?.artifact?.digest || "");
    if (
      !isRoot(subjectRoot) ||
      subjectRoot !== matchedRoot ||
      bindings.artifactRoot !== subjectRoot
    ) {
      issues.push(issue("bindings.artifactRoot", "artifact root must match the exact verified subject and passport artifact"));
    }
    if (expectedIssuer && bindings.issuer !== expectedIssuer) {
      issues.push(issue("bindings.issuer", "issuer does not match the expected authority"));
    }
    if (expectedPublisher && bindings.publisher !== expectedPublisher) {
      issues.push(issue("bindings.publisher", "publisher does not match the expected identity"));
    }
    if (expectedContractVersion && bindings.contractVersion !== expectedContractVersion) {
      issues.push(issue("bindings.contractVersion", "verification contract version does not match the expected version"));
    }
  }

  const issuedAt = envelope.issuedAt;
  const expiresAt = envelope.expiresAt;
  if (
    at < 0 ||
    !Number.isSafeInteger(issuedAt) ||
    issuedAt < 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    at < issuedAt ||
    at >= expiresAt
  ) {
    issues.push(issue("lifecycle.invalid", "envelope must be active at assessmentTime with valid issuedAt/expiresAt bounds"));
  }
  const revocation = envelope.revocation;
  if (
    !isObject(revocation) ||
    !isRoot(revocation.root) ||
    !Number.isSafeInteger(revocation.checkedAt) ||
    revocation.checkedAt < issuedAt ||
    (at >= 0 && revocation.checkedAt > at) ||
    !["active", "revoked"].includes(revocation.status) ||
    revocation.revoked !== (revocation.status === "revoked") ||
    envelope.revoked !== revocation.revoked
  ) {
    issues.push(issue("lifecycle.revocation", "revocation binding is invalid or inconsistent"));
  }
  if (envelope.revoked === true) {
    issues.push(issue("lifecycle.revoked", "artifact verification envelope has been revoked"));
  }

  const assessment = envelope.kfdAssessment;
  const report = isObject(assessment?.report) ? assessment.report : {};
  if (
    !isObject(assessment) ||
    assessment.schema !== KFD_ASSESSMENT_SCHEMA ||
    assessment.state !== "fresh" ||
    report.state !== "fresh"
  ) {
    issues.push(issue("kfd.assessment.state", "KFD assessment must be a fresh ADR-0052 assessment"));
  }
  if (
    !isRoot(assessment?.assessment_key) ||
    report.assessment_key !== assessment?.assessment_key
  ) {
    issues.push(issue("kfd.assessment.key", "KFD assessment key must be canonical and match the report"));
  }
  const computedReportRoot = isObject(report) ? recomputeKfdReportRoot(report) : "";
  if (!isRoot(report.report_hash) || report.report_hash !== computedReportRoot) {
    issues.push(issue("kfd.report.root", "KFD report hash does not match canonical report content", {
      expected: computedReportRoot,
      actual: report.report_hash || "",
    }));
  }
  if (
    !String(report.purpose || "").trim() ||
    !isRoot(report.query_proof_root) ||
    !isRoot(report.contract_world?.root) ||
    !isRoot(report.policy?.root) ||
    !Array.isArray(report.fact_surfaces) ||
    report.fact_surfaces.length === 0 ||
    report.fact_surfaces.some((surface) => !isRoot(surface?.root))
  ) {
    issues.push(issue("kfd.report.bindings", "KFD report must bind purpose, query proof, contract world, policy, and fact-surface roots"));
  }
  if (bindings && bindings.qualificationRoot !== report.report_hash) {
    issues.push(issue("bindings.qualificationRoot", "qualification root must equal the KFD report hash"));
  }

  const ok = issues.length === 0;
  return {
    schemaVersion: 1,
    contract: ARTIFACT_VERIFICATION_ENVELOPE_CHECK_CONTRACT,
    ok,
    outcome: ok ? "pass" : "fail",
    assessmentTime,
    envelopeRoot: metadata.root || "",
    bindings: bindings || undefined,
    kfdAssessment: isObject(assessment)
      ? {
          state: assessment.state || "",
          assessmentKey: assessment.assessment_key || "",
          reportRoot: report.report_hash || "",
        }
      : undefined,
    issues,
  };
}

export function sealArtifactVerificationReport({
  report,
  bindings,
  kfdAssessment,
  issuedAt,
  expiresAt,
  revocation,
} = {}) {
  if (!isObject(report)) {
    throw new Error("report must be an artifact verification object");
  }
  const normalizedIssuedAt = nonNegativeInteger(issuedAt, "issuedAt");
  const normalizedExpiresAt = nonNegativeInteger(expiresAt, "expiresAt");
  if (normalizedExpiresAt <= normalizedIssuedAt) {
    throw new Error("expiresAt must be greater than issuedAt");
  }
  const normalizedRevocation = normalizeRevocation(revocation, {
    issuedAt: normalizedIssuedAt,
  });
  const result = {
    ...jsonClone(report),
    issuedAt: normalizedIssuedAt,
    expiresAt: normalizedExpiresAt,
    revoked: normalizedRevocation.revoked,
    revocation: normalizedRevocation,
    bindings: normalizeBindings(bindings),
    kfdAssessment: jsonClone(kfdAssessment),
    envelope: {
      schemaVersion: 1,
      contract: ARTIFACT_VERIFICATION_ENVELOPE_CONTRACT,
      canonicalization: "buildchain-stable-json/v1",
      root: "",
    },
  };
  result.envelope.root = envelopeRoot(result);
  const check = verifyArtifactVerificationEnvelope({
    envelope: result,
    assessmentTime: normalizedRevocation.checkedAt,
  });
  if (!check.ok) {
    throw new Error(`artifact verification envelope is invalid: ${check.issues.map((entry) => entry.code).join(", ")}`);
  }
  return result;
}

export function projectArtifactVerificationEnvelopeToKfx({
  envelope,
  assessmentTime = Math.floor(Date.now() / 1000),
  expectedEnvelopeRoot = "",
  expectedIssuer = "",
  expectedPublisher = "",
  expectedContractVersion = "",
} = {}) {
  const check = verifyArtifactVerificationEnvelope({
    envelope,
    assessmentTime,
    expectedEnvelopeRoot,
    expectedIssuer,
    expectedPublisher,
    expectedContractVersion,
  });
  if (!check.ok) {
    throw new Error(`artifact verification envelope failed closed: ${check.issues.map((entry) => entry.code).join(", ")}`);
  }
  return {
    schemaVersion: 1,
    contract: KFX_ADMISSION_INPUTS_CONTRACT,
    envelopeRoot: envelope.envelope.root,
    attestation: jsonClone(envelope),
    trustInputs: jsonClone(envelope.bindings),
    kfdAssessment: jsonClone(envelope.kfdAssessment),
  };
}

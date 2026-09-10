import crypto from "node:crypto";

export const PUBLICATION_QUALIFICATION_SCHEMA =
  "kungfu.buildchain.v4-publication-qualification/v1";

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const FORBIDDEN_EXECUTION_KEYS = new Set([
  "cmd",
  "command",
  "eval",
  "executable",
  "javascript",
  "run",
  "script",
  "shell",
]);

export class PublicationQualificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationQualificationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicationQualificationError(code, message);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function domainPublicationQualificationRoot(value) {
  return `sha256:${crypto.createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function assertNoExecutionFields(value, location = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoExecutionFields(entry, `${location}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_EXECUTION_KEYS.has(key.toLowerCase())) {
      fail(
        "execution-field-forbidden",
        `v4 declarative publication forbids ${location}.${key}`,
      );
    }
    assertNoExecutionFields(entry, `${location}.${key}`);
  }
}

function exactRoot(value, label) {
  const root = String(value || "").toLowerCase();
  if (!ROOT.test(root))
    fail("schema-invalid", `${label} must be a sha256 root`);
  return root;
}

function exactSha(value, label) {
  const sha = String(value || "").toLowerCase();
  if (!SHA.test(sha))
    fail("schema-invalid", `${label} must be an exact Git SHA`);
  return sha;
}

function normalizedArtifacts(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    fail(
      "schema-invalid",
      "publication qualification requires typed artifacts",
    );
  }
  const normalized = artifacts
    .map((artifact) => {
      const value = {
        role: String(artifact?.role || ""),
        platform: String(artifact?.platform || ""),
        artifactRoot: exactRoot(artifact?.artifactRoot, "artifactRoot"),
        manifestRoot: exactRoot(artifact?.manifestRoot, "manifestRoot"),
      };
      if (!value.role || !value.platform)
        fail("schema-invalid", "artifact role and platform are required");
      return value;
    })
    .sort((left, right) =>
      `${left.role}\0${left.platform}`.localeCompare(
        `${right.role}\0${right.platform}`,
      ),
    );
  if (
    new Set(normalized.map(({ role, platform }) => `${role}\0${platform}`))
      .size !== normalized.length
  ) {
    fail("schema-invalid", "artifact role/platform bindings must be unique");
  }
  return normalized;
}

export function createDomainPublicationQualificationReceipt({
  repository,
  candidateRoot,
  sourceSha,
  sourceRoot,
  policyDigest,
  artifacts,
  issuedAt,
  expiresAt,
}) {
  const body = {
    schema: PUBLICATION_QUALIFICATION_SCHEMA,
    repository: String(repository || ""),
    candidateRoot: exactRoot(candidateRoot, "candidateRoot"),
    sourceSha: exactSha(sourceSha, "sourceSha"),
    sourceRoot: exactRoot(sourceRoot, "sourceRoot"),
    policyDigest: exactRoot(policyDigest, "policyDigest"),
    artifacts: normalizedArtifacts(artifacts),
    issuedAt: String(issuedAt || ""),
    expiresAt: String(expiresAt || ""),
  };
  if (!/^[^/\s]+\/[^/\s]+$/u.test(body.repository))
    fail("schema-invalid", "repository must be owner/repo");
  const issued = Date.parse(body.issuedAt);
  const expires = Date.parse(body.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued
  )
    fail("schema-invalid", "qualification freshness interval is invalid");
  assertNoExecutionFields(body);
  const artifactRoot = domainPublicationQualificationRoot(body.artifacts);
  const receipt = { ...body, artifactRoot };
  return {
    ...receipt,
    receiptRoot: domainPublicationQualificationRoot(receipt),
  };
}

export function validatePublicationQualificationReceipt(
  receipt,
  {
    repository,
    candidateRoot,
    sourceSha,
    sourceRoot,
    artifactRoot,
    policyDigest,
    evaluatedAt = new Date().toISOString(),
  } = {},
) {
  if (!receipt)
    fail("qualification-missing", "qualification receipt is required");
  assertNoExecutionFields(receipt);
  const recreated = createDomainPublicationQualificationReceipt(receipt);
  if (
    receipt.artifactRoot !== recreated.artifactRoot ||
    receipt.receiptRoot !== recreated.receiptRoot
  ) {
    fail(
      "qualification-tampered",
      "qualification receipt root does not verify",
    );
  }
  if (repository && receipt.repository !== repository)
    fail("repository-mismatch", "qualification repository does not match");
  if (candidateRoot && receipt.candidateRoot !== candidateRoot)
    fail("candidate-mismatch", "qualification candidate root does not match");
  if (sourceSha && receipt.sourceSha !== sourceSha)
    fail("source-mismatch", "qualification source SHA does not match");
  if (sourceRoot && receipt.sourceRoot !== sourceRoot)
    fail("source-mismatch", "qualification source root does not match");
  if (artifactRoot && receipt.artifactRoot !== artifactRoot)
    fail("artifact-mismatch", "qualification artifact root does not match");
  if (policyDigest && receipt.policyDigest !== policyDigest)
    fail("policy-mismatch", "qualification policy digest does not match");
  const evaluated = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluated))
    fail("schema-invalid", "evaluatedAt is invalid");
  if (
    evaluated < Date.parse(receipt.issuedAt) ||
    evaluated >= Date.parse(receipt.expiresAt)
  )
    fail(
      "qualification-stale",
      "qualification receipt is outside its freshness window",
    );
  return Object.freeze({
    ok: true,
    receiptRoot: receipt.receiptRoot,
    artifactRoot: receipt.artifactRoot,
  });
}

export function assertDeclarativePromotionInputs(inputs) {
  const forbidden = Object.entries(inputs || {}).filter(
    ([name, value]) =>
      name !== "dry-run" &&
      /(command|cmd|script|shell|run)$/iu.test(name) &&
      String(value || "").trim() !== "",
  );
  if (forbidden.length > 0) {
    fail(
      "legacy-command-input-forbidden",
      `v4 declarative publication rejects: ${forbidden
        .map(([name]) => name)
        .sort()
        .join(", ")}`,
    );
  }
}

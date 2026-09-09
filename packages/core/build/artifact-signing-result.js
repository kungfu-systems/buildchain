import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ARTIFACT_SIGNING_AUTHORITY_CONTRACT,
  artifactSigningDigest,
  validateArtifactSigningReceipt,
  validateArtifactSigningRequest,
} from "./artifact-signing.js";

export const ARTIFACT_SIGNING_RESULT_CONTRACT =
  "kungfu-buildchain-artifact-signing-result/v1";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function digest(value, label) {
  const normalized = required(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return normalized;
}

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

function documentDigest(value) {
  const { digest: _digest, ...basis } = value;
  return artifactSigningDigest(basis);
}

function normalizeEvidence(evidence = []) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new Error("artifact signing result requires verification evidence");
  }
  return evidence.map((entry, index) => ({
    kind: required(entry?.kind, `evidence[${index}].kind`),
    path: required(entry?.path, `evidence[${index}].path`),
    digest: digest(entry?.digest, `evidence[${index}].digest`),
  }));
}

export function artifactSigningEvidenceDigest(evidence = []) {
  const normalized = normalizeEvidence(evidence);
  return artifactSigningDigest(
    normalized.map(({ kind, digest: entryDigest }) => ({
      kind,
      digest: entryDigest,
    })),
  );
}

export function createArtifactSigningResult({
  request,
  receipt,
  receiptPath = "receipt.json",
  payload = {},
  evidence = [],
  verification = {},
} = {}) {
  const requestCheck = validateArtifactSigningRequest(request);
  if (!requestCheck.ok) {
    throw new Error(
      `invalid artifact signing request: ${requestCheck.issues.join(", ")}`,
    );
  }
  const receiptCheck = validateArtifactSigningReceipt(receipt, { request });
  if (!receiptCheck.ok || receipt?.status !== "passed") {
    throw new Error(
      `invalid passed artifact signing receipt: ${receiptCheck.issues.join(", ")}`,
    );
  }
  const normalizedEvidence = normalizeEvidence(evidence);
  const evidenceDigest = artifactSigningEvidenceDigest(normalizedEvidence);
  const payloadDigest = digest(payload.digest, "payload digest");
  const payloadBytes = Number(payload.bytes);
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new Error("payload bytes must be a non-negative safe integer");
  }
  if (receipt.result?.artifactDigest !== payloadDigest) {
    throw new Error("receipt artifact digest does not bind the result payload");
  }
  if (receipt.result?.evidenceDigest !== evidenceDigest) {
    throw new Error("receipt evidence digest does not bind the result evidence");
  }
  const provider = required(verification.provider, "verification provider");
  if (provider !== request.signature.provider) {
    throw new Error("verification provider does not match the requested provider");
  }
  if (verification.status !== "passed") {
    throw new Error("artifact signing result verification must pass");
  }
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) {
    throw new Error("artifact signing result requires provider verification checks");
  }
  const result = {
    schemaVersion: 1,
    contract: ARTIFACT_SIGNING_RESULT_CONTRACT,
    requestDigest: request.digest,
    authority: {
      contract: ARTIFACT_SIGNING_AUTHORITY_CONTRACT,
      id: receipt.authority.id,
      runtimeSha: receipt.authority.runtimeSha,
    },
    source: { ...request.source },
    signature: { ...request.signature },
    artifact: {
      id: request.artifact.id,
      inputDigest: request.artifact.digest,
      path: required(payload.path, "payload path"),
      bytes: payloadBytes,
      digest: payloadDigest,
    },
    evidence: normalizedEvidence,
    evidenceDigest,
    verification: {
      status: "passed",
      provider,
      checks: verification.checks.map((check, index) =>
        required(check, `verification.checks[${index}]`),
      ),
    },
    receipt: {
      path: required(receiptPath, "receipt path"),
      digest: digest(receipt.digest, "receipt digest"),
    },
  };
  result.digest = documentDigest(result);
  return result;
}

export function validateArtifactSigningResult(result, { request, receipt } = {}) {
  const issues = [];
  try {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("artifact signing result must be an object");
    }
    if (result.contract !== ARTIFACT_SIGNING_RESULT_CONTRACT) {
      issues.push("artifact signing result contract mismatch");
    }
    const rebuilt = createArtifactSigningResult({
      request,
      receipt,
      receiptPath: result.receipt?.path,
      payload: result.artifact,
      evidence: result.evidence,
      verification: result.verification,
    });
    if (result.digest !== rebuilt.digest) {
      issues.push("artifact signing result digest mismatch");
    }
    if (stableJson(result) !== stableJson(rebuilt)) {
      issues.push("artifact signing result contains unsupported or stale fields");
    }
  } catch (error) {
    issues.push(String(error?.message || error));
  }
  return { ok: issues.length === 0, issues };
}

function resolveFile(root, relative, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, required(relative, label));
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must resolve below the result root`);
  }
  return resolved;
}

function sha256File(filePath) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex")}`;
}

export function verifyArtifactSigningResultFiles({
  root,
  request,
  receipt,
  result,
} = {}) {
  const issues = [];
  const resultCheck = validateArtifactSigningResult(result, { request, receipt });
  issues.push(...resultCheck.issues);
  try {
    const payloadPath = resolveFile(root, result.artifact.path, "payload path");
    const stat = fs.statSync(payloadPath);
    if (!stat.isFile()) issues.push("result payload is not a regular file");
    if (stat.size !== result.artifact.bytes) issues.push("result payload byte count mismatch");
    if (sha256File(payloadPath) !== result.artifact.digest) {
      issues.push("result payload digest mismatch");
    }
    const receiptPath = resolveFile(root, result.receipt.path, "receipt path");
    const receiptFromFile = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (
      receiptFromFile.digest !== result.receipt.digest ||
      stableJson(receiptFromFile) !== stableJson(receipt)
    ) {
      issues.push("result receipt file does not match the bound receipt");
    }
    for (const entry of result.evidence || []) {
      const evidencePath = resolveFile(root, entry.path, "evidence path");
      if (sha256File(evidencePath) !== entry.digest) {
        issues.push(`result evidence digest mismatch: ${entry.kind}`);
      }
    }
  } catch (error) {
    issues.push(String(error?.message || error));
  }
  return { ok: issues.length === 0, issues };
}

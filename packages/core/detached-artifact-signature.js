import crypto from "node:crypto";

import {
  artifactSigningDigest,
  createArtifactSigningReceipt,
  validateArtifactSigningRequest,
} from "./artifact-signing.js";

export const DETACHED_ARTIFACT_SIGNATURE_CONTRACT =
  "kungfu-buildchain-detached-artifact-signature/v1";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function signatureBasis(request, keyId) {
  return {
    schemaVersion: 1,
    contract: DETACHED_ARTIFACT_SIGNATURE_CONTRACT,
    algorithm: "ed25519",
    keyId: required(keyId, "key id"),
    requestDigest: request.digest,
    artifactDigest: request.artifact.digest,
    runtimeSha: request.runtime.sha,
  };
}

function envelopeDigest(envelope) {
  const { digest: _digest, ...basis } = envelope;
  return artifactSigningDigest(basis);
}

export function signDetachedArtifactRequest({
  request,
  privateKey,
  keyId,
  authority = {},
} = {}) {
  const check = validateArtifactSigningRequest(request);
  if (!check.ok) {
    throw new Error(
      `invalid artifact signing request: ${check.issues.join(", ")}`,
    );
  }
  if (request.signature.profile !== "detached-signature-v1") {
    throw new Error("detached signer requires detached-signature-v1 profile");
  }
  const basis = signatureBasis(request, keyId);
  const payload = Buffer.from(JSON.stringify(basis), "utf8");
  const signature = crypto.sign(null, payload, privateKey);
  const envelope = {
    ...basis,
    signature: signature.toString("base64"),
  };
  envelope.digest = envelopeDigest(envelope);
  const receipt = createArtifactSigningReceipt({
    request,
    authority,
    result: {
      artifactDigest: request.artifact.digest,
      evidenceDigest: artifactSigningDigest(basis),
    },
    signatures: [
      {
        kind: "ed25519-detached",
        digest: `sha256:${crypto.createHash("sha256").update(signature).digest("hex")}`,
      },
    ],
  });
  return { envelope, receipt };
}

export function verifyDetachedArtifactSignature({
  request,
  envelope,
  publicKey,
} = {}) {
  const issues = [];
  try {
    const check = validateArtifactSigningRequest(request);
    if (!check.ok) issues.push(...check.issues);
    if (envelope?.contract !== DETACHED_ARTIFACT_SIGNATURE_CONTRACT) {
      issues.push("detached signature contract mismatch");
    }
    const basis = signatureBasis(request, envelope?.keyId);
    for (const [key, expected] of Object.entries(basis)) {
      if (envelope?.[key] !== expected) {
        issues.push(`detached signature ${key} mismatch`);
      }
    }
    const signature = Buffer.from(
      required(envelope?.signature, "signature"),
      "base64",
    );
    if (
      !crypto.verify(
        null,
        Buffer.from(JSON.stringify(basis), "utf8"),
        publicKey,
        signature,
      )
    ) {
      issues.push("detached signature verification failed");
    }
    if (envelope?.digest !== envelopeDigest(envelope)) {
      issues.push("detached signature envelope digest mismatch");
    }
  } catch (error) {
    issues.push(String(error?.message || error));
  }
  return { ok: issues.length === 0, issues };
}

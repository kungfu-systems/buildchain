import crypto from "node:crypto";

export const ARTIFACT_SIGNING_REQUEST_CONTRACT =
  "kungfu-buildchain-artifact-signing-request/v1";
export const ARTIFACT_SIGNING_RECEIPT_CONTRACT =
  "kungfu-buildchain-artifact-signing-receipt/v1";
export const ARTIFACT_SIGNING_AUTHORITY_CONTRACT =
  "kungfu-buildchain-artifact-signing-authority/v1";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const ENTITLEMENTS_PROFILES = new Set(["none", "jit-executable-v1"]);
const FORBIDDEN_CREDENTIAL_KEYS =
  /(?:certificate|password|private.?key|secret|token|notary|issuer|team.?id|environment)/iu;

const PROFILE_REGISTRY = Object.freeze({
  "apple-developer-id": Object.freeze({
    id: "apple-developer-id",
    provider: "apple",
    semantics: "native-platform-signature",
    platforms: ["macos"],
    artifactKinds: [
      "mach-o",
      "app-bundle",
      "framework-bundle",
      "plugin-bundle",
      "xpc-bundle",
      "dylib",
      "archive",
      "pkg",
      "dmg",
    ],
  }),
  "windows-authenticode": Object.freeze({
    id: "windows-authenticode",
    provider: "microsoft-authenticode",
    semantics: "native-platform-signature",
    platforms: ["windows"],
    artifactKinds: ["pe", "binary"],
  }),
  "detached-signature-v1": Object.freeze({
    id: "detached-signature-v1",
    provider: "buildchain-detached",
    semantics: "detached-cryptographic-signature",
    platforms: ["any"],
    artifactKinds: ["binary", "archive", "blob", "directory"],
  }),
});

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

export function artifactSigningDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function documentDigest(value) {
  const { digest: _digest, ...basis } = value;
  return artifactSigningDigest(basis);
}

function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function exactDigest(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a sha256 digest`);
  }
  return normalized;
}

function exactSourceSha(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!SOURCE_SHA_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return normalized;
}

function entitlementsPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("signing entitlements paths must be an array");
  }
  const paths = value.map((entry, index) => {
    const normalized = nonEmptyString(
      entry,
      `signing entitlements paths[${index}]`,
    );
    const parts = normalized.split("/");
    if (
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      normalized.includes(",") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(
        `signing entitlements paths[${index}] must be a safe archive-relative path`,
      );
    }
    return normalized;
  });
  if (new Set(paths).size !== paths.length) {
    throw new Error("signing entitlements paths must not contain duplicates");
  }
  return paths;
}

function signingEntitlements(profileId, kind, signature) {
  const profile = String(signature.entitlementsProfile || "none").trim();
  const paths = entitlementsPaths(signature.entitlementsPaths);
  if (!ENTITLEMENTS_PROFILES.has(profile)) {
    throw new Error(
      `unsupported signing entitlements profile: ${profile || "<empty>"}`,
    );
  }
  if (
    profile !== "none" &&
    (profileId !== "apple-developer-id" || kind !== "archive")
  ) {
    throw new Error(
      `signing entitlements profile ${profile} requires an Apple archive`,
    );
  }
  if (
    (profile === "none" && paths.length !== 0) ||
    (profile !== "none" && paths.length === 0)
  ) {
    throw new Error(
      "signing entitlements paths must be non-empty exactly when an entitlements profile is enabled",
    );
  }
  return profile === "none"
    ? {}
    : { entitlementsProfile: profile, entitlementsPaths: paths };
}

function assertNoCredentialMaterial(value, path = "request") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CREDENTIAL_KEYS.test(key)) {
      throw new Error(
        `${path}.${key} is credential configuration; signing requests may only declare desired signature state`,
      );
    }
    assertNoCredentialMaterial(child, `${path}.${key}`);
  }
}

export function listArtifactSigningProfiles() {
  return Object.values(PROFILE_REGISTRY).map((profile) => ({
    ...profile,
    platforms: [...profile.platforms],
    artifactKinds: [...profile.artifactKinds],
  }));
}

export function resolveArtifactSigningProfile({
  profile = "auto",
  platform = "",
  artifactKind = "binary",
} = {}) {
  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  const normalizedKind = nonEmptyString(
    artifactKind,
    "artifact kind",
  ).toLowerCase();
  let profileId = String(profile || "auto")
    .trim()
    .toLowerCase();
  if (profileId === "auto") {
    const apple = PROFILE_REGISTRY["apple-developer-id"];
    if (
      normalizedPlatform === "macos" &&
      apple.artifactKinds.includes(normalizedKind)
    ) {
      profileId = apple.id;
    } else if (
      normalizedPlatform === "windows" &&
      PROFILE_REGISTRY["windows-authenticode"].artifactKinds.includes(
        normalizedKind,
      )
    ) {
      profileId = "windows-authenticode";
    } else {
      profileId = "detached-signature-v1";
    }
  }
  const resolved = PROFILE_REGISTRY[profileId];
  if (!resolved)
    throw new Error(`unsupported artifact signing profile: ${profileId}`);
  if (
    !resolved.platforms.includes("any") &&
    !resolved.platforms.includes(normalizedPlatform)
  ) {
    throw new Error(
      `artifact signing profile ${profileId} does not support platform ${normalizedPlatform || "<empty>"}`,
    );
  }
  if (!resolved.artifactKinds.includes(normalizedKind)) {
    throw new Error(
      `artifact signing profile ${profileId} does not support artifact kind ${normalizedKind}`,
    );
  }
  return {
    ...resolved,
    platforms: [...resolved.platforms],
    artifactKinds: [...resolved.artifactKinds],
  };
}

export function createArtifactSigningRequest({
  source = {},
  runtime = {},
  artifact = {},
  signature = {},
  delivery = {},
} = {}) {
  assertNoCredentialMaterial({
    source,
    runtime,
    artifact,
    signature,
    delivery,
  });
  const platform = nonEmptyString(
    artifact.platform || source.platform,
    "artifact platform",
  ).toLowerCase();
  const kind = nonEmptyString(
    artifact.kind || "binary",
    "artifact kind",
  ).toLowerCase();
  const profile = resolveArtifactSigningProfile({
    profile: signature.profile || "auto",
    platform,
    artifactKind: kind,
  });
  const entitlementIntent = signingEntitlements(profile.id, kind, signature);
  const request = {
    schemaVersion: 1,
    contract: ARTIFACT_SIGNING_REQUEST_CONTRACT,
    authority: {
      contract: ARTIFACT_SIGNING_AUTHORITY_CONTRACT,
      id: "kungfu-systems/buildchain",
    },
    source: {
      repository: nonEmptyString(source.repository, "source repository"),
      sha: exactSourceSha(source.sha, "source SHA"),
      treeSha: exactSourceSha(source.treeSha, "source tree SHA"),
    },
    runtime: {
      repository: nonEmptyString(
        runtime.repository || "kungfu-systems/buildchain",
        "runtime repository",
      ),
      sha: exactSourceSha(runtime.sha, "runtime SHA"),
    },
    artifact: {
      id: nonEmptyString(artifact.id || artifact.path, "artifact id"),
      path: nonEmptyString(artifact.path, "artifact path"),
      kind,
      platform,
      ...(artifact.arch
        ? { arch: nonEmptyString(artifact.arch, "artifact architecture") }
        : {}),
      bytes: Number(artifact.bytes),
      digest: exactDigest(artifact.digest, "artifact digest"),
      ...(artifact.mediaType
        ? {
            mediaType: nonEmptyString(
              artifact.mediaType,
              "artifact media type",
            ),
          }
        : {}),
      ...(artifact.transport
        ? {
            transport: {
              file: nonEmptyString(
                artifact.transport.file,
                "artifact transport file",
              ),
              format: nonEmptyString(
                artifact.transport.format,
                "artifact transport format",
              ),
              bytes: Number(artifact.transport.bytes),
              digest: exactDigest(
                artifact.transport.digest,
                "artifact transport digest",
              ),
            },
          }
        : {}),
    },
    signature: {
      required: signature.required !== false,
      profile: profile.id,
      provider: profile.provider,
      semantics: profile.semantics,
      ...entitlementIntent,
    },
    delivery: {
      mode: nonEmptyString(
        delivery.mode || "buildchain-authority",
        "delivery mode",
      ),
      ...(delivery.recipientKey
        ? {
            recipientKey: nonEmptyString(
              delivery.recipientKey,
              "delivery recipient key",
            ),
          }
        : {}),
    },
  };
  if (
    !Number.isSafeInteger(request.artifact.bytes) ||
    request.artifact.bytes < 0
  ) {
    throw new Error("artifact bytes must be a non-negative safe integer");
  }
  if (
    request.artifact.transport &&
    (!Number.isSafeInteger(request.artifact.transport.bytes) ||
      request.artifact.transport.bytes < 0)
  ) {
    throw new Error(
      "artifact transport bytes must be a non-negative safe integer",
    );
  }
  request.digest = documentDigest(request);
  return request;
}

export function validateArtifactSigningRequest(request) {
  const issues = [];
  try {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("artifact signing request must be an object");
    }
    if (request.contract !== ARTIFACT_SIGNING_REQUEST_CONTRACT) {
      issues.push("request contract mismatch");
    }
    assertNoCredentialMaterial(request);
    const rebuilt = createArtifactSigningRequest(request);
    if (request.digest !== rebuilt.digest)
      issues.push("request digest mismatch");
    if (stableJson(request) !== stableJson(rebuilt)) {
      issues.push("request contains non-canonical or unsupported fields");
    }
  } catch (error) {
    issues.push(String(error?.message || error));
  }
  return { ok: issues.length === 0, issues };
}

export function createArtifactSigningReceipt({
  request,
  status = "passed",
  authority = {},
  result = {},
  signatures = [],
  reason = "",
} = {}) {
  const requestCheck = validateArtifactSigningRequest(request);
  if (!requestCheck.ok) {
    throw new Error(
      `invalid artifact signing request: ${requestCheck.issues.join(", ")}`,
    );
  }
  if (!["passed", "failed", "rejected"].includes(status)) {
    throw new Error(
      "artifact signing receipt status must be passed, failed, or rejected",
    );
  }
  const receipt = {
    schemaVersion: 1,
    contract: ARTIFACT_SIGNING_RECEIPT_CONTRACT,
    requestDigest: request.digest,
    status,
    authority: {
      contract: ARTIFACT_SIGNING_AUTHORITY_CONTRACT,
      id: nonEmptyString(authority.id || request.authority.id, "authority id"),
      runtimeSha: exactSourceSha(
        authority.runtimeSha || request.runtime.sha,
        "authority runtime SHA",
      ),
    },
    signature: { ...request.signature },
    ...(status === "passed"
      ? {
          result: {
            artifactDigest: exactDigest(
              result.artifactDigest,
              "result artifact digest",
            ),
            evidenceDigest: exactDigest(
              result.evidenceDigest,
              "result evidence digest",
            ),
          },
          signatures: signatures.map((entry, index) => ({
            kind: nonEmptyString(entry.kind, `signatures[${index}].kind`),
            digest: exactDigest(entry.digest, `signatures[${index}].digest`),
          })),
        }
      : { reason: nonEmptyString(reason, "receipt reason") }),
  };
  if (status === "passed" && receipt.signatures.length === 0) {
    throw new Error(
      "passed artifact signing receipt requires signature evidence",
    );
  }
  receipt.digest = documentDigest(receipt);
  return receipt;
}

export function validateArtifactSigningReceipt(receipt, { request } = {}) {
  const issues = [];
  try {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error("artifact signing receipt must be an object");
    }
    if (receipt.contract !== ARTIFACT_SIGNING_RECEIPT_CONTRACT) {
      issues.push("receipt contract mismatch");
    }
    if (receipt.digest !== documentDigest(receipt))
      issues.push("receipt digest mismatch");
    if (request) {
      const requestCheck = validateArtifactSigningRequest(request);
      if (!requestCheck.ok) issues.push(...requestCheck.issues);
      if (receipt.requestDigest !== request.digest)
        issues.push("receipt request digest mismatch");
      if (stableJson(receipt.signature) !== stableJson(request.signature)) {
        issues.push("receipt signature policy mismatch");
      }
      if (receipt.authority?.runtimeSha !== request.runtime.sha) {
        issues.push("receipt authority runtime mismatch");
      }
    }
    if (receipt.status === "passed") {
      exactDigest(receipt.result?.artifactDigest, "result artifact digest");
      exactDigest(receipt.result?.evidenceDigest, "result evidence digest");
      if (
        !Array.isArray(receipt.signatures) ||
        receipt.signatures.length === 0
      ) {
        issues.push("passed receipt has no signature evidence");
      }
    } else if (!["failed", "rejected"].includes(receipt.status)) {
      issues.push("receipt status is invalid");
    }
  } catch (error) {
    issues.push(String(error?.message || error));
  }
  return { ok: issues.length === 0, issues };
}

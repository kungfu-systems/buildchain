export const SURFACE_TIMESTAMP_POLICY_CONTRACT = "kungfu-buildchain-surface-timestamp-policy";

const DEFAULT_SOURCE_DATE_EPOCH = "0";

function nonEmptyString(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function isoFromEpochSeconds(value) {
  const raw = nonEmptyString(value, DEFAULT_SOURCE_DATE_EPOCH);
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`sourceDateEpoch must be integer seconds since Unix epoch: ${value}`);
  }
  return new Date(Number(raw) * 1000).toISOString();
}

function normalizeIso(value, label) {
  const normalized = nonEmptyString(value);
  if (!normalized) {
    return "";
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return date.toISOString();
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => nonEmptyString(value)).filter(Boolean))];
}

export function createSurfaceTimestampPolicy({
  generatedAt = "",
  publishedAt = "",
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH || DEFAULT_SOURCE_DATE_EPOCH,
  sourceRevision = "",
  deterministicInputs = [],
  timestampPolicy = "",
  timestampFields = ["generatedAt", "publishedAt"],
  timestampFieldsParticipateInArtifactDigest = true,
  artifactDigestScope = "manifest-and-artifact",
  reproducible = true,
} = {}) {
  const normalizedGeneratedAt = normalizeIso(
    generatedAt || isoFromEpochSeconds(sourceDateEpoch),
    "generatedAt",
  );
  const normalizedPublishedAt = normalizeIso(publishedAt || generatedAt || "", "publishedAt");
  const normalizedPolicy = nonEmptyString(
    timestampPolicy,
    generatedAt || publishedAt ? "ci-injected" : "source-date-epoch",
  );
  return {
    generatedAt: normalizedGeneratedAt,
    ...(normalizedPublishedAt ? { publishedAt: normalizedPublishedAt } : {}),
    reproducible: Boolean(reproducible),
    timestampPolicy: normalizedPolicy,
    deterministicInputs: uniqueStrings([
      ...deterministicInputs,
      sourceRevision ? "sourceRevision" : "",
      sourceDateEpoch ? "sourceDateEpoch" : "",
      "package content",
      "declared Buildchain surface manifest contract",
    ]),
    sourceDateEpoch: nonEmptyString(sourceDateEpoch),
    ...(sourceRevision ? { sourceRevision: nonEmptyString(sourceRevision) } : {}),
    timestampPolicyDetails: {
      contract: SURFACE_TIMESTAMP_POLICY_CONTRACT,
      timestampFields: uniqueStrings(timestampFields),
      timestampFieldsParticipateInArtifactDigest: Boolean(timestampFieldsParticipateInArtifactDigest),
      artifactDigestScope: nonEmptyString(artifactDigestScope, "manifest-and-artifact"),
      note: "Human-readable timestamps are separate from reproducibility inputs; do not infer reproducibility from epoch timestamps.",
    },
  };
}

export function applySurfaceTimestampPolicy(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("surface manifest must be a JSON object");
  }
  return {
    ...manifest,
    ...createSurfaceTimestampPolicy(options),
  };
}

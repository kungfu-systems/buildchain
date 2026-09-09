import { nonEmptyString, optionalString } from "./identity.js";
export function normalizePublishArtifact(artifact = {}, index = 0) {
  const name = nonEmptyString(
    artifact.name,
    `publishEvidence.artifacts[${index}].name`,
  );
  const normalized = {
    group: optionalString(artifact.group),
    kind: optionalString(artifact.kind),
    name,
    ref: optionalString(artifact.ref || artifact.version),
    digest: optionalString(
      artifact.digest ||
        artifact.sha256 ||
        artifact.integrity ||
        artifact.shasum,
    ),
    evidence: optionalString(artifact.evidence),
  };
  for (const key of [
    "action",
    "platform",
    "contract_major",
    "parent_digest",
    "content",
    "release",
    "verification",
  ]) {
    if (Object.prototype.hasOwnProperty.call(artifact, key)) {
      normalized[key] = structuredClone(artifact[key]);
    }
  }
  return normalized;
}
export function normalizePublishEvidence(value = undefined) {
  if (!value) {
    return undefined;
  }
  return {
    schema: Number(value.schema || value.schemaVersion || 1),
    version: optionalString(value.version),
    channel: optionalString(value.channel),
    sourceSha: optionalString(value.source_sha || value.sourceSha),
    releaseSha: optionalString(value.release_sha || value.releaseSha),
    targetRef: optionalString(value.target_ref || value.targetRef),
    releaseMaterialSha: optionalString(
      value.release_material_sha || value.releaseMaterialSha,
    ),
    publishToolingSha: optionalString(
      value.publish_tooling_sha || value.publishToolingSha,
    ),
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.map((artifact, index) =>
          normalizePublishArtifact(artifact, index),
        )
      : [],
  };
}

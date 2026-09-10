import { validatePublishEvidence as validateTransactionPublishEvidence } from "../publish-transaction.js";
import { issue } from "./issues.js";
import {
  findEvidenceForArtifact,
  artifactDigestValue,
} from "./artifact-index.js";
import { stableJson } from "./json.js";
export function validatePublishEvidenceSection({
  passport,
  publishEvidence,
  normalizedPublishEvidence,
  issues,
}) {
  const publishEvidenceSupplied =
    Boolean(passport?.evidence?.publishEvidence) ||
    (publishEvidence &&
      typeof publishEvidence === "object" &&
      Object.keys(publishEvidence).length > 0);
  if (!publishEvidenceSupplied && !passport?.packageSet) {
    return;
  }
  const checkPublishField = (value, label) => {
    if (!value) {
      issues.push(
        issue(
          "error",
          `publishEvidence.${label}`,
          `publishEvidence.${label} is required`,
        ),
      );
    }
  };
  if (Number(normalizedPublishEvidence?.schema) !== 1) {
    issues.push(
      issue(
        "error",
        "publishEvidence.schema",
        "publishEvidence.schema must be 1",
      ),
    );
  }
  for (const field of [
    "version",
    "channel",
    "sourceSha",
    "releaseSha",
    "targetRef",
    "releaseMaterialSha",
    "publishToolingSha",
  ]) {
    checkPublishField(normalizedPublishEvidence?.[field], field);
  }
  if (
    !Array.isArray(normalizedPublishEvidence?.artifacts) ||
    normalizedPublishEvidence.artifacts.length === 0
  ) {
    issues.push(
      issue(
        "error",
        "publishEvidence.artifacts",
        "publishEvidence.artifacts must include published artifacts",
      ),
    );
  }
  if (
    (normalizedPublishEvidence?.artifacts || []).some(
      (artifact) => artifact.action,
    )
  ) {
    try {
      const validation = validateTransactionPublishEvidence({
        evidence: publishEvidence,
        version: normalizedPublishEvidence.version,
        channel: normalizedPublishEvidence.channel,
        sourceSha: normalizedPublishEvidence.sourceSha,
        releaseSha: normalizedPublishEvidence.releaseSha,
        targetRef: normalizedPublishEvidence.targetRef,
        releaseMaterialSha: normalizedPublishEvidence.releaseMaterialSha,
        publishToolingSha: normalizedPublishEvidence.publishToolingSha,
      });
      for (const error of validation.errors) {
        issues.push(
          issue("error", "publishEvidence.artifactProvenance", error),
        );
      }
    } catch (error) {
      issues.push(
        issue(
          "error",
          "publishEvidence.artifactProvenance",
          `publish artifact provenance is invalid: ${error.message}`,
        ),
      );
    }
  }
  for (const field of ["sourceSha", "releaseSha", "targetRef"]) {
    if (
      passport?.release?.[field] &&
      normalizedPublishEvidence?.[field] &&
      passport.release[field] !== normalizedPublishEvidence[field]
    ) {
      issues.push(
        issue(
          "error",
          `publishEvidence.${field}.mismatch`,
          `publishEvidence.${field} must match passport.release.${field}`,
        ),
      );
    }
  }
}
export function validateReleaseArtifacts({ artifacts, evidenceIndex, issues }) {
  if (artifacts.length === 0) {
    issues.push(
      issue(
        "error",
        "artifacts.empty",
        "release passport must list at least one artifact",
      ),
    );
  }
  for (const artifact of artifacts) {
    if (!artifact.name) {
      issues.push(issue("error", "artifact.name", "artifact name is required"));
      continue;
    }
    const evidence = findEvidenceForArtifact(artifact, evidenceIndex);
    if (!evidence) {
      issues.push(
        issue(
          "error",
          "artifact.evidence.missing",
          `artifact ${artifact.name} is missing evidence`,
        ),
      );
      continue;
    }
    const evidenceDigest = artifactDigestValue(evidence);
    if (!evidenceDigest) {
      issues.push(
        issue(
          "error",
          "artifact.digest",
          `artifact ${artifact.name} must have a digest`,
        ),
      );
    }
    if (
      artifact.sha256 &&
      evidence.sha256 &&
      artifact.sha256 !== evidence.sha256
    ) {
      issues.push(
        issue(
          "error",
          "artifact.sha256.mismatch",
          `artifact ${artifact.name} digest differs between passport and evidence`,
        ),
      );
    }
    if (
      artifact.digest &&
      evidenceDigest &&
      artifact.digest !== evidenceDigest &&
      artifact.digest !== `sha256:${evidenceDigest}`
    ) {
      issues.push(
        issue(
          "error",
          "artifact.digest.mismatch",
          `artifact ${artifact.name} digest differs between passport and evidence`,
        ),
      );
    }
    for (const field of [
      "action",
      "platform",
      "contract_major",
      "parent_digest",
      "content",
      "release",
      "verification",
    ]) {
      if (
        Object.prototype.hasOwnProperty.call(evidence, field) &&
        stableJson(artifact[field]) !== stableJson(evidence[field])
      ) {
        issues.push(
          issue(
            "error",
            `artifact.${field}.mismatch`,
            `artifact ${artifact.name} ${field} differs between passport and publish evidence`,
          ),
        );
      }
    }
  }
}
export function validatePackageSet({ passport, evidenceIndex, issues }) {
  if (!passport?.packageSet) {
    return;
  }
  const main = passport.packageSet.main || {};
  const checkPackageEntry = (entry, label, role) => {
    if (!entry.name || !entry.version) {
      issues.push(
        issue(
          "error",
          `${label}.identity`,
          `${label} must include name and version`,
        ),
      );
    }
    if (!entry.distTag) {
      issues.push(
        issue("error", `${label}.distTag`, `${label} must include distTag`),
      );
    }
    if (!entry.digest) {
      issues.push(
        issue("error", `${label}.digest`, `${label} must include digest`),
      );
    }
    if (entry.name && entry.version) {
      const artifact = findEvidenceForArtifact(
        {
          group: "node",
          kind: "npm",
          name: entry.name,
          ref: entry.version,
          digest: entry.digest,
        },
        evidenceIndex,
      );
      if (!artifact) {
        issues.push(
          issue(
            "error",
            `${label}.artifact`,
            `${label} must have matching npm artifact evidence`,
            {
              role,
              name: entry.name,
              version: entry.version,
            },
          ),
        );
      }
    }
  };
  checkPackageEntry(main, "packageSet.main", "main");
  const platforms = Array.isArray(passport.packageSet.platforms)
    ? passport.packageSet.platforms
    : [];
  if (platforms.length < 3) {
    issues.push(
      issue(
        "error",
        "packageSet.platforms",
        "packageSet must include at least three platform packages",
      ),
    );
  }
  for (const [index, entry] of platforms.entries()) {
    checkPackageEntry(entry, `packageSet.platforms[${index}]`, "platform");
  }
  if (
    !Array.isArray(passport?.publish?.packages) ||
    passport.publish.packages.length !== 1 + platforms.length
  ) {
    issues.push(
      issue(
        "error",
        "publish.packages",
        "publish.packages must summarize main and platform packages",
      ),
    );
  }
}

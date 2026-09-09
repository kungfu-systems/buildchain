import {
  RELEASE_PASSPORT_CONTRACT,
  validateKfdAdopterReleaseEvidence,
} from "../release-passport-contract.js";
import { normalizeGitHubArtifactAttestationPolicy } from "../../build/github-artifact-attestation.js";
import { validateContract, issue } from "./issues.js";
import {
  ARTIFACT_EVIDENCE_CONTRACT,
  IMPACT_LEDGER_CONTRACT,
  AGENT_INDEX_CONTRACT,
  PRODUCT_MECHANISM_CONTRACT,
  optionalString,
  RELEASE_EVIDENCE_ATTACHMENT_CONTRACT,
} from "./identity.js";
import { validateKfdAgentHubReleaseEvidence } from "./trust-validation.js";
import { sha256Text, stableJson } from "./json.js";
export function validateReleaseEvidenceContracts({
  passport,
  artifactEvidence,
  impact,
  agentIndex,
  productMechanism,
  kfdAgentHubEvidence,
  kfdSupportEvidence,
  kfdAdopterManifest,
  kfdAdopterManifestGate,
  checkedAt,
  issues,
}) {
  validateContract(passport, RELEASE_PASSPORT_CONTRACT, "passport", issues);
  validateContract(
    artifactEvidence,
    ARTIFACT_EVIDENCE_CONTRACT,
    "artifactEvidence",
    issues,
  );
  validateContract(impact, IMPACT_LEDGER_CONTRACT, "impact", issues);
  validateContract(agentIndex, AGENT_INDEX_CONTRACT, "agentIndex", issues);
  validateContract(
    productMechanism,
    PRODUCT_MECHANISM_CONTRACT,
    "productMechanism",
    issues,
  );
  validateKfdAgentHubReleaseEvidence(
    passport?.kfdAgentHub,
    kfdAgentHubEvidence,
    issues,
  );
  for (const entry of validateKfdAdopterReleaseEvidence({
    binding: passport?.kfdAdopter,
    artifactBinding: artifactEvidence?.kfdAdopter,
    manifest: kfdAdopterManifest,
    manifestGate: kfdAdopterManifestGate,
    legacyProjection: kfdSupportEvidence,
    passportLegacyProjection: passport?.kfdSupport,
    expectedAdopterId:
      optionalString(passport?.product?.repository) ||
      "kungfu-systems/buildchain",
    expectedSourceRepository: optionalString(passport?.product?.repository),
    expectedSourceSha: optionalString(passport?.release?.sourceSha),
  })) {
    issues.push(issue("error", entry.code, entry.message, entry.details));
  }
  if (!passport?.kfdSupport && kfdSupportEvidence) {
    issues.push(
      issue(
        "error",
        "kfdSupport.section",
        "KFD support evidence is present without a release-passport projection",
      ),
    );
  }

  for (const [index, value] of (
    passport?.githubArtifactAttestations || []
  ).entries()) {
    try {
      const policy = normalizeGitHubArtifactAttestationPolicy(value);
      if (
        policy.caller.sourceSha !==
        String(passport?.release?.sourceSha || "").toLowerCase()
      ) {
        issues.push(
          issue(
            "error",
            `githubArtifactAttestations[${index}].caller.sourceSha`,
            "attestation policy source SHA must match passport.release.sourceSha",
          ),
        );
      }
      const artifact = (passport?.artifacts || []).find(
        (entry) => entry.name === policy.subject.name,
      );
      if (!artifact) {
        issues.push(
          issue(
            "error",
            `githubArtifactAttestations[${index}].subject.name`,
            `attestation subject ${policy.subject.name} is absent from the Release Passport artifacts`,
          ),
        );
      } else if (artifact.sha256 !== policy.subject.digest.sha256) {
        issues.push(
          issue(
            "error",
            `githubArtifactAttestations[${index}].subject.digest`,
            `attestation subject ${policy.subject.name} digest differs from the Release Passport artifact`,
          ),
        );
      }
    } catch (error) {
      issues.push(
        issue("error", `githubArtifactAttestations[${index}]`, error.message),
      );
    }
  }
}
export function validateReleaseEvidenceAttachments({
  passport,
  artifactEvidence,
  normalizedPublishEvidence,
  releaseEvidenceDocuments,
  issues,
}) {
  const evidenceArtifacts = attachmentEvidenceArtifacts({
    artifactEvidence,
    normalizedPublishEvidence,
  });
  const releaseEvidence = Array.isArray(passport?.releaseEvidence)
    ? passport.releaseEvidence
    : [];
  const releaseEvidenceByCoordinate = releaseAttachmentCoordinates({
    releaseEvidenceDocuments,
  });
  const releaseEvidenceIds = new Set();
  const releaseEvidencePaths = new Set();
  for (const [index, reference] of releaseEvidence.entries()) {
    const label = `releaseEvidence[${index}]`;
    if (
      !reference ||
      typeof reference !== "object" ||
      Array.isArray(reference)
    ) {
      issues.push(
        issue("error", `${label}.object`, `${label} must be a JSON object`),
      );
      continue;
    }
    if (reference.contract !== RELEASE_EVIDENCE_ATTACHMENT_CONTRACT) {
      issues.push(
        issue(
          "error",
          `${label}.contract`,
          `${label}.contract must be ${RELEASE_EVIDENCE_ATTACHMENT_CONTRACT}`,
        ),
      );
    }
    if (
      !reference.id ||
      !reference.path ||
      !reference.sha256 ||
      !reference.documentContract
    ) {
      issues.push(
        issue(
          "error",
          `${label}.identity`,
          `${label} must include id, path, sha256, and documentContract`,
        ),
      );
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(reference.id)) {
      issues.push(
        issue(
          "error",
          `${label}.id`,
          `${label}.id must use only letters, digits, dot, underscore, or hyphen`,
        ),
      );
    }
    const expectedPath = `release-evidence-${reference.id}.json`;
    if (reference.path !== expectedPath) {
      issues.push(
        issue(
          "error",
          `${label}.path`,
          `${label}.path must be ${expectedPath}`,
        ),
      );
    }
    if (releaseEvidenceIds.has(reference.id)) {
      issues.push(issue("error", `${label}.id`, `${label}.id must be unique`));
    }
    if (releaseEvidencePaths.has(reference.path)) {
      issues.push(
        issue("error", `${label}.path`, `${label}.path must be unique`),
      );
    }
    releaseEvidenceIds.add(reference.id);
    releaseEvidencePaths.add(reference.path);
    const loaded = releaseEvidenceByCoordinate.get(
      `${reference.id}\0${reference.path}`,
    );
    if (!loaded?.document) {
      issues.push(
        issue(
          "error",
          `${label}.missing`,
          `${label} document is not independently retrievable`,
          {
            id: reference.id,
            path: reference.path,
          },
        ),
      );
      continue;
    }
    const document = loaded.document;
    if (document.contract !== reference.documentContract) {
      issues.push(
        issue(
          "error",
          `${label}.documentContract`,
          `${label} document contract differs from its passport reference`,
        ),
      );
    }
    const digest = sha256Text(stableJson(document));
    if (digest !== reference.sha256) {
      issues.push(
        issue(
          "error",
          `${label}.sha256`,
          `${label} document digest differs from its passport reference`,
        ),
      );
    }
    for (const field of ["sourceSha", "tag", "channel"]) {
      const expected = passport?.release?.[field] || "";
      const declared = document?.release?.[field] || "";
      if (
        !declared ||
        declared !== expected ||
        reference?.release?.[field] !== expected
      ) {
        issues.push(
          issue(
            "error",
            `${label}.release.${field}`,
            `${label} ${field} must match the release passport`,
          ),
        );
      }
    }
  }
  return { evidenceArtifacts, releaseEvidence };
}

function releaseAttachmentCoordinates({ releaseEvidenceDocuments }) {
  return new Map(
    releaseEvidenceDocuments.map((entry) => [
      `${entry?.reference?.id || ""}\0${entry?.reference?.path || ""}`,
      entry,
    ]),
  );
}

function attachmentEvidenceArtifacts({
  artifactEvidence,
  normalizedPublishEvidence,
}) {
  return [
    ...(Array.isArray(artifactEvidence?.artifacts)
      ? artifactEvidence.artifacts
      : []),
    ...(normalizedPublishEvidence?.artifacts || []),
  ];
}

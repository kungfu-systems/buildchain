import {
  validateKfd2TrustTaxonomyEntry,
  resolveKfd1Metadata,
  validateKfd1ReleaseGateEvidence,
  resolveKfd3Metadata,
  validateKfd3CollaborationInterfaceReleaseGateEvidence,
} from "../../adoption/kfd-gate.js";
import { issue } from "./issues.js";
import {
  KFD2_RELEASE_TRUST_PASSPORT_CONTRACT,
  KFD2_TRUST_PROOF_CONTRACT,
  KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT,
  INVARIANT_PASSPORT_GATE_CONTRACT,
  optionalString,
} from "./identity.js";
import { arrayOrEmpty, arrayOrSingleton } from "./trust-claims.js";
import { normalizeKfdAgentHubEvidence } from "./documents.js";
import { stableJson } from "./json.js";
export function validateKfd2ReleaseTrustPassportAudit(section, issues) {
  if (!section) {
    return;
  }
  if (typeof section !== "object" || Array.isArray(section)) {
    issues.push(
      issue(
        "error",
        "kfd-2.object",
        "kfd-2 release trust passport audit must be a JSON object",
      ),
    );
    return;
  }
  if (section.contract !== KFD2_RELEASE_TRUST_PASSPORT_CONTRACT) {
    issues.push(
      issue(
        "error",
        "kfd-2.contract",
        `kfd-2 contract must be ${KFD2_RELEASE_TRUST_PASSPORT_CONTRACT}`,
      ),
    );
  }
  const claims = Array.isArray(section.claims) ? section.claims : [];
  if (claims.length === 0) {
    issues.push(
      issue(
        "error",
        "kfd-2.claims.empty",
        "kfd-2 audit must enumerate at least one public release claim",
      ),
    );
  }
  for (const [reasonIndex, reason] of arrayOrEmpty(
    section.downgradeReasons,
  ).entries()) {
    try {
      validateKfd2TrustTaxonomyEntry(reason, {
        kind: "downgradeReason",
        label: `kfd-2.downgradeReasons[${reasonIndex}]`,
      });
    } catch (error) {
      issues.push(
        issue(
          "error",
          `kfd-2.downgradeReasons[${reasonIndex}]`,
          error.message,
          {
            id: reason?.id || "",
          },
        ),
      );
    }
  }
  for (const [index, claim] of claims.entries()) {
    if (!claim.id || !claim.claim) {
      issues.push(
        issue(
          "error",
          `kfd-2.claims[${index}].identity`,
          "public release claim must include id and statement",
        ),
      );
    }
    if (claim.public === false) {
      continue;
    }
    const missing = Array.isArray(claim.missingBindings)
      ? claim.missingBindings
      : [];
    if (missing.length > 0 || claim.status === "failed") {
      issues.push(
        issue(
          "error",
          `kfd-2.claims[${index}].bindings`,
          "public release claim is missing machine-verifiable trust bindings",
          {
            id: claim.id || "",
            missingBindings: missing,
          },
        ),
      );
    } else if (claim.status === "downgraded" || claim.proseOnly) {
      issues.push(
        issue(
          "warning",
          `kfd-2.claims[${index}].downgraded`,
          "public release claim is downgraded and needs human review",
          {
            id: claim.id || "",
            proseOnly: Boolean(claim.proseOnly),
          },
        ),
      );
    }
    validateKfdClaimTaxonomies({ claim, index, issues });
    validateKfdClaimTrustProof({ claim, index, issues });
  }
  if (section.status === "failed") {
    issues.push(
      issue(
        "error",
        "kfd-2.status",
        "kfd-2 release trust passport audit must not contain failed public claims",
      ),
    );
  } else if (section.status === "downgraded") {
    issues.push(
      issue(
        "warning",
        "kfd-2.status",
        "kfd-2 release trust passport audit is downgraded by prose-only or residual-risk claims",
      ),
    );
  } else if (section.status !== "passed") {
    issues.push(
      issue(
        "error",
        "kfd-2.status",
        "kfd-2 status must be passed, downgraded, or failed",
      ),
    );
  }
}
export function validateKfdAgentHubReleaseEvidence(section, evidence, issues) {
  if (!section && !evidence) return;
  if (!section) {
    issues.push(
      issue(
        "error",
        "kfdAgentHub.section.missing",
        "Agent Hub evidence is present without a release-passport section",
      ),
    );
    return;
  }
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    issues.push(
      issue(
        "error",
        "kfdAgentHub.evidence.missing",
        "release passport must resolve its Agent Hub evidence asset",
      ),
    );
    return;
  }
  let expected;
  try {
    expected = normalizeKfdAgentHubEvidence({ value: evidence });
  } catch (error) {
    issues.push(issue("error", "kfdAgentHub.evidence.invalid", error.message));
    return;
  }
  if (section.contract !== KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT) {
    issues.push(
      issue(
        "error",
        "kfdAgentHub.contract",
        `kfdAgentHub.contract must be ${KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT}`,
      ),
    );
  }
  for (const field of ["evidenceDigest", "reportDigest", "lockRoot"]) {
    if (section[field] !== expected[field]) {
      issues.push(
        issue(
          "error",
          `kfdAgentHub.${field}`,
          `kfdAgentHub.${field} does not match the evidence asset`,
          {
            expected: expected[field],
            actual: section[field],
          },
        ),
      );
    }
  }
  if (
    stableJson(section.sourceCut) !== stableJson(expected.sourceCut) ||
    stableJson(section.scope) !== stableJson(expected.scope)
  ) {
    issues.push(
      issue(
        "error",
        "kfdAgentHub.scope",
        "Agent Hub package cut or adapter scope does not match the evidence asset",
      ),
    );
  }
  if (section.qualifying !== false || section.certification !== false) {
    issues.push(
      issue(
        "error",
        "kfdAgentHub.claimBoundary",
        "Agent Hub evidence must remain nonqualifying and non-certifying",
      ),
    );
  }
}
export function validatePassportTrustSections({ passport, issues }) {
  const kfd1Metadata = resolveKfd1Metadata();
  issues.push(
    ...validateKfd1ReleaseGateEvidence(passport?.[kfd1Metadata.key], {
      metadata: kfd1Metadata,
    }),
  );
  validateKfd2ReleaseTrustPassportAudit(passport?.["kfd-2"], issues);
  const fallbackKfd3Section = passport?.["kfd-3"];
  try {
    const kfd3Metadata = resolveKfd3Metadata();
    const kfd3Section = passport?.[kfd3Metadata.key] || fallbackKfd3Section;
    if (kfd3Section) {
      issues.push(
        ...validateKfd3CollaborationInterfaceReleaseGateEvidence(kfd3Section, {
          metadata: kfd3Metadata,
        }),
      );
    }
  } catch (error) {
    if (fallbackKfd3Section) {
      issues.push(issue("error", "kfd-3.metadata", error.message));
    }
  }
  if (!passport?.invariantPassports) {
    return;
  }
  const section = passport.invariantPassports;
  if (section.contract !== INVARIANT_PASSPORT_GATE_CONTRACT) {
    issues.push(
      issue(
        "error",
        "invariantPassports.contract",
        `invariantPassports.contract must be ${INVARIANT_PASSPORT_GATE_CONTRACT}`,
      ),
    );
  }
  if (section.result !== "passed") {
    issues.push(
      issue(
        "error",
        "invariantPassports.result",
        "invariantPassports.result must be passed",
      ),
    );
  }
  if (!Array.isArray(section.passports) || section.passports.length === 0) {
    issues.push(
      issue(
        "error",
        "invariantPassports.empty",
        "invariantPassports must contain at least one verified passport",
      ),
    );
  }
  const acceptedSourceShas = new Set(
    [
      passport?.release?.sourceSha,
      passport?.release?.builtSourceSha,
      passport?.release?.promotionChannelSha,
    ].filter(Boolean),
  );
  for (const [index, entry] of (section.passports || []).entries()) {
    const prefix = `invariantPassports.passports[${index}]`;
    if (entry.verdict !== "verified")
      issues.push(
        issue(
          "error",
          `${prefix}.verdict`,
          `${prefix}.verdict must be verified`,
        ),
      );
    if (entry.coverage?.complete !== true)
      issues.push(
        issue(
          "error",
          `${prefix}.coverage`,
          `${prefix}.coverage.complete must be true`,
        ),
      );
    if (entry.source?.dirty !== false)
      issues.push(
        issue(
          "error",
          `${prefix}.source.dirty`,
          `${prefix}.source.dirty must be false`,
        ),
      );
    if (
      acceptedSourceShas.size > 0 &&
      !acceptedSourceShas.has(entry.source?.revision)
    ) {
      issues.push(
        issue(
          "error",
          `${prefix}.source.revision`,
          `${prefix}.source.revision must match a release source identity`,
        ),
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(optionalString(entry.passportRoot)))
      issues.push(
        issue(
          "error",
          `${prefix}.passportRoot`,
          `${prefix}.passportRoot is invalid`,
        ),
      );
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0)
      issues.push(
        issue(
          "error",
          `${prefix}.platforms`,
          `${prefix}.platforms must be non-empty`,
        ),
      );
    if (!Array.isArray(entry.residualRisk))
      issues.push(
        issue(
          "error",
          `${prefix}.residualRisk`,
          `${prefix}.residualRisk must be an array`,
        ),
      );
  }
}

function validateKfdClaimTaxonomies({ claim, index, issues }) {
  for (const [riskIndex, risk] of arrayOrSingleton(
    claim.residualRisk || claim.residual_risk,
  ).entries()) {
    try {
      validateKfd2TrustTaxonomyEntry(risk, {
        kind: "residualRisk",
        label: `kfd-2.claims[${index}].residualRisk[${riskIndex}]`,
      });
    } catch (error) {
      issues.push(
        issue(
          "error",
          `kfd-2.claims[${index}].residualRisk[${riskIndex}]`,
          error.message,
          {
            id: risk?.id || claim.id || "",
          },
        ),
      );
    }
  }
  for (const [reasonIndex, reason] of arrayOrSingleton(
    claim.downgradeReasons ||
      claim.downgrade_reasons ||
      claim.downgradeReason ||
      claim.downgrade_reason,
  ).entries()) {
    try {
      validateKfd2TrustTaxonomyEntry(reason, {
        kind: "downgradeReason",
        label: `kfd-2.claims[${index}].downgradeReasons[${reasonIndex}]`,
      });
    } catch (error) {
      issues.push(
        issue(
          "error",
          `kfd-2.claims[${index}].downgradeReasons[${reasonIndex}]`,
          error.message,
          {
            id: reason?.id || claim.id || "",
          },
        ),
      );
    }
  }
}

function validateKfdClaimTrustProof({ claim, index, issues }) {
  if (String(claim.id || "").startsWith("kfd-3:")) {
    const { trustProof } = claimTrustProofObject({ claim });
    if (!trustProof || trustProof.contract !== KFD2_TRUST_PROOF_CONTRACT) {
      issues.push(
        issue(
          "error",
          `kfd-2.claims[${index}].trustProof`,
          "KFD-3 generated public claims must include a KFD-2 trust proof",
          {
            id: claim.id || "",
            expectedContract: KFD2_TRUST_PROOF_CONTRACT,
          },
        ),
      );
    } else {
      if (
        !trustProof.witnessHashes?.prebuildWitnessSha256 ||
        !trustProof.witnessHashes?.artifactWitnessSha256
      ) {
        issues.push(
          issue(
            "error",
            `kfd-2.claims[${index}].trustProof.witnessHashes`,
            "KFD-2 trust proof must preserve KFD-3 witness hashes",
            {
              id: claim.id || "",
            },
          ),
        );
      }
      if (!trustProof.declaredCapabilityVerification?.result) {
        issues.push(
          issue(
            "error",
            `kfd-2.claims[${index}].trustProof.declaredCapabilityVerification`,
            "KFD-2 trust proof must preserve declared capability verification",
            {
              id: claim.id || "",
            },
          ),
        );
      }
      if (!trustProof.reverseAudit?.status) {
        issues.push(
          issue(
            "error",
            `kfd-2.claims[${index}].trustProof.reverseAudit`,
            "KFD-2 trust proof must preserve reverse audit result",
            {
              id: claim.id || "",
            },
          ),
        );
      }
      validateKfdTrustProofBoundary({ claim, index, issues, trustProof });
      if (!Array.isArray(trustProof.residualRisk)) {
        issues.push(
          issue(
            "error",
            `kfd-2.claims[${index}].trustProof.residualRisk`,
            "KFD-2 trust proof must preserve residual risk as an array",
            {
              id: claim.id || "",
            },
          ),
        );
      } else {
        for (const [riskIndex, risk] of trustProof.residualRisk.entries()) {
          try {
            validateKfd2TrustTaxonomyEntry(risk, {
              kind: "residualRisk",
              label: `kfd-2.claims[${index}].trustProof.residualRisk[${riskIndex}]`,
            });
          } catch (error) {
            issues.push(
              issue(
                "error",
                `kfd-2.claims[${index}].trustProof.residualRisk[${riskIndex}]`,
                error.message,
                {
                  id: risk?.id || claim.id || "",
                },
              ),
            );
          }
        }
      }
      if (
        !trustProof.responsibility?.registryFactsOwner ||
        !trustProof.responsibility?.artifactVerificationOwner ||
        !trustProof.responsibility?.releasePassportProofOwner
      ) {
        issues.push(
          issue(
            "error",
            `kfd-2.claims[${index}].trustProof.responsibility`,
            "KFD-2 trust proof must preserve KFD-3 responsibility state",
            {
              id: claim.id || "",
            },
          ),
        );
      }
    }
  }
}

function claimTrustProofObject({ claim }) {
  const trustProof =
    claim.trustProof &&
    typeof claim.trustProof === "object" &&
    !Array.isArray(claim.trustProof)
      ? claim.trustProof
      : undefined;
  return { trustProof };
}

function validateKfdTrustProofBoundary({ claim, index, issues, trustProof }) {
  if (
    !trustProof.reverseAuditBoundary ||
    typeof trustProof.reverseAuditBoundary !== "object" ||
    Array.isArray(trustProof.reverseAuditBoundary)
  ) {
    issues.push(
      issue(
        "error",
        `kfd-2.claims[${index}].trustProof.reverseAuditBoundary`,
        "KFD-2 trust proof must preserve the reverse audit boundary",
        {
          id: claim.id || "",
        },
      ),
    );
  }
}

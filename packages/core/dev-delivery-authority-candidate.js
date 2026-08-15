import {
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { createDevDeliveryCandidateIdentity } from "./dev-delivery-candidate-identity.js";
import { normalizeNativeCommandContract } from "./dev-delivery-native-proof.js";
import { normalizeDevDeliveryTerminalProviderEvidence } from "./dev-delivery-provider-attempt.js";
import { normalizeProviderFailureAuthorityBinding } from "./dev-delivery-warrant-settlement.js";

export const TERMINAL_STATES = new Set([
  "merged",
  "terminal-failure",
  "dequeued",
  "cancelled",
]);
const DELIVERY_CLASSES = new Set([
  "non-native-fast",
  "native-proof-required",
  "cross-platform",
  "release",
]);
export const DEV_DELIVERY_COMPATIBILITY_QUALIFICATION_SCHEMA =
  "kungfu.buildchain.dev-delivery-compatibility-qualification/v1";
export const DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA =
  "kungfu.buildchain.dev-delivery-native-qualification/v1";

function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizedDomains(input = []) {
  if (!Array.isArray(input))
    throw new Error(
      "qualificationDomains must be an array of rooted safety domains",
    );
  return [
    ...new Set(input.map((value) => exactRoot(value, "qualification domain"))),
  ].sort();
}

function candidateIdentity(input, expected) {
  return createDevDeliveryCandidateIdentity(input, expected, (value) => {
    const normalized = text(value);
    if (!DELIVERY_CLASSES.has(normalized))
      throw new Error(`unsupported deliveryClass ${normalized}`);
    return normalized;
  });
}

function nullableRoot(value, label) {
  return value === null ? null : exactRoot(value, label);
}

function normalizeQualification(input) {
  if (!input) return null;
  if (input.schema === DEV_DELIVERY_COMPATIBILITY_QUALIFICATION_SCHEMA) {
    if (input.authority !== "legacy-compatibility-only")
      throw new Error(
        "compatibility qualification cannot claim native authority",
      );
    if (input.nativeProofAuthority !== false)
      throw new Error(
        "compatibility qualification must deny native proof authority",
      );
    if (!["phase-less", "qualified"].includes(input.legacyWarrantPhase))
      throw new Error(
        "compatibility qualification legacy phase is unsupported",
      );
    return {
      schema: input.schema,
      authority: input.authority,
      nativeProofAuthority: false,
      legacyStateRoot: exactRoot(
        input.legacyStateRoot,
        "compatibility qualification legacyStateRoot",
      ),
      legacyWarrantPhase: input.legacyWarrantPhase,
      legacyFencingToken: exactRoot(
        input.legacyFencingToken,
        "compatibility qualification legacyFencingToken",
      ),
      legacyGeneration: nonNegativeInteger(
        input.legacyGeneration,
        "compatibility qualification legacyGeneration",
      ),
      qualificationReceiptRoot: nullableRoot(
        input.qualificationReceiptRoot,
        "compatibility qualification receiptRoot",
      ),
      sourceProofRoot: exactRoot(
        input.sourceProofRoot,
        "compatibility qualification sourceProofRoot",
      ),
      nativeProofRoot: nullableRoot(
        input.nativeProofRoot,
        "compatibility qualification nativeProofRoot",
      ),
      nativeExecutionBindingRoot: nullableRoot(
        input.nativeExecutionBindingRoot,
        "compatibility qualification nativeExecutionBindingRoot",
      ),
      nativeExecutionReceiptRoot: nullableRoot(
        input.nativeExecutionReceiptRoot,
        "compatibility qualification nativeExecutionReceiptRoot",
      ),
      nativeCommandRoot: nullableRoot(
        input.nativeCommandRoot,
        "compatibility qualification nativeCommandRoot",
      ),
      qualificationContractRoot: nullableRoot(
        input.qualificationContractRoot,
        "compatibility qualification contractRoot",
      ),
      qualifiedAt:
        input.qualifiedAt === null
          ? null
          : timestamp(
              input.qualifiedAt,
              "compatibility qualification qualifiedAt",
            ),
    };
  }
  if (input.schema !== DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA)
    throw new Error("native qualification schema is unsupported");
  if (
    input.authority !== "verified-native-qualification" ||
    input.nativeProofAuthority !== true
  )
    throw new Error("native qualification must carry verified proof authority");
  return {
    schema: input.schema,
    authority: input.authority,
    nativeProofAuthority: true,
    ...(input.evidenceRoot
      ? {
          evidenceRoot: exactRoot(
            input.evidenceRoot,
            "qualification evidenceRoot",
          ),
        }
      : {}),
    qualificationReceiptRoot: exactRoot(
      input.qualificationReceiptRoot,
      "qualification receiptRoot",
    ),
    sourceProofRoot: exactRoot(
      input.sourceProofRoot,
      "qualification sourceProofRoot",
    ),
    nativeProofRoot: exactRoot(
      input.nativeProofRoot,
      "qualification nativeProofRoot",
    ),
    nativeExecutionBindingRoot: exactRoot(
      input.nativeExecutionBindingRoot,
      "qualification nativeExecutionBindingRoot",
    ),
    nativeExecutionReceiptRoot: exactRoot(
      input.nativeExecutionReceiptRoot,
      "qualification nativeExecutionReceiptRoot",
    ),
    nativeCommandRoot: exactRoot(
      input.nativeCommandRoot,
      "qualification nativeCommandRoot",
    ),
    qualificationContractRoot: exactRoot(
      input.qualificationContractRoot,
      "qualification contractRoot",
    ),
    qualifiedAt: timestamp(input.qualifiedAt, "qualification qualifiedAt"),
  };
}

export function normalizeDevDeliveryAuthorityCandidate(input, expected) {
  const identity = candidateIdentity(input, expected);
  if (input.candidateId && input.candidateId !== identity.candidateId)
    throw new Error(
      `candidateId mismatch for PR #${identity.pullRequestNumber}`,
    );
  const status = text(input.status || "queued");
  if (
    ![
      "queued",
      "qualifying",
      "qualified",
      "landing",
      ...TERMINAL_STATES,
    ].includes(status)
  )
    throw new Error(`unsupported candidate status ${status || "<empty>"}`);
  const candidate = {
    ...identity,
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    sourceProofRoot: exactRoot(input.sourceProofRoot, "sourceProofRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    enqueuedAt: timestamp(input.enqueuedAt, "candidate enqueuedAt"),
    updatedAt: timestamp(
      input.updatedAt || input.enqueuedAt,
      "candidate updatedAt",
    ),
    status,
    qualification: normalizeQualification(input.qualification),
    terminal: input.terminal
      ? {
          outcome: text(input.terminal.outcome),
          evidenceRoot: exactRoot(
            input.terminal.evidenceRoot,
            "terminal evidenceRoot",
          ),
          reason: text(input.terminal.reason),
          settledAt: timestamp(input.terminal.settledAt, "terminal settledAt"),
          ...(normalizeProviderFailureAuthorityBinding(input.terminal) || {}),
          ...normalizeDevDeliveryTerminalProviderEvidence(input.terminal),
        }
      : null,
  };
  if (Object.hasOwn(input, "environmentRoot"))
    candidate.environmentRoot = exactRoot(
      input.environmentRoot,
      "environmentRoot",
    );
  if (Object.hasOwn(input, "nativeCommandContract")) {
    candidate.nativeCommandContract = normalizeNativeCommandContract(
      input.nativeCommandContract,
    );
  }
  if (Object.hasOwn(input, "affectedPaths")) {
    if (!Array.isArray(input.affectedPaths))
      throw new Error("candidate affectedPaths must be an array");
    candidate.affectedPaths = [
      ...new Set(input.affectedPaths.map(text).filter(Boolean)),
    ].sort();
  }
  if (Object.hasOwn(input, "shardEvidenceRoots")) {
    if (!Array.isArray(input.shardEvidenceRoots))
      throw new Error("candidate shardEvidenceRoots must be an array");
    candidate.shardEvidenceRoots = [
      ...new Set(
        input.shardEvidenceRoots.map((value) =>
          exactRoot(value, "candidate shardEvidenceRoot"),
        ),
      ),
    ].sort();
  }
  if (Object.hasOwn(input, "qualificationDomains"))
    candidate.qualificationDomains = normalizedDomains(
      input.qualificationDomains,
    );
  if (Object.hasOwn(input, "qualificationAttempts"))
    candidate.qualificationAttempts = nonNegativeInteger(
      input.qualificationAttempts,
      "candidate qualificationAttempts",
    );
  if (Object.hasOwn(input, "landingOvertakes"))
    candidate.landingOvertakes = nonNegativeInteger(
      input.landingOvertakes,
      "candidate landingOvertakes",
    );
  return candidate;
}

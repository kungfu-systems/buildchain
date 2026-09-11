import { RELEASE_PASSPORT_CONTRACT } from "../release-passport-contract.js";
export const ARTIFACT_EVIDENCE_CONTRACT = "kungfu-buildchain-artifact-evidence";
export const IMPACT_LEDGER_CONTRACT = "kungfu-buildchain-impact";
export const AGENT_INDEX_CONTRACT = "kungfu-buildchain-agent-index";
export const PRODUCT_MECHANISM_CONTRACT = "kungfu-buildchain-product-mechanism";
export const RELEASE_EVIDENCE_ATTACHMENT_CONTRACT =
  "kungfu-buildchain-release-evidence-attachment";
export const KFD2_RELEASE_TRUST_PASSPORT_CONTRACT =
  "kungfu-buildchain-kfd-2-release-trust-passport-audit";
export const KFD2_TRUST_PROOF_CONTRACT = "kungfu-buildchain-kfd-2-trust-proof";
export const INVARIANT_PASSPORT_GATE_CONTRACT =
  "buildchain.invariant-passport-gate/v1";
export const KFD_AGENT_HUB_RELEASE_EVIDENCE_CONTRACT =
  "kungfu-buildchain-kfd-agent-hub-release-evidence/v1";
export const CONTRACTS = new Set([
  RELEASE_PASSPORT_CONTRACT,
  ARTIFACT_EVIDENCE_CONTRACT,
  IMPACT_LEDGER_CONTRACT,
  AGENT_INDEX_CONTRACT,
  PRODUCT_MECHANISM_CONTRACT,
  RELEASE_EVIDENCE_ATTACHMENT_CONTRACT,
]);
export function nowIso() {
  return new Date().toISOString();
}
export function nonEmptyString(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}
export function optionalString(value) {
  return value === undefined || value === null ? "" : String(value);
}
export function firstTruthy(...values) {
  for (const value of values) {
    if (value) return value;
  }
  return values.at(-1);
}
export function releaseField(release, camelKey, snakeKey, ...fallbacks) {
  return optionalString(
    firstTruthy(release[camelKey], release[snakeKey], ...fallbacks),
  );
}

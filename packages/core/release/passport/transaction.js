import { optionalString } from "./identity.js";
export function normalizeTransactionResult(value = {}) {
  const result = {};
  if (value.command) {
    result.command = optionalString(value.command);
  }
  if (
    value.validation &&
    typeof value.validation === "object" &&
    !Array.isArray(value.validation)
  ) {
    result.validation = {
      valid: Boolean(value.validation.valid),
      errors: Array.isArray(value.validation.errors)
        ? value.validation.errors
        : [],
    };
  }
  if (
    value.recovery &&
    typeof value.recovery === "object" &&
    !Array.isArray(value.recovery)
  ) {
    result.recovery = value.recovery;
  }
  if (value.publishAction || value.distTag) {
    result.publish = {
      action: optionalString(value.publishAction),
      distTag: optionalString(value.distTag),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
export function normalizeTransaction(value = undefined) {
  if (!value) {
    return undefined;
  }
  const raw =
    value.transaction && typeof value.transaction === "object"
      ? value.transaction
      : value;
  return {
    id: optionalString(raw.id || value.id),
    version: optionalString(raw.version || value.version),
    state: optionalString(raw.state || value.state),
    previousState: optionalString(raw.previous_state || raw.previousState),
    exactTag: optionalString(raw.exact_tag || raw.exactTag || value.exactTag),
    releaseSha: optionalString(
      raw.release_sha || raw.releaseSha || value.releaseSha,
    ),
    releaseMaterialSha: optionalString(
      raw.release_material_sha ||
        raw.releaseMaterialSha ||
        value.releaseMaterialSha,
    ),
    stateRef: optionalString(raw.state_ref || raw.stateRef || value.stateRef),
    statePath: optionalString(
      raw.state_path || raw.statePath || value.statePath,
    ),
    stateSha: optionalString(
      value.stateSha || value.state_sha || value.durable?.sha,
    ),
    evidencePath: optionalString(
      raw.evidence_path || raw.evidencePath || value.evidencePath,
    ),
    updatedAt: optionalString(raw.updated_at || raw.updatedAt),
    result: normalizeTransactionResult(value),
  };
}

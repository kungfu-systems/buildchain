import { V4DomainWasmFault, invokeV4DomainWasm } from "./v4-domain-wasm.js";

export const V4_CANONICAL_JSON_CONTRACT = "buildchain-canonical-json/v1";
export const V4_EVENT_ENVELOPE_CONTRACT = "buildchain-v4-event-envelope/v1";
export const V4_RECEIPT_ENVELOPE_CONTRACT = "buildchain-v4-receipt-envelope/v1";
export const V4_CONTRACT_FAULT_CONTRACT = "buildchain-v4-contract-fault/v1";

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CLOCK_PATTERN = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ASCII_KEY_PATTERN = /^[\x20-\x7e]+$/u;
const ASCII_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const ROOT_DOMAINS = new Set([
  "queue-state",
  "candidate-identity",
  "fencing-token",
  "transition-receipt",
  "observation",
  "semantic-diff",
  "bootstrap-evidence",
  "stage-capsule-identity",
  "stage-capsule",
  "stage-capsule-availability",
  "stage-capsule-output-manifest",
  "stage-capsule-retention-promise",
  "stage-capsule-retention-state",
  "stage-capsule-transport",
  "stage-capsule-store-receipt",
  "stage-capsule-quarantine",
  "stage-capsule-resume-observation",
  "stage-capsule-resume-plan",
  "stage-capsule-artifact-manifest",
  "stage-capsule-artifact-content",
  "stage-capsule-fault-campaign",
  "stage-capsule-seed-evidence",
  "stage-capsule-resume-evidence",
  "stage-capsule-platform-qualification",
  "stage-capsule-qualification",
  "stage-capsule-wave-reconciliation",
  "provider-operation-identity",
  "provider-operation-intent",
  "provider-operation-attempt",
  "provider-operation-observation",
  "provider-operation-confirmation",
  "provider-operation-reconciliation",
  "provider-operation-journal",
  "provider-operation-journal-state",
  "provider-readback-sample",
  "provider-readback-fold",
  "release-activation-step",
  "release-activation-plan",
  "release-activation-state",
  "stable-publication-candidate",
  "stable-publication-qualification",
  "stable-publication-target",
  "stable-publication-plan",
  "stable-publication-fence",
  "partial-mutation-recovery-checkpoint",
  "partial-mutation-recovery-plan",
  "v4-product-required-artifacts",
  "v4-product-publication-intent",
  "v4-product-publication-operation",
  "v4-product-publication-plan",
  "tail-reseal-plan",
  "tail-reseal-admission",
  "tail-reseal-artifact-files",
  "tail-reseal-receipt",
  "release-candidate-passport",
  "release-invocation-publisher",
  "release-invocation-runtime",
  "release-invocation-candidate",
  "release-invocation-target",
  "release-invocation-authority",
  "release-invocation-provider",
  "release-invocation-parent",
  "release-invocation",
  "release-transaction",
  "release-receipt",
]);
const FAULT_CLASSES = new Set([
  "validation",
  "concurrency",
  "authority",
  "idempotence",
]);
const RETRY_DECISIONS = new Set(["stop", "reread", "redecide", "reselect"]);
const RECEIPT_OUTCOMES = new Set(["accepted", "rejected", "noop"]);

export class V4ContractFault extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = "V4ContractFault";
    this.code = code;
    this.path = path;
  }
}

function fault(code, path, message) {
  throw new V4ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault("invalid-object", path, `${path} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault("invalid-envelope-shape", path, `${path} keys are not canonical`);
}

function wasm(operation, payload) {
  try {
    return invokeV4DomainWasm(operation, payload);
  } catch (error) {
    if (error instanceof V4DomainWasmFault) {
      fault(error.code, error.path, error.message);
    }
    throw error;
  }
}

export function v4CanonicalBytes(value) {
  return Buffer.from(wasm("canonical-json", value).canonicalUtf8, "utf8");
}

export function v4ContentRoot(domain, value) {
  return wasm("content-root", { domain, value }).root;
}

export function validateV4Root(value, path = "$.root") {
  if (typeof value !== "string" || !ROOT_PATTERN.test(value))
    fault("invalid-root", path, `${path} must be a lowercase sha256 root`);
  return value;
}

export function validateV4Clock(value, path = "$.clock") {
  if (typeof value !== "string" || !CLOCK_PATTERN.test(value))
    fault(
      "invalid-clock",
      path,
      `${path} must be RFC3339 UTC with millisecond precision`,
    );
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    fault("invalid-clock", path, `${path} is not a real UTC instant`);
  return value;
}

export function validateV4ContractFault(value, path = "$.fault") {
  exactKeys(
    value,
    ["schema", "code", "class", "path", "message", "retry"],
    path,
  );
  if (value.schema !== V4_CONTRACT_FAULT_CONTRACT)
    fault("invalid-fault", `${path}/schema`, "unsupported fault schema");
  if (!ASCII_TOKEN_PATTERN.test(value.code))
    fault("invalid-fault", `${path}/code`, "fault code must be an ASCII token");
  if (!FAULT_CLASSES.has(value.class))
    fault("invalid-fault", `${path}/class`, "fault class is unsupported");
  if (typeof value.path !== "string" || !value.path.startsWith("$"))
    fault("invalid-fault", `${path}/path`, "fault path must start with $");
  if (typeof value.message !== "string" || value.message.length === 0)
    fault("invalid-fault", `${path}/message`, "fault message is required");
  if (!RETRY_DECISIONS.has(value.retry))
    fault(
      "invalid-fault",
      `${path}/retry`,
      "fault retry decision is unsupported",
    );
  v4CanonicalBytes(value);
  return value;
}

export function validateV4EventEnvelope(value) {
  exactKeys(
    value,
    ["schema", "eventId", "eventType", "occurredAt", "subjectRoot", "payload"],
    "$",
  );
  if (value.schema !== V4_EVENT_ENVELOPE_CONTRACT)
    fault("invalid-event", "$/schema", "unsupported event schema");
  validateV4Root(value.eventId, "$/eventId");
  validateV4Root(value.subjectRoot, "$/subjectRoot");
  validateV4Clock(value.occurredAt, "$/occurredAt");
  if (!ASCII_TOKEN_PATTERN.test(value.eventType))
    fault("invalid-event", "$/eventType", "event type must be an ASCII token");
  v4CanonicalBytes(value.payload);
  return value;
}

export function validateV4ReceiptEnvelope(value) {
  exactKeys(
    value,
    [
      "schema",
      "receiptType",
      "recordedAt",
      "eventRoot",
      "priorStateRoot",
      "nextStateRoot",
      "outcome",
      "fault",
    ],
    "$",
  );
  if (value.schema !== V4_RECEIPT_ENVELOPE_CONTRACT)
    fault("invalid-receipt", "$/schema", "unsupported receipt schema");
  if (!ASCII_TOKEN_PATTERN.test(value.receiptType))
    fault(
      "invalid-receipt",
      "$/receiptType",
      "receipt type must be an ASCII token",
    );
  validateV4Clock(value.recordedAt, "$/recordedAt");
  validateV4Root(value.eventRoot, "$/eventRoot");
  if (value.priorStateRoot !== null)
    validateV4Root(value.priorStateRoot, "$/priorStateRoot");
  if (value.nextStateRoot !== null)
    validateV4Root(value.nextStateRoot, "$/nextStateRoot");
  if (!RECEIPT_OUTCOMES.has(value.outcome))
    fault("invalid-receipt", "$/outcome", "receipt outcome is unsupported");
  if (value.fault !== null) validateV4ContractFault(value.fault);
  if ((value.outcome === "rejected") !== (value.fault !== null))
    fault(
      "invalid-receipt",
      "$/fault",
      "only rejected receipts carry a typed fault",
    );
  return value;
}

export function v4ContractDomains() {
  return [...ROOT_DOMAINS];
}

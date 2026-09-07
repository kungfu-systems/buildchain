import crypto from "node:crypto";

import {
  ContractFault,
  domainContentRoot,
  validateClock,
  validateRoot,
} from "./canonical-contracts.js";
import { validateStageCapsule } from "./stage-capsule.js";

export const STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT =
  "buildchain-v4-stage-capsule-output-manifest/v1";
export const STAGE_CAPSULE_RETENTION_STATE_CONTRACT =
  "buildchain-v4-stage-capsule-retention-state/v1";
export const STAGE_CAPSULE_TRANSPORT_CONTRACT =
  "buildchain-v4-stage-capsule-transport/v1";
export const STAGE_CAPSULE_STORE_RECEIPT_CONTRACT =
  "buildchain-v4-stage-capsule-store-receipt/v1";

const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PROVIDERS = new Set([
  "local-filesystem",
  "github-artifacts",
  "s3-compatible",
]);
const TRANSPORT_MODES = new Set([
  "local-reference",
  "effect-disabled",
  "fixture-backed",
]);
const OPERATIONS = new Set(["put", "locate", "restore", "quarantine"]);
const OUTCOMES = new Set([
  "stored",
  "already-stored",
  "located",
  "restored",
  "quarantined",
]);

function fault(code, path, message) {
  throw new ContractFault(code, path, message);
}

function exactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fault(
      "invalid-stage-capsule-store-shape",
      path,
      `${path} must be an object`,
    );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    fault(
      "invalid-stage-capsule-store-shape",
      path,
      `${path} keys are not canonical`,
    );
}

function token(value, path) {
  if (typeof value !== "string" || !TOKEN.test(value))
    fault(
      "invalid-stage-capsule-store-token",
      path,
      `${path} must be an ASCII token`,
    );
  return value;
}

export function stageCapsuleBlobRoot(bytes) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function manifestPayload(value) {
  return { schema: value.schema, entries: value.entries };
}

export function stageCapsuleOutputManifestRoot(value) {
  validateStageCapsuleOutputManifest(value, { verifyRoot: false });
  return domainContentRoot(
    "stage-capsule-output-manifest",
    manifestPayload(value),
  );
}

export function validateStageCapsuleOutputManifest(
  value,
  { verifyRoot = true } = {},
) {
  exactKeys(value, ["schema", "entries", "manifestRoot"], "$/manifest");
  if (value.schema !== STAGE_CAPSULE_OUTPUT_MANIFEST_CONTRACT)
    fault(
      "unsupported-stage-capsule-store-version",
      "$/manifest/schema",
      "unsupported output manifest schema",
    );
  if (!Array.isArray(value.entries) || value.entries.length === 0)
    fault(
      "invalid-stage-capsule-store-shape",
      "$/manifest/entries",
      "output manifest entries must be non-empty",
    );
  let prior = null;
  for (const [index, entry] of value.entries.entries()) {
    const entryPath = `$/manifest/entries/${index}`;
    exactKeys(entry, ["name", "root", "size"], entryPath);
    token(entry.name, `${entryPath}/name`);
    validateRoot(entry.root, `${entryPath}/root`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0)
      fault(
        "invalid-stage-capsule-content-size",
        `${entryPath}/size`,
        "content size must be a non-negative safe integer",
      );
    if (prior !== null && entry.name <= prior)
      fault(
        "unordered-stage-capsule-content",
        `${entryPath}/name`,
        "content names must be unique and byte-sorted",
      );
    prior = entry.name;
  }
  validateRoot(value.manifestRoot, "$/manifest/manifestRoot");
  if (
    verifyRoot &&
    value.manifestRoot !==
      domainContentRoot("stage-capsule-output-manifest", manifestPayload(value))
  )
    fault(
      "stage-capsule-manifest-root-mismatch",
      "$/manifest/manifestRoot",
      "manifestRoot does not bind the canonical output manifest",
    );
  return value;
}

export function stageCapsuleRetentionPromiseRoot(promise) {
  exactKeys(promise, ["class", "retainUntil"], "$/retentionPromise");
  token(promise.class, "$/retentionPromise/class");
  validateClock(promise.retainUntil, "$/retentionPromise/retainUntil");
  return domainContentRoot("stage-capsule-retention-promise", promise);
}

export function createStageCapsuleRetentionState({ capsule, evaluatedAt }) {
  validateStageCapsule(capsule);
  validateClock(evaluatedAt, "$/evaluatedAt");
  const value = {
    schema: STAGE_CAPSULE_RETENTION_STATE_CONTRACT,
    capsuleRoot: capsule.capsuleRoot,
    promiseRoot: stageCapsuleRetentionPromiseRoot(capsule.retentionPromise),
    evaluatedAt,
    status:
      evaluatedAt <= capsule.retentionPromise.retainUntil
        ? "retained"
        : "expired",
  };
  return {
    ...value,
    stateRoot: domainContentRoot("stage-capsule-retention-state", value),
  };
}

export function validateStageCapsuleRetentionState(value) {
  exactKeys(
    value,
    [
      "schema",
      "capsuleRoot",
      "promiseRoot",
      "evaluatedAt",
      "status",
      "stateRoot",
    ],
    "$/retentionState",
  );
  if (value.schema !== STAGE_CAPSULE_RETENTION_STATE_CONTRACT)
    fault(
      "unsupported-stage-capsule-store-version",
      "$/retentionState/schema",
      "unsupported retention-state schema",
    );
  validateRoot(value.capsuleRoot, "$/retentionState/capsuleRoot");
  validateRoot(value.promiseRoot, "$/retentionState/promiseRoot");
  validateClock(value.evaluatedAt, "$/retentionState/evaluatedAt");
  if (!new Set(["retained", "expired"]).has(value.status))
    fault(
      "invalid-stage-capsule-retention-state",
      "$/retentionState/status",
      "retention status must be retained or expired",
    );
  validateRoot(value.stateRoot, "$/retentionState/stateRoot");
  const { stateRoot, ...body } = value;
  if (stateRoot !== domainContentRoot("stage-capsule-retention-state", body))
    fault(
      "stage-capsule-retention-root-mismatch",
      "$/retentionState/stateRoot",
      "stateRoot does not bind the retention observation",
    );
  return value;
}

export function createStageCapsuleTransport({
  provider,
  mode,
  locatorRoot,
  observedAt,
}) {
  token(provider, "$/transport/provider");
  if (!PROVIDERS.has(provider) || !TRANSPORT_MODES.has(mode))
    fault(
      "unsupported-stage-capsule-transport",
      "$/transport",
      "unsupported transport provider or mode",
    );
  validateRoot(locatorRoot, "$/transport/locatorRoot");
  validateClock(observedAt, "$/transport/observedAt");
  const value = {
    schema: STAGE_CAPSULE_TRANSPORT_CONTRACT,
    provider,
    mode,
    locatorRoot,
    observedAt,
  };
  return {
    ...value,
    transportRoot: domainContentRoot("stage-capsule-transport", value),
  };
}

export function validateStageCapsuleTransport(value) {
  exactKeys(
    value,
    [
      "schema",
      "provider",
      "mode",
      "locatorRoot",
      "observedAt",
      "transportRoot",
    ],
    "$/transport",
  );
  const rebuilt = createStageCapsuleTransport(value);
  if (
    rebuilt.schema !== value.schema ||
    rebuilt.transportRoot !== value.transportRoot
  )
    fault(
      "stage-capsule-transport-root-mismatch",
      "$/transport/transportRoot",
      "transportRoot does not bind the transport observation",
    );
  return value;
}

export function createStageCapsuleStoreReceipt(value) {
  const body = {
    schema: STAGE_CAPSULE_STORE_RECEIPT_CONTRACT,
    operation: value.operation,
    recordedAt: value.recordedAt,
    capsuleRoot: value.capsuleRoot,
    manifestRoot: value.manifestRoot,
    retentionStateRoot: value.retentionStateRoot,
    availabilityRoot: value.availabilityRoot,
    transportRoot: value.transportRoot,
    qualificationRoot: value.qualificationRoot,
    outcome: value.outcome,
    faultCode: value.faultCode ?? null,
  };
  const receipt = {
    ...body,
    receiptRoot: domainContentRoot("stage-capsule-store-receipt", body),
  };
  return validateStageCapsuleStoreReceipt(receipt);
}

export function validateStageCapsuleStoreReceipt(value) {
  exactKeys(
    value,
    [
      "schema",
      "operation",
      "recordedAt",
      "capsuleRoot",
      "manifestRoot",
      "retentionStateRoot",
      "availabilityRoot",
      "transportRoot",
      "qualificationRoot",
      "outcome",
      "faultCode",
      "receiptRoot",
    ],
    "$/receipt",
  );
  if (value.schema !== STAGE_CAPSULE_STORE_RECEIPT_CONTRACT)
    fault(
      "unsupported-stage-capsule-store-version",
      "$/receipt/schema",
      "unsupported store receipt schema",
    );
  if (!OPERATIONS.has(value.operation) || !OUTCOMES.has(value.outcome))
    fault(
      "invalid-stage-capsule-store-receipt",
      "$/receipt",
      "unsupported store operation or outcome",
    );
  validateClock(value.recordedAt, "$/receipt/recordedAt");
  for (const name of [
    "capsuleRoot",
    "manifestRoot",
    "retentionStateRoot",
    "availabilityRoot",
    "transportRoot",
    "qualificationRoot",
    "receiptRoot",
  ])
    validateRoot(value[name], `$/receipt/${name}`);
  if (value.faultCode !== null)
    fault(
      "invalid-stage-capsule-store-receipt",
      "$/receipt/faultCode",
      "successful store receipts cannot carry a fault",
    );
  const { receiptRoot, ...body } = value;
  if (receiptRoot !== domainContentRoot("stage-capsule-store-receipt", body))
    fault(
      "stage-capsule-store-receipt-root-mismatch",
      "$/receipt/receiptRoot",
      "receiptRoot does not bind the store receipt",
    );
  return value;
}

function validateProviderRequest(operation, request) {
  const keys =
    operation === "put"
      ? ["capsuleRoot", "manifestRoot", "locatorRoot", "recordedAt"]
      : ["capsuleRoot", "locatorRoot", "recordedAt"];
  exactKeys(request, keys, "$/adapter/request");
  for (const name of keys.filter((name) => name.endsWith("Root")))
    validateRoot(request[name], `$/adapter/request/${name}`);
  validateClock(request.recordedAt, "$/adapter/request/recordedAt");
  return request;
}

export function createStageCapsuleProviderAdapter({
  provider,
  mode = "effect-disabled",
  fixture = null,
}) {
  if (!new Set(["github-artifacts", "s3-compatible"]).has(provider))
    fault(
      "unsupported-stage-capsule-transport",
      "$/provider",
      "provider adapter must target GitHub artifacts or S3-compatible storage",
    );
  if (!new Set(["effect-disabled", "fixture-backed"]).has(mode))
    fault(
      "unsupported-stage-capsule-transport",
      "$/mode",
      "provider adapter mode is unsupported",
    );
  if (mode === "fixture-backed" && (!fixture || typeof fixture !== "object"))
    fault(
      "invalid-stage-capsule-store-shape",
      "$/fixture",
      "fixture-backed adapters require explicit fixture operations",
    );
  const invoke = (operation, request) => {
    if (mode === "effect-disabled" || typeof fixture[operation] !== "function")
      fault(
        "stage-capsule-transport-disabled",
        "$/adapter",
        `${provider} ${operation} effects are disabled in this slice`,
      );
    const validated = validateProviderRequest(operation, request);
    return {
      authority: "fixture-only",
      provider,
      result: fixture[operation](validated),
    };
  };
  return Object.freeze({
    provider,
    mode,
    observe: (request) => {
      exactKeys(request, ["locatorRoot", "observedAt"], "$/adapter/request");
      return createStageCapsuleTransport({
        provider,
        mode,
        locatorRoot: request.locatorRoot,
        observedAt: request.observedAt,
      });
    },
    put: (request) => invoke("put", request),
    restore: (request) => invoke("restore", request),
  });
}

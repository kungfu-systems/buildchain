import crypto from "node:crypto";

export const BUILDCHAIN_CACHE_OPERATION_RECEIPT_CONTRACT =
  "buildchain.cache-operation-receipt/v1";
export const BUILDCHAIN_CACHE_EVIDENCE_SET_CONTRACT =
  "buildchain.cache-evidence-set/v1";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const OUTCOMES = new Set([
  "hit",
  "miss",
  "partial",
  "bypassed",
  "poisoned",
  "unavailable",
]);
const METRIC_UNITS = Object.freeze({
  lookupDuration: "ms",
  restoreDuration: "ms",
  saveDuration: "ms",
  restoredBytes: "bytes",
  writtenBytes: "bytes",
  savedTime: "ms",
});
const METRIC_STATUSES = new Set(["observed", "unavailable", "not-applicable"]);
const SAVED_TIME_METHODS = new Set(["producer-measured", "provider-reported"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(ordered(value));
}

export function cacheEvidenceDigest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value))
    .digest("hex")}`;
}

function exactKeys(value, allowed, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${label}.${key} is not allowed`);
  }
}

function text(value, label) {
  assert(
    typeof value === "string" && value.trim() === value && value.length > 0,
    `${label} is required`,
  );
  assert(!/[\r\n\0]/.test(value), `${label} contains control characters`);
  return value;
}

function digest(value, label) {
  assert(DIGEST_RE.test(value), `${label} must be a sha256 digest`);
  return value;
}

function normalizeBindings(bindings = {}) {
  exactKeys(
    bindings,
    new Set([
      "sourceCommit",
      "sourceTree",
      "runtimeCommit",
      "dependencyLockRoot",
      "toolchainRoot",
      "policyRoot",
      "platformRoot",
      "cacheProfileRoot",
      "compilerCachePreparationRoot",
    ]),
    "bindings",
  );
  return Object.fromEntries(
    Object.entries(bindings)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => [key, text(value, `bindings.${key}`)]),
  );
}

function normalizeMetric(metric, name) {
  exactKeys(
    metric,
    new Set([
      "status",
      "unit",
      "value",
      "source",
      "reason",
      "evidenceRoot",
      "method",
    ]),
    `metrics.${name}`,
  );
  const status = text(metric.status, `metrics.${name}.status`);
  assert(
    METRIC_STATUSES.has(status),
    `metrics.${name}.status must be observed, unavailable, or not-applicable`,
  );
  assert(
    metric.unit === METRIC_UNITS[name],
    `metrics.${name}.unit must be ${METRIC_UNITS[name]}`,
  );
  if (status === "observed") {
    assert(
      Number.isFinite(metric.value) && metric.value >= 0,
      `metrics.${name}.value must be a non-negative finite number`,
    );
    const normalized = {
      status,
      unit: metric.unit,
      value: metric.value,
      source: text(metric.source, `metrics.${name}.source`),
      reason: null,
      evidenceRoot: digest(
        metric.evidenceRoot,
        `metrics.${name}.evidenceRoot`,
      ),
    };
    if (name === "savedTime") {
      assert(
        typeof metric.method === "string" &&
          SAVED_TIME_METHODS.has(metric.method),
        "observed saved time requires producer-measured or provider-reported evidence",
      );
      normalized.method = metric.method;
    } else if (metric.method) {
      normalized.method = text(metric.method, `metrics.${name}.method`);
    }
    return normalized;
  }
  assert(
    metric.value === null || metric.value === undefined,
    `metrics.${name}.value must be null when ${status}`,
  );
  return {
    status,
    unit: metric.unit,
    value: null,
    source: metric.source ? text(metric.source, `metrics.${name}.source`) : null,
    reason: text(metric.reason, `metrics.${name}.reason`),
    evidenceRoot: metric.evidenceRoot
      ? digest(metric.evidenceRoot, `metrics.${name}.evidenceRoot`)
      : null,
  };
}

export function createCacheOperationReceipt({
  operationId,
  operation,
  provider,
  producer,
  platform,
  cacheKey,
  cacheRoot,
  outcome,
  bindings = {},
  metrics,
  evidence,
} = {}) {
  assert(
    ["restore", "save", "lookup"].includes(operation),
    "operation must be restore, save, or lookup",
  );
  assert(OUTCOMES.has(outcome), "unsupported cache outcome");
  exactKeys(
    metrics,
    new Set(Object.keys(METRIC_UNITS)),
    "metrics",
  );
  for (const name of Object.keys(METRIC_UNITS)) {
    assert(metrics[name], `metrics.${name} is required`);
  }
  exactKeys(
    evidence,
    new Set(["kind", "root", "locator"]),
    "evidence",
  );
  const receipt = {
    schema: BUILDCHAIN_CACHE_OPERATION_RECEIPT_CONTRACT,
    operationId: text(operationId, "operationId"),
    operation,
    provider: text(provider, "provider"),
    producer: text(producer, "producer"),
    platform: text(platform, "platform"),
    cacheKey: cacheKey ? text(cacheKey, "cacheKey") : null,
    cacheRoot: cacheRoot ? text(cacheRoot, "cacheRoot") : null,
    outcome,
    bindings: normalizeBindings(bindings),
    metrics: Object.fromEntries(
      Object.keys(METRIC_UNITS).map((name) => [
        name,
        normalizeMetric(metrics[name], name),
      ]),
    ),
    evidence: {
      kind: text(evidence.kind, "evidence.kind"),
      root: digest(evidence.root, "evidence.root"),
      locator: text(evidence.locator, "evidence.locator"),
    },
  };
  return { ...receipt, receiptRoot: cacheEvidenceDigest(receipt) };
}

export function verifyCacheOperationReceipt(receipt) {
  assert(
    receipt?.schema === BUILDCHAIN_CACHE_OPERATION_RECEIPT_CONTRACT,
    "cache operation receipt schema mismatch",
  );
  const { receiptRoot, ...body } = receipt;
  assert(
    receiptRoot === cacheEvidenceDigest(body),
    "cache operation receipt root mismatch",
  );
  const rebuilt = createCacheOperationReceipt(body);
  assert(
    stableJson(rebuilt) === stableJson(receipt),
    "cache operation receipt normalization drift",
  );
  return true;
}

export function createCacheEvidenceSet({
  repository,
  sourceCommit,
  sourceTree = "",
  runtimeCommit = "",
  platform,
  operations = [],
} = {}) {
  assert(Array.isArray(operations), "cache evidence operations must be an array");
  operations.forEach(verifyCacheOperationReceipt);
  const operationIds = operations.map(({ operationId }) => operationId);
  assert(
    operationIds.length === new Set(operationIds).size,
    "cache evidence operation ids must be unique",
  );
  const value = {
    schema: BUILDCHAIN_CACHE_EVIDENCE_SET_CONTRACT,
    repository: text(repository, "repository"),
    sourceCommit: text(sourceCommit, "sourceCommit"),
    sourceTree: sourceTree ? text(sourceTree, "sourceTree") : null,
    runtimeCommit: runtimeCommit ? text(runtimeCommit, "runtimeCommit") : null,
    platform: text(platform, "platform"),
    operations: [...operations].sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    ),
  };
  return { ...value, evidenceRoot: cacheEvidenceDigest(value) };
}

export function verifyCacheEvidenceSet(receipt) {
  assert(
    receipt?.schema === BUILDCHAIN_CACHE_EVIDENCE_SET_CONTRACT,
    "cache evidence set schema mismatch",
  );
  const { evidenceRoot, ...body } = receipt;
  assert(
    evidenceRoot === cacheEvidenceDigest(body),
    "cache evidence set root mismatch",
  );
  const rebuilt = createCacheEvidenceSet(body);
  assert(
    stableJson(rebuilt) === stableJson(receipt),
    "cache evidence set normalization drift",
  );
  return true;
}

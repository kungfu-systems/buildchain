import crypto from "node:crypto";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function devDeliveryText(value = "") {
  return String(value ?? "").trim();
}

export function devDeliveryClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function devDeliveryContentRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(`${JSON.stringify(stableValue(value))}\n`)
    .digest("hex")}`;
}

export function devDeliveryExactRoot(value, label) {
  const normalized = devDeliveryText(value).toLowerCase();
  if (!ROOT_PATTERN.test(normalized)) throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

export function devDeliveryExactSha(value, label) {
  const normalized = devDeliveryText(value).toLowerCase();
  if (!SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a 40-character Git SHA`);
  return normalized;
}

export function devDeliveryPositiveInteger(value, label, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function devDeliveryTimestamp(value, label) {
  const normalized = devDeliveryText(value);
  const milliseconds = Date.parse(normalized);
  if (!normalized || !Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return new Date(milliseconds).toISOString();
}

export function devDeliveryRepository(value) {
  const normalized = devDeliveryText(value);
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    throw new Error(`repository must be owner/repo, got ${normalized || "<empty>"}`);
  }
  return normalized;
}

export function devDeliveryProtectedBase(value) {
  const normalized = devDeliveryText(value).replace(/^refs\/heads\//, "");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error(`protectedBase must be dev/vN/vN.M, got ${normalized || "<empty>"}`);
  }
  return normalized;
}

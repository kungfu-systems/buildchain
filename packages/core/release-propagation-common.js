import crypto from "node:crypto";

const SUPPORTED_CHANNELS = new Set(["alpha", "release"]);

export const RELEASE_PROPAGATION_PLAN_CONTRACT = "kungfu-buildchain-release-propagation-plan";

export function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

export function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function normalizeChannel(value, label) {
  const channel = assertString(value, label);
  if (!SUPPORTED_CHANNELS.has(channel)) {
    throw new Error(`${label} must be alpha or release`);
  }
  return channel;
}


export function assertExactFields(value, fields, label) {
  const object = assertPlainObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an invalid field set`);
  }
  return object;
}

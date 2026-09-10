import fs from "node:fs";
const STATE_REF_PREFIX = "buildchain/dev-delivery-warrant/";

export function text(value = "") {
  return String(value ?? "").trim();
}
export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

export function positiveInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function exactRoot(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized))
    throw new Error(`${label} must be a sha256 content root`);
  return normalized;
}

export function exactSha(value, label) {
  const normalized = text(value).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized))
    throw new Error(`${label} must be a 40-character Git SHA`);
  return normalized;
}

export function normalizeRepository(value) {
  const normalized = text(value);
  const match = normalized.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match)
    throw new Error(
      `repository must be owner/repo, got ${normalized || "<empty>"}`,
    );
  return { owner: match[1], repo: match[2], fullName: normalized };
}

export function normalizeBranch(value) {
  const normalized = text(value).replace(/^refs\/heads\//, "");
  if (!/^dev\/v\d+\/v\d+\.\d+$/.test(normalized)) {
    throw new Error(
      `branch must be dev/vN/vN.M, got ${normalized || "<empty>"}`,
    );
  }
  return normalized;
}

export function defaultDevDeliveryStateRef(branch) {
  const normalized = normalizeBranch(branch);
  return `${STATE_REF_PREFIX}${normalized.replaceAll("/", "-")}`;
}

export function normalizeStateRef(value, branch) {
  const normalized = text(value || defaultDevDeliveryStateRef(branch)).replace(
    /^refs\/heads\//,
    "",
  );
  if (
    !normalized.startsWith(STATE_REF_PREFIX) ||
    normalized.includes("..") ||
    normalized.endsWith("/")
  ) {
    throw new Error(`state ref must remain under ${STATE_REF_PREFIX}`);
  }
  return normalized;
}

export function jsonFile(file, label) {
  if (!file) throw new Error(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function jsonList(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value || "[]");
  } catch (cause) {
    throw new Error(`${label} must be a JSON array: ${cause.message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

export function jsonObject(value, label) {
  if (!value) return null;
  let parsed;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch (cause) {
    throw new Error(`${label} must be a JSON object: ${cause.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

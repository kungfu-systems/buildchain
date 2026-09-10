import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const DIGEST = /^sha256:[0-9a-f]{64}$/u;
export const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
export const SAFE_MARKER = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;
export const NON_AUTHORITIES = [
  "first-party-identity",
  "system-identity",
  "kfd-compliance",
  "product-system-metadata",
  "package-metadata",
  "registry-history",
  "scan-output",
  "standalone-generation",
];
export const RENDITIONS = [
  {
    id: "1080p",
    role: "primary",
    columns: 150,
    rows: 36,
    width: 1920,
    height: 1080,
  },
  {
    id: "720p",
    role: "responsive",
    columns: 100,
    rows: 28,
    width: 1280,
    height: 720,
  },
];
export const STANDARD_MAX_SECONDS = 60;
export const LONG_FORM_MAX_SECONDS = 180;
export const PRESENTATION_FRAMED = "presentation-framed";
export const TERMINAL_FILL = "terminal-fill";
export const MAX_EXECUTABLE_FILES = 32;
export const MAX_METADATA_MEMBER_BYTES = 8 * 1024 * 1024;
export const MAX_MEDIA_MEMBER_BYTES = 64 * 1024 * 1024;
export const MAX_GATE_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_BUNDLE_BYTES = 128 * 1024 * 1024;

export function durationPolicy(value = "standard") {
  requireValue(
    value === "standard" || value === "long-form",
    "scenario duration class is invalid",
  );
  return {
    durationClass: value,
    maximumSeconds:
      value === "long-form" ? LONG_FORM_MAX_SECONDS : STANDARD_MAX_SECONDS,
  };
}

export function fail(message) {
  throw new Error(`auditable demo platform: ${message}`);
}

export function requireValue(condition, message) {
  if (!condition) fail(message);
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function rootBytes(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

export function rootJson(value) {
  return rootBytes(Buffer.from(stableJson(value)));
}

export function regular(file, label, maximum = 8 * 1024 * 1024) {
  const metadata = fs.lstatSync(file);
  requireValue(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximum,
    `${label} must be a bounded regular file`,
  );
  return fs.readFileSync(file);
}

export function readJson(file, label) {
  try {
    const value = JSON.parse(regular(file, label).toString("utf8"));
    requireValue(
      value && typeof value === "object" && !Array.isArray(value),
      `${label} must contain an object`,
    );
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is invalid JSON`);
    throw error;
  }
}

export function inside(root, relative, label) {
  requireValue(
    typeof relative === "string" && relative && !path.isAbsolute(relative),
    `${label} must be relative`,
  );
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  requireValue(
    resolved !== resolvedRoot &&
      resolved.startsWith(`${resolvedRoot}${path.sep}`),
    `${label} escapes its root`,
  );
  return resolved;
}

export function exactKeys(value, required, optional, label) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const allowed = new Set([...required, ...optional]);
  for (const key of required)
    requireValue(Object.hasOwn(value, key), `${label}.${key} is required`);
  for (const key of Object.keys(value))
    requireValue(allowed.has(key), `${label}.${key} is not allowed`);
}

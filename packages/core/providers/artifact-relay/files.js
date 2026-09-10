import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function toPosix(value) {
  return String(value || "").replaceAll(path.sep, "/");
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function listFiles(root, rel) {
  const normalized = String(rel || "")
    .replace(/\\/g, "/")
    .replace(/\/\*\*\/?\*?$/, "");
  const target = path.isAbsolute(normalized)
    ? normalized
    : path.join(root, normalized);
  if (!fs.existsSync(target)) {
    return [];
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [target];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => listFiles(root, path.join(target, entry.name)));
}

export function collectGroupFiles(root, paths) {
  const files = new Set();
  for (const entry of paths) {
    for (const file of listFiles(root, entry)) {
      files.add(path.resolve(file));
    }
  }
  return [...files].sort();
}

export function safeSegment(value, fallback = "artifact") {
  const segment = String(value || fallback)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || fallback;
}

export function normalizePrefix(value) {
  return (
    String(value || "buildchain-artifacts").replace(/^\/+|\/+$/g, "") ||
    "buildchain-artifacts"
  );
}

export function assertSafeRelativePath(value) {
  const normalized = path.posix.normalize(
    String(value || "").replace(/\\/g, "/"),
  );
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    path.isAbsolute(normalized)
  ) {
    throw new Error(`unsafe relay object relative path: ${value}`);
  }
  return normalized;
}

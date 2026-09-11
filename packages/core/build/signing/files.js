import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
export function safeSigningId(value) {
  const id = String(value || "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!id || id === "." || id === "..")
    throw new Error("unsafe signing artifact id");
  return id;
}
export function signingFilesNamed(root, name, output = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) signingFilesNamed(child, name, output);
    else if (entry.isFile() && entry.name === name) output.push(child);
  }
  return output;
}
export function resolveSigningPath(root, relative, label) {
  const base = path.resolve(root),
    target = path.resolve(base, required(relative, label)),
    rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`${label} must resolve below its root`);
  const physical = path.relative(
    fs.realpathSync(base),
    fs.realpathSync(target),
  );
  if (physical.startsWith("..") || path.isAbsolute(physical))
    throw new Error(`${label} escapes its root`);
  return target;
}
export function signingFileDigest(file) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}
export function writeSigningResultIndex(root, results) {
  const index = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact-signing-result-index/v1",
    results,
  };
  fs.writeFileSync(
    path.join(root, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  return index;
}

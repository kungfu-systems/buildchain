import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}
export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
export function resolveJsonInputPath(input, { cwd = process.cwd() } = {}) {
  const normalized = String(input || "").trim();
  if (!normalized) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    return fs.existsSync(normalized) ? normalized : "";
  }
  const cwdCandidate = cwd ? path.resolve(cwd, normalized) : "";
  if (cwdCandidate && fs.existsSync(cwdCandidate)) {
    return cwdCandidate;
  }
  return fs.existsSync(normalized) ? path.resolve(normalized) : "";
}
export function jsonInputError({ input, label, cwd, cause }) {
  const suffix = cwd
    ? ` or an existing JSON file path relative to ${cwd}`
    : " or an existing JSON file path";
  return new Error(
    `${label} must be valid JSON${suffix}; received ${JSON.stringify(input)}`,
    { cause },
  );
}
export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
export function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`);
}

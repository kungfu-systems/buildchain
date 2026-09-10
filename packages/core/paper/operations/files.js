import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
export function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}
export function sha256File(filePath) {
  return `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`;
}
export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
export function existingFileFact(cwd, relativePath) {
  const filePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined;
  }
  return {
    path: toPosix(relativePath),
    bytes: fs.statSync(filePath).size,
    sha256: sha256File(filePath),
  };
}
export function extractUrls(value, output = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      output.add(match[0].replace(/[),.;]+$/, ""));
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const entry of value) extractUrls(entry, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) extractUrls(entry, output);
  }
  return output;
}
export function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

import crypto from "node:crypto";
import fs from "node:fs";
export const digest = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
export const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function check(condition, message) {
  if (!condition) throw new Error(`Compose preview: ${message}`);
}

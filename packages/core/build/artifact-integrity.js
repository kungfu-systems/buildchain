import crypto from "node:crypto";
import fs from "node:fs";

export function sha512IntegrityBuffer(buffer) {
  return `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
}

export function sha512IntegrityFile(filePath) {
  return sha512IntegrityBuffer(fs.readFileSync(filePath));
}

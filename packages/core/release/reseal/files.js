import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function readJson(file, label = file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

export function writeJson(file, value) {
  const output = path.resolve(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
}

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

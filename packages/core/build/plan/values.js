import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export const rootOf = (value) =>
  `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

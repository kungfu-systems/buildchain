import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.resolve(process.argv[2] || "");
if (!process.argv[2] || path.basename(destination) !== "dist") {
  throw new Error("usage: copy-v4-domain-wasm.mjs ACTION_DIST_DIRECTORY");
}
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(
  path.join(root, "packages", "core", "buildchain-v4-domain.wasm"),
  path.join(destination, "buildchain-v4-domain.wasm"),
);

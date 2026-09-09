import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function packageVersion() {
  if (embeddedPackageVersion) {
    return embeddedPackageVersion;
  }
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  return packageJson.version;
}

export let root;

export const embeddedPackageVersion =
  process.env.BUILDCHAIN_EMBEDDED_PACKAGE_VERSION || "";

export const embeddedSourceSha =
  process.env.BUILDCHAIN_EMBEDDED_SOURCE_SHA || "";

export function initializeCliRuntime(entryUrl) {
  const resolved = path.resolve(path.dirname(fileURLToPath(entryUrl)), "..");
  if (root && root !== resolved)
    throw new Error("CLI package root cannot change during one process");
  root = resolved;
}

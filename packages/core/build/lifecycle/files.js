import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function toPosix(value) {
  return String(value || "")
    .split(path.sep)
    .join("/");
}

export function listFiles(root, rel) {
  const target = path.isAbsolute(rel) ? rel : path.join(root, rel);
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

export function manifestPathFor(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return toPosix(relative);
  }
  return toPosix(path.resolve(filePath));
}

export function collectArtifactFiles(root, patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    const clean = pattern.replace(/\\/g, "/").replace(/\/\*\*\/?\*?$/, "");
    for (const file of listFiles(root, clean)) {
      files.add(path.resolve(file));
    }
  }
  return [...files].sort();
}

export function signingArtifactPathsForPlatform({
  loadedConfig,
  cwd,
  platformId,
}) {
  const declarations = loadedConfig?.config?.signing?.artifacts || [];
  return declarations
    .filter(
      (entry) =>
        entry.platforms.length === 0 || entry.platforms.includes(platformId),
    )
    .map((entry) => path.resolve(cwd, entry.path));
}

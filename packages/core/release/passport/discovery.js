import fs from "node:fs";
import path from "node:path";
import { normalizeAsset } from "./assets.js";
import { sha256File, readJsonFile } from "./files.js";
export function discoverAssetsFromDir(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry, index) => {
      const filePath = path.join(dir, entry.name);
      return normalizeAsset(
        {
          name: entry.name,
          path: filePath,
          size: fs.statSync(filePath).size,
          sha256: sha256File(filePath),
        },
        index,
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function readPackageVersion(cwd) {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) {
    return "";
  }
  try {
    return readJsonFile(packagePath).version || "";
  } catch {
    return "";
  }
}

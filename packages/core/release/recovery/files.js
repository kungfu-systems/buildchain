import fs from "node:fs";
import path from "node:path";
import { digestFileSync } from "../candidate/transport.js";
export function safeName(value) {
  return String(value || "artifact").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function collectFiles(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  const pending = [resolvedRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile())
        files.push({
          path: path.relative(resolvedRoot, fullPath).split(path.sep).join("/"),
          size: fs.statSync(fullPath).size,
          sha256: `sha256:${digestFileSync(fullPath, "sha256", "hex")}`,
          absolutePath: fullPath,
        });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function findFiles(root, predicate) {
  return collectFiles(root).filter((file) =>
    predicate(file.path, file.absolutePath),
  );
}

export function readOnlyJson(files, label) {
  if (files.length !== 1)
    throw new Error(`expected exactly one ${label}, found ${files.length}`);
  return JSON.parse(fs.readFileSync(files[0].absolutePath, "utf8"));
}

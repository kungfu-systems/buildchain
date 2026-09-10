import fs from "node:fs";
import path from "node:path";
export function findJsonFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    return root.endsWith(".json") ? [root] : [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => findJsonFiles(path.join(root, entry.name)));
}

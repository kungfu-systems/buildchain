import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const actionsRoot = path.join(root, "actions");
const bundlePaths = readdirSync(actionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(actionsRoot, entry.name, "dist", "index.js"))
  .filter((bundlePath) => {
    try {
      readFileSync(bundlePath);
      return true;
    } catch {
      return false;
    }
  })
  .sort();

const before = new Map(
  bundlePaths.map((bundlePath) => [bundlePath, readFileSync(bundlePath)]),
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const build = spawnSync(
  pnpm,
  ["-r", "--filter", "./actions/**", "build"],
  { cwd: root, stdio: "inherit" },
);

if (build.error) {
  throw build.error;
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const changed = bundlePaths.filter(
  (bundlePath) => !before.get(bundlePath).equals(readFileSync(bundlePath)),
);
if (changed.length > 0) {
  console.error("Generated action bundles were stale before the build:");
  for (const bundlePath of changed) {
    console.error(`- ${path.relative(root, bundlePath)}`);
  }
  console.error("Commit the regenerated bundles and rerun pnpm run check.");
  process.exit(1);
}

console.log(`action bundle integrity check passed (${bundlePaths.length} bundles)`);

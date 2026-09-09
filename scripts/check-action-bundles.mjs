import { readFileSync } from "node:fs";
import path from "node:path";
import { actionInventory } from "../packages/core/contracts/action-inventory.js";
import { fileURLToPath } from "node:url";
import { spawnSyncCommand } from "../packages/core/runtime/spawn-command.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePaths = actionInventory(root).flatMap((action) =>
  action.bundles.map((file) => path.join(root, file)),
);

const before = new Map(
  bundlePaths.map((bundlePath) => [bundlePath, readFileSync(bundlePath)]),
);
const build = spawnSyncCommand(
  "pnpm",
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

console.log(
  `action bundle integrity check passed (${bundlePaths.length} bundles)`,
);

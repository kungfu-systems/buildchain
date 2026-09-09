import { spawnSyncCommand } from "../../runtime/spawn-command.js";
import { fileURLToPath } from "node:url";
const args = [
  fileURLToPath(
    new URL("../commands/audit-github-governance.mjs", import.meta.url),
  ),
  "--organization",
  process.env.GITHUB_REPOSITORY_OWNER,
  "--source-revision",
  process.env.GITHUB_SHA,
  "--output",
  "github-governance-audit.json",
];
if (process.env.AUDIT_REPOSITORY)
  args.push(
    "--repository",
    process.env.AUDIT_REPOSITORY,
    "--target-ref",
    process.env.AUDIT_TARGET_REF || "",
  );
const result = spawnSyncCommand(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

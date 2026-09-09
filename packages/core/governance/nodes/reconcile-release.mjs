import fs from "node:fs";
import { spawnSyncCommand } from "../../runtime/spawn-command.js";
const args = [
  ".buildchain/runtime/packages/core/governance/commands/reconcile-release-governance.mjs",
  "reconcile", "--repository", process.env.GITHUB_REPOSITORY,
  "--branch", process.env.BUILDCHAIN_BRANCH,
  "--candidate-sha", process.env.BUILDCHAIN_CANDIDATE_SHA, "--json",
];
if (process.env.BUILDCHAIN_APPLY === "true") args.push("--apply");
const result = spawnSyncCommand(process.execPath, args, {
  encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024,
});
fs.writeFileSync(".buildchain-release-governance-reconciliation.json", result.stdout || "");
process.stdout.write(result.stdout || "");
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

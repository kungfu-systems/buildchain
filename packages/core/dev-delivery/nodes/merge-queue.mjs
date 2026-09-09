import fs from "node:fs";
import { spawnSyncCommand } from "../../runtime/spawn-command.js";
import { runOperation } from "../../runtime/action-process.mjs";

export function mergeQueueArguments(env) {
  return [
    "bin/buildchain.mjs",
    "dev",
    "merge-queue",
    "--cwd",
    ".",
    "--repository",
    env.GITHUB_REPOSITORY,
    "--branch",
    env.BUILDCHAIN_TARGET_BRANCH,
    "--from-config",
    ...(env.BUILDCHAIN_APPLY === "true" ? ["--apply"] : []),
  ];
}
export function reconcileMergeQueue(env) {
  const result = spawnSyncCommand(process.execPath, mergeQueueArguments(env), {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  fs.writeFileSync(".buildchain-dev-merge-queue.json", result.stdout || "");
  process.stdout.write(result.stdout || "");
  if (result.error || result.status !== 0) {
    const error = new Error(
      `Merge queue reconciliation failed with status ${result.status ?? 1}`,
    );
    error.status = result.status ?? 1;
    throw error;
  }
  const facts = JSON.parse(result.stdout);
  fs.appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      "## Dev merge queue governance",
      "",
      `- branch: ${env.BUILDCHAIN_TARGET_BRANCH}`,
      `- mode: ${facts.policyResolution.mode}`,
      `- action: ${facts.action}`,
      `- applied: ${facts.applied}`,
      `- source branch: ${facts.policyResolution.sourceBranch || "none"}`,
      "",
    ].join("\n"),
  );
}
await runOperation({ reconcile: reconcileMergeQueue });

import os from "node:os";
import { runLifecycle } from "../lifecycle/transaction.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
import { runScript } from "../../workflow/cli/process.mjs";

export async function handleLifecycleCommand(args) {
  const [subcommand, stageName = "", ...lifecycleArgs] = args;
  if (subcommand !== "run" || !stageName) {
    throw new Error("usage: buildchain lifecycle run <stage>");
  }
  const artifactPaths = readRepeatedFlag(lifecycleArgs, "artifact-path");
  const manifest = runLifecycle({
    cwd: readFlag(lifecycleArgs, "cwd", process.cwd()),
    stageName,
    required: readBooleanFlag(lifecycleArgs, "required"),
    artifactName: readFlag(
      lifecycleArgs,
      "artifact-name",
      "buildchain-artifact",
    ),
    artifactPaths,
    platformId: readFlag(lifecycleArgs, "platform-id", os.platform()),
    platformName: readFlag(
      lifecycleArgs,
      "platform-name",
      readFlag(lifecycleArgs, "platform-id", os.platform()),
    ),
    manifestPath: readFlag(
      lifecycleArgs,
      "manifest-path",
      ".buildchain/artifacts/manifest.json",
    ),
    summaryPath: readFlag(
      lifecycleArgs,
      "summary-path",
      ".buildchain/artifacts/summary.json",
    ),
    expectedArtifactsJson: readFlag(
      lifecycleArgs,
      "expected-artifacts-json",
      "",
    ),
    logPath: readFlag(
      lifecycleArgs,
      "log-path",
      process.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl",
    ),
    processSummaryPath: readFlag(lifecycleArgs, "process-summary", ""),
    workspace: process.cwd(),
  });
  printJson(manifest);
  return;
}

export async function handleBuildContractCommand(args) {
  runScript("packages/core/build/commands/resolve-build-contract.mjs", args);
  return;
}

import { initBuildchainRepo } from "../commands/init-repo.mjs";
import { validateBuildchainConfig } from "../../consumer/buildchain-config.js";
import { validateConsumerWiring } from "../../consumer/contract/local-validation.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
} from "../../contracts/cli/options.mjs";

export async function handleInitCommand(args) {
  const result = initBuildchainRepo({
    cwd: readFlag(args, "cwd", process.cwd()),
    type: readFlag(args, "type", "package"),
    force: readBooleanFlag(args, "force"),
    packageManager: readFlag(args, "package-manager", ""),
    runnerPreset: readFlag(args, "runner-preset", "github-hosted"),
    artifactName: readFlag(args, "artifact-name", ""),
  });
  printJson(result);
  return;
}

export async function handleValidateCommand(args) {
  const lifecycleStages = readFlag(args, "require-lifecycle-stages", "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const cwd = readFlag(args, "cwd", process.cwd());
  const result = validateBuildchainConfig(cwd, {
    requireVersionState: readBooleanFlag(args, "require-version-state"),
    requireLifecycleStages: lifecycleStages,
  });
  if (result.config?.schema === 2)
    result.consumer = validateConsumerWiring(cwd, result.config.path);
  printJson(result);
  return;
}

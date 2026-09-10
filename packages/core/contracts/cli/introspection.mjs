import { BUILDCHAIN_USAGE } from "../../workflow/commands/buildchain-cli-help.mjs";
import { formatCliHelp } from "../cli-reference.js";
import { createBuildchainLayoutDiscovery } from "../buildchain-layout.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "./options.mjs";
import { packageVersion } from "./context.mjs";

export async function handleHelpCommand(args) {
  process.stdout.write(
    formatCliHelp({ usageText: BUILDCHAIN_USAGE, pathParts: args }),
  );
  return;
}

export async function handleVersionCommand(args) {
  process.stdout.write(`${packageVersion()}\n`);
  return;
}

export async function handleLayoutCommand(args) {
  const result = createBuildchainLayoutDiscovery({
    cwd: readFlag(args, "cwd", process.cwd()),
    buildchainVersion: packageVersion(),
  });
  if (readBooleanFlag(args, "json")) {
    printJson(result);
  } else {
    process.stdout.write(
      `Buildchain layout (${result.buildchain.version || "unknown"})\n`,
    );
    process.stdout.write(`- config: ${result.repository.configPath}\n`);
    process.stdout.write(
      `- KFD-3 registry: ${result.kfd.registries["kfd-3"].path}\n`,
    );
    process.stdout.write(
      `- Shifu jurisdiction: ${result.shifu.jurisdiction.field}=${result.shifu.jurisdiction.value}\n`,
    );
  }
  return;
}

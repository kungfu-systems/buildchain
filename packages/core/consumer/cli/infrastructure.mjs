import { runScript } from "../../workflow/cli/process.mjs";

export async function handleInfraContractCommand(args) {
  runScript("packages/core/providers/commands/infra-contract.mjs", args);
  return;
}

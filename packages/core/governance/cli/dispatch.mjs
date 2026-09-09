import { runReleaseGovernanceCli } from "../commands/reconcile-release-governance.mjs";
import { runScript } from "../../workflow/cli/process.mjs";

export async function handleArchitectureCommand(args) {
  runScript("packages/core/governance/commands/architecture.mjs", args);
}

export async function handleGitHubGovernanceCommand(args) {
  runScript(
    "packages/core/governance/commands/reconcile-github-governance.mjs",
    args,
  );
  return;
}

export async function handleReleaseGovernanceCommand(args) {
  await runReleaseGovernanceCli(args);
  return;
}

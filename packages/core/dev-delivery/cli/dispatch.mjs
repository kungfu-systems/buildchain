import { runScript } from "../../workflow/cli/process.mjs";

export async function handleDevCommand(args) {
  const [subcommand = "", ...devArgs] = args;
  const directScript = {
    deliver: [
      "packages/core/dev-delivery/commands/dev-delivery-request.sh",
      "/bin/bash",
    ],
    "pr-admit": [
      "packages/core/dev-delivery/commands/dev-pr-auto-merge.mjs",
      process.execPath,
    ],
  }[subcommand];
  if (directScript) {
    runScript(directScript[0], devArgs, directScript[1]);
    return;
  }
  if (subcommand === "warrant") {
    runScript(
      "packages/core/dev-delivery/commands/dev-delivery-warrant.mjs",
      devArgs,
    );
    return;
  }
  if (subcommand === "authority") {
    runScript(
      "packages/core/dev-delivery/commands/dev-delivery-authority.mjs",
      devArgs,
    );
    return;
  }
  if (subcommand === "proof") {
    runScript(
      "packages/core/dev-delivery/commands/dev-delivery-proof.mjs",
      devArgs,
    );
    return;
  }
  if (subcommand === "two-phase") {
    runScript(
      "packages/core/dev-delivery/commands/dev-delivery-two-phase.mjs",
      devArgs,
    );
    return;
  }
  if (subcommand !== "merge-queue") {
    throw new Error(
      "usage: buildchain dev <deliver|pr-admit|merge-queue|warrant|authority|proof|two-phase> [options]",
    );
  }
  runScript("packages/core/dev-delivery/commands/dev-merge-queue.mjs", devArgs);
  return;
}

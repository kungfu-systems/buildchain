import { runReleasePropagationCli } from "../commands/release-propagation.mjs";
import { runReleaseTailCli } from "../commands/release-tail.mjs";
import { runTailResealCli } from "../commands/tail-reseal.mjs";
import {
  TRUST_RELEASE_COMMANDS,
  dispatchTrustReleaseCommand,
} from "./trust-release.mjs";
import { packageVersion } from "../../contracts/cli/context.mjs";
import { runScript } from "../../workflow/cli/process.mjs";

export async function handleTrustReleaseCommand(args, { command }) {
  await dispatchTrustReleaseCommand({
    command,
    args,
    runScript,
    packageVersion,
  });
  return;
}

export async function handleReleasePropagationCommand(args) {
  await runReleasePropagationCli(args);
  return;
}

export async function handleReleaseTailCommand(args) {
  await runReleaseTailCli(args);
}

export async function handleTailResealCommand(args) {
  await runTailResealCli(args);
}

export async function handleNextDevelopmentCommand(args) {
  runScript(
    "packages/core/release/commands/next-development-transition.mjs",
    args,
  );
}

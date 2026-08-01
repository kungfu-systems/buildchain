import {
  TRUST_RELEASE_COMMANDS,
  TRUST_RELEASE_COMMAND_HANDLERS,
} from "./trust-release-command-handlers.mjs";

async function dispatchTrustReleaseCommand({
  command,
  args,
  runScript,
  packageVersion,
}) {
  const handler = TRUST_RELEASE_COMMAND_HANDLERS[command];
  if (!handler) {
    throw new Error(`unsupported trust or release command: ${command}`);
  }
  return handler({ args, runScript, packageVersion });
}

export { TRUST_RELEASE_COMMANDS, dispatchTrustReleaseCommand };

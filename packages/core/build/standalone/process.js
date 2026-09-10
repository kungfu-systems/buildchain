import { spawnSync } from "node:child_process";
import {
  resolveSpawnCommand,
  usesShellForSpawnCommand,
} from "../../runtime/spawn-command.js";
import { timed } from "./logging.js";
export function run(command, args, options = {}) {
  const {
    logger,
    event = "process.run",
    phase = "process",
    attributes = {},
    ...spawnOptions
  } = options;
  const resolvedCommand = resolveSpawnCommand(command);
  const shell = spawnOptions.shell ?? usesShellForSpawnCommand(command);
  const runCommand = () => {
    const result = spawnSync(resolvedCommand, args, {
      stdio: "inherit",
      ...spawnOptions,
      shell,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw Object.assign(
        new Error(`${command} exited with ${result.status}`),
        { status: result.status },
      );
    }
  };
  if (logger) {
    return timed(
      logger,
      event,
      {
        phase,
        attributes: {
          command,
          resolvedCommand,
          args: args.join(" "),
          ...attributes,
        },
      },
      runCommand,
    );
  }
  return runCommand();
}

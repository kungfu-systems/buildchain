import { spawnSync } from "node:child_process";

const WINDOWS_CMD_SHIMS = new Set(["corepack", "npm", "npx", "pnpm", "yarn"]);

export function resolveSpawnCommand(command, platform = process.platform) {
  if (platform !== "win32" || !WINDOWS_CMD_SHIMS.has(command)) {
    return command;
  }
  return `${command}.cmd`;
}

export function usesShellForSpawnCommand(command, platform = process.platform) {
  return platform === "win32" && WINDOWS_CMD_SHIMS.has(command);
}

export function spawnSyncCommand(
  command,
  args,
  options = {},
  { platform = process.platform, spawn = spawnSync } = {},
) {
  return spawn(resolveSpawnCommand(command, platform), args, {
    ...options,
    shell: options.shell ?? usesShellForSpawnCommand(command, platform),
  });
}

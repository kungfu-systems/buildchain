import path from "node:path";
import { spawnSyncCommand } from "./spawn-command.js";

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function command(program, args, options = {}) {
  const result = spawnSyncCommand(program, args, {
    stdio: "inherit",
    encoding: "utf8",
    ...options,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(
      `${path.basename(program)} failed with status ${result.status ?? 1}`,
    );
    error.status = result.status ?? 1;
    throw error;
  }
  return result.stdout;
}

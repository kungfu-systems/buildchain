import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "../../contracts/cli/context.mjs";

export function runScript(scriptName, args, runner = process.execPath) {
  const scriptPath = path.join(root, scriptName);
  const result = spawnSync(runner, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

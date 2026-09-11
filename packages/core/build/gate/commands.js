import path from "node:path";
import { spawnSync } from "node:child_process";
function cmdQuote(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function windowsBatchInvocation(command, args, { cwd, comSpec } = {}) {
  const resolvedCommand = /[\\/]/u.test(command)
    ? path.win32.resolve(cwd || process.cwd(), command)
    : command;
  return {
    command: comSpec || "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [resolvedCommand, ...args].map(cmdQuote).join(" "),
    ],
  };
}

export function commandSpawnOptions({ cwd, env, streamOutput = false } = {}) {
  if (streamOutput) return { cwd, env, stdio: "inherit" };
  return {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  };
}

export function runGateCommand(
  argv,
  args,
  { cwd, env, allowFailure = false, streamOutput = false } = {},
) {
  const command = argv[0];
  const commandArgs = [...argv.slice(1), ...args];
  const windowsBatch =
    process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const batchInvocation = windowsBatch
    ? windowsBatchInvocation(command, commandArgs, {
        cwd,
        comSpec: env?.ComSpec,
      })
    : null;
  const spawnOptions = commandSpawnOptions({ cwd, env, streamOutput });
  const result = windowsBatch
    ? spawnSync(batchInvocation.command, batchInvocation.args, spawnOptions)
    : spawnSync(command, commandArgs, spawnOptions);
  if (!streamOutput && result.stdout) process.stdout.write(result.stdout);
  if (!streamOutput && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  if (!allowFailure && status !== 0) {
    const error = new Error(`${command} exited with status ${status}`);
    error.status = status;
    throw error;
  }
  return { ...result, status };
}

export function gateArgs(base, registry) {
  return registry ? [...base, "--registry", registry] : base;
}

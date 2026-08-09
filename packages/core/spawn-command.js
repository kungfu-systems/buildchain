import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WINDOWS_CMD_SHIMS = new Set(["corepack", "npm", "npx", "pnpm", "yarn"]);
const INTERNAL_PROCESS_TREE_COMMAND = "--buildchain-internal-process-tree-command";
const TIMEOUT_EXIT_CODE = 124;
const modulePath = fileURLToPath(import.meta.url);

function runningStandaloneBundle() {
  return process.argv[1] && process.argv[2] !== INTERNAL_PROCESS_TREE_COMMAND
    && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function pathCommandShim(command, env) {
  for (const directory of String(env.PATH || "").split(";")) {
    const candidate = path.join(directory, `${command}.cmd`);
    if (directory && fs.existsSync(candidate)) return true;
  }
  return false;
}

export function resolveSpawnCommand(command, platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return command;
  }
  return pathCommandShim(command, env) || WINDOWS_CMD_SHIMS.has(command)
    ? `${command}.cmd`
    : command;
}

export function usesShellForSpawnCommand(command, platform = process.platform, env = process.env) {
  return platform === "win32" && /\.cmd$/i.test(resolveSpawnCommand(command, platform, env));
}

function cmdQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function windowsBatchInvocation(command, args, env = process.env) {
  return {
    command: env.ComSpec || process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(cmdQuote).join(" ")],
  };
}

export function spawnSyncCommand(
  command,
  args,
  options = {},
  { platform = process.platform, spawn = spawnSync } = {},
) {
  const env = options.env || process.env;
  const resolvedCommand = resolveSpawnCommand(command, platform, env);
  if (
    platform === "win32" &&
    /\.cmd$/i.test(resolvedCommand) &&
    options.shell !== false
  ) {
    const invocation = windowsBatchInvocation(resolvedCommand, args, env);
    return spawn(invocation.command, invocation.args, {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(resolvedCommand, args, {
    ...options,
    shell: options.shell ?? false,
  });
}

async function terminateProcessTree(child, graceMs) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const fallback = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process tree may already be gone.
        }
        resolve();
      }, graceMs);
      killer.once("error", () => {
        clearTimeout(fallback);
        try {
          child.kill("SIGKILL");
        } catch {
          // The process tree may already be gone.
        }
        resolve();
      });
      killer.once("close", () => {
        clearTimeout(fallback);
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process group exited during the grace period.
  }
}

async function runInternalProcessTreeCommand() {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let timedOut = false;
  let spawnError;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: 1, signal: "" });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, payload.graceMs);
    }, payload.timeoutMs)
    : undefined;
  const result = await closed;
  if (timer) clearTimeout(timer);
  process.exitCode = timedOut
    ? TIMEOUT_EXIT_CODE
    : spawnError || result.signal
      ? 1
      : (result.code ?? 1);
}

function shellCommandArgs(command, shell) {
  if (typeof shell === "string" && shell.trim()) return [shell, "-c", command];
  if (process.platform === "win32") {
    return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", command];
  }
  return [process.env.SHELL || "/bin/sh", "-c", command];
}

function standaloneProcessCommand(command, args, options) {
  const result = spawnSync(command, args, { ...options, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    const error = new Error(`process tree command failed with status ${result.status ?? ""}`);
    error.status = result.status ?? 1;
    error.signal = result.signal || "";
    throw error;
  }
  return result.stdout;
}

export function runProcessTreeCommandSync(command, args, {
  cwd = process.cwd(),
  env = process.env,
  stdio = "inherit",
  timeout,
  graceMs = 2000,
} = {}) {
  if (runningStandaloneBundle()) {
    return standaloneProcessCommand(command, args, { cwd, env, stdio, timeout });
  }
  const commandStdio = Array.isArray(stdio)
    ? ["pipe", stdio[1] || "inherit", stdio[2] || "inherit"]
    : ["pipe", stdio, stdio];
  try {
    return execFileSync(process.execPath, [modulePath, INTERNAL_PROCESS_TREE_COMMAND], {
      cwd,
      env,
      stdio: commandStdio,
      input: JSON.stringify({ command, args, cwd, timeoutMs: timeout, graceMs }),
      windowsHide: true,
    });
  } catch (error) {
    if (error?.status === TIMEOUT_EXIT_CODE) error.code = "ETIMEDOUT";
    throw error;
  }
}

export function runShellCommandSync(command, options = {}) {
  if (runningStandaloneBundle()) return execSync(command, options);
  const [shell, ...args] = shellCommandArgs(command, options.shell);
  return runProcessTreeCommandSync(shell, args, options);
}

if (
  process.argv[1]
  && process.argv[2] === INTERNAL_PROCESS_TREE_COMMAND
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runInternalProcessTreeCommand().catch((error) => {
    console.error(`buildchain: process tree command failed: ${error.message}`);
    process.exitCode = 1;
  });
}

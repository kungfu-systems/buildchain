#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INTERNAL_COMMAND = "--buildchain-internal-git-fetch";
const CMD_META_CHARACTERS = /([()\][%!^`"<>&|;, *?])/g;
const TIMEOUT_EXIT_CODE = 124;
const scriptPath = fileURLToPath(import.meta.url);

function cmdEscapeCommand(value) {
  return String(value).replace(CMD_META_CHARACTERS, "^$1");
}

function cmdEscapeArgument(value) {
  let text = String(value);
  text = text.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  text = text.replace(/(?=(\\+?)?)\1$/g, "$1$1");
  return `"${text}"`.replace(CMD_META_CHARACTERS, "^$1");
}

function resolveGitInvocation(args, env = process.env) {
  if (process.platform !== "win32") return { command: "git", args };
  const gitShim = String(env.PATH || "")
    .split(path.delimiter)
    .map((directory) => path.join(directory, "git.cmd"))
    .find((candidate) => fs.existsSync(candidate));
  if (!gitShim) return { command: "git", args };
  const shellCommand = [
    cmdEscapeCommand(gitShim),
    ...args.map(cmdEscapeArgument),
  ].join(" ");
  return {
    command: env.ComSpec || env.comspec || process.env.ComSpec || process.env.comspec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

async function terminateProcessTree(child, graceMs) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
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

async function runInternalGitFetch() {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const timeoutMs = Math.max(1, Number(payload.timeoutMs || 60000));
  const graceMs = Math.max(
    50,
    Number(process.env.BUILDCHAIN_GIT_TIMEOUT_GRACE_MS || 2000),
  );
  const invocation = resolveGitInvocation(payload.args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: payload.cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let timedOut = false;
  let spawnError;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: 1, signal: "" });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(child, graceMs);
  }, timeoutMs);
  const result = await closed;
  clearTimeout(timer);
  if (stdout.length) process.stdout.write(Buffer.concat(stdout));
  if (stderr.length) process.stderr.write(Buffer.concat(stderr));
  if (spawnError)
    console.error(
      `buildchain: failed to start git fetch: ${spawnError.message}`,
    );
  if (timedOut)
    console.error(
      `buildchain: git fetch timed out after ${timeoutMs}ms; process tree terminated`,
    );
  if (result.signal && !timedOut)
    console.error(`buildchain: git fetch terminated by ${result.signal}`);
  process.exitCode = timedOut
    ? TIMEOUT_EXIT_CODE
    : spawnError || result.signal
      ? 1
      : (result.code ?? 1);
}

export function runGitFetchSync({ args, cwd, env, timeoutMs, stdio }) {
  const commandStdio = Array.isArray(stdio)
    ? ["pipe", stdio[1] || "pipe", stdio[2] || "pipe"]
    : ["pipe", stdio, stdio];
  try {
    const output = execFileSync(
      process.execPath,
      [scriptPath, INTERNAL_COMMAND],
      {
        cwd,
        env,
        encoding: "utf8",
        stdio: commandStdio,
        input: JSON.stringify({ args, cwd, timeoutMs }),
        windowsHide: true,
      },
    );
    return output ? String(output).trim() : "";
  } catch (error) {
    if (error?.status === TIMEOUT_EXIT_CODE) error.code = "ETIMEDOUT";
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] !== INTERNAL_COMMAND)
    throw new Error("internal git fetch command required");
  await runInternalGitFetch();
}

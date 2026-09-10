import { execFileSync } from "node:child_process";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
const TIMEOUT_EXIT_CODE = 124;
export function runGitFetchSync({ args, cwd, env, timeoutMs, stdio }) {
  const workerPath = path.join(
    installationRoot(import.meta.url),
    "packages/core/providers/git/fetch-worker.js",
  );
  const commandStdio = Array.isArray(stdio)
    ? ["pipe", stdio[1] || "pipe", stdio[2] || "pipe"]
    : ["pipe", stdio, stdio];
  try {
    const output = execFileSync(process.execPath, [workerPath], {
      cwd,
      env,
      encoding: "utf8",
      stdio: commandStdio,
      input: JSON.stringify({ args, cwd, timeoutMs }),
      windowsHide: true,
    });
    return output ? String(output).trim() : "";
  } catch (error) {
    if (error?.status === TIMEOUT_EXIT_CODE) error.code = "ETIMEDOUT";
    throw error;
  }
}

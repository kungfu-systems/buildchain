import fs from "node:fs";
import path from "node:path";
import { spawnSyncCommand } from "./spawn-command.js";
import { requireValue } from "./action-process.mjs";

function execute(program, args, options) {
  const result = spawnSyncCommand(program, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Object.assign(
      new Error(`${program} failed with status ${result.status ?? 1}`),
      { status: result.status ?? 1 },
    );
  return result.stdout;
}

export function installLockedDependencies(
  { directory, production = true, ignoreScripts = true },
  run = execute,
) {
  const cwd = path.resolve(directory);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );
  requireValue(
    /^pnpm@\d+\.\d+\.\d+(?:\+sha\d+\.[a-zA-Z0-9]+)?$/u.test(
      manifest.packageManager || "",
    ),
    "Locked dependency installation requires an exact pnpm packageManager",
  );
  requireValue(
    fs.statSync(path.join(cwd, "pnpm-lock.yaml")).isFile(),
    "Locked dependency installation requires pnpm-lock.yaml",
  );
  // Resolve PATH's selected toolchain, not the runner's private action runtime.
  const nodePath = run("node", ["-p", "process.execPath"], {
    cwd,
    stdio: "pipe",
  }).trim();
  const version = run(nodePath, ["-p", "process.versions.node"], {
    cwd,
    stdio: "pipe",
  }).trim();
  requireValue(
    /^24\./u.test(version),
    "Buildchain dependency preparation requires selected Node 24",
  );
  run("corepack", ["enable"], { cwd });
  run(
    "corepack",
    [
      "pnpm",
      "install",
      "--frozen-lockfile",
      ...(production ? ["--prod"] : []),
      ...(ignoreScripts ? ["--ignore-scripts"] : []),
    ],
    { cwd },
  );
  return { nodePath: nodePath.replaceAll("\\", "/") };
}

export function lockedDependenciesAction(core) {
  const result = installLockedDependencies({
    directory: core.getInput("directory", { required: true }),
    production: core.getBooleanInput("production"),
    ignoreScripts: core.getBooleanInput("ignore-scripts"),
  });
  core.setOutput("node-path", result.nodePath);
}

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initBuildchainRepo } from "../scripts/init-repo.mjs";
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
import { validateBuildchainConfig } from "../packages/core/buildchain-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage:
  buildchain --help
  buildchain version
  buildchain init [--cwd <dir>] [--type package|native|web-surface|anchored-package] [--force]
                  [--package-manager pnpm|npm|yarn] [--runner-preset <preset>]
                  [--artifact-name <template>]
  buildchain validate [--cwd <dir>] [--require-version-state]
                      [--require-lifecycle-stages <comma-list>]
  buildchain lifecycle run <stage> [--cwd <dir>] [--required]
                             [--artifact-name <name>] [--artifact-path <path>]...
  buildchain release <inspect|recover|finalize|abort> ...
  buildchain web-surface ...
  buildchain publish-source <lock|manifest|verify-lock> ...
  buildchain build-contract ...

Examples:
  buildchain init --type package --package-manager pnpm
  buildchain validate --require-version-state --require-lifecycle-stages build,verify
  buildchain lifecycle run build --artifact-path dist --artifact-name "{repo}-{version}-{platform}"
`;
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] || "";
}

function readBooleanFlag(args, name) {
  return args.includes(`--${name}`);
}

function readRepeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function runScript(scriptName, args) {
  const scriptPath = path.join(root, "scripts", scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function packageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return packageJson.version;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  if (command === "init") {
    const result = initBuildchainRepo({
      cwd: readFlag(args, "cwd", process.cwd()),
      type: readFlag(args, "type", "package"),
      force: readBooleanFlag(args, "force"),
      packageManager: readFlag(args, "package-manager", ""),
      runnerPreset: readFlag(args, "runner-preset", "github-hosted"),
      artifactName: readFlag(args, "artifact-name", "{repo}-{version}-{platform}"),
    });
    printJson(result);
    return;
  }

  if (command === "validate") {
    const lifecycleStages = readFlag(args, "require-lifecycle-stages", "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    printJson(validateBuildchainConfig(readFlag(args, "cwd", process.cwd()), {
      requireVersionState: readBooleanFlag(args, "require-version-state"),
      requireLifecycleStages: lifecycleStages,
    }));
    return;
  }

  if (command === "lifecycle") {
    const [subcommand, stageName = "", ...lifecycleArgs] = args;
    if (subcommand !== "run" || !stageName) {
      throw new Error("usage: buildchain lifecycle run <stage>");
    }
    const artifactPaths = readRepeatedFlag(lifecycleArgs, "artifact-path");
    const manifest = runLifecycle({
      cwd: readFlag(lifecycleArgs, "cwd", process.cwd()),
      stageName,
      required: readBooleanFlag(lifecycleArgs, "required"),
      artifactName: readFlag(lifecycleArgs, "artifact-name", "buildchain-artifact"),
      artifactPaths,
      expectedArtifactsJson: readFlag(lifecycleArgs, "expected-artifacts-json", ""),
      workspace: process.cwd(),
    });
    printJson(manifest);
    return;
  }

  if (command === "release") {
    runScript("release-transaction.mjs", args);
    return;
  }

  if (command === "web-surface") {
    runScript("web-surface.mjs", args);
    return;
  }

  if (command === "build-contract") {
    runScript("resolve-build-contract.mjs", args);
    return;
  }

  if (command === "publish-source") {
    const [mode = "lock", ...publishArgs] = args;
    if (mode === "lock" || mode === "manifest") {
      runScript("resolve-publish-source.mjs", ["--mode", mode, ...publishArgs]);
      return;
    }
    if (mode === "verify-lock") {
      runScript("verify-publish-source-lock.mjs", publishArgs);
      return;
    }
    throw new Error(`unsupported publish-source command: ${mode}`);
  }

  throw new Error(`unsupported buildchain command: ${command}`);
}

main().catch((error) => {
  console.error(`buildchain: ${error.message}`);
  process.exitCode = 1;
});

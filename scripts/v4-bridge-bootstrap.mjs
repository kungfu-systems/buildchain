#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(
  root,
  "crates",
  "buildchain-v4-bridge",
  "Cargo.toml",
);

function bridgeBinary(profile = "debug", platform = process.platform) {
  return path.join(
    root,
    "crates",
    "buildchain-v4-bridge",
    "target",
    profile,
    `buildchain-v4-bridge${platform === "win32" ? ".exe" : ""}`,
  );
}

function createV4HostRequest({
  command,
  args = [],
  input = Buffer.alloc(0),
  requiredCapabilities = ["canonical-input-v1", "exit-semantics-v1"],
  timeoutMs = 5000,
  requestId = crypto.randomUUID(),
} = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-host-request",
    protocolVersion: "1.0",
    requestId,
    command: { id: command, arguments: args },
    input: { encoding: "base64", bytes: Buffer.from(input).toString("base64") },
    requiredCapabilities,
    timeoutMs,
  };
}

function buildV4Bridge({ release = false } = {}) {
  return spawnSync(
    "cargo",
    [
      "build",
      "--locked",
      "--manifest-path",
      manifestPath,
      ...(release ? ["--release"] : []),
    ],
    { cwd: root, encoding: "utf8" },
  );
}

function runV4Bridge(
  request,
  { mode = "exchange", profile = "debug", env = {}, encoding = null } = {},
) {
  const binary = bridgeBinary(profile);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `Buildchain v4 bridge is not built: ${path.relative(root, binary)}; run pnpm bridge:v4:build`,
    );
  }
  return spawnSync(binary, [mode], {
    cwd: root,
    env: {
      ...process.env,
      BUILDCHAIN_V4_HOST_COMMAND: process.execPath,
      BUILDCHAIN_V4_HOST_SCRIPT: path.join(
        root,
        "scripts",
        "v4-host-adapter.mjs",
      ),
      ...env,
    },
    input: JSON.stringify(request),
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseRunArgs(args) {
  const separator = args.indexOf("--");
  const bridgeArgs = separator === -1 ? args : args.slice(0, separator);
  const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
  const command = bridgeArgs[0];
  if (!command) {
    throw new Error(
      "usage: node scripts/v4-bridge-bootstrap.mjs <run|exchange> <command-id> -- [command-args...]",
    );
  }
  return { command, commandArgs };
}

function main(args = process.argv.slice(2)) {
  const [mode = "", ...rest] = args;
  if (mode === "build") {
    const result = buildV4Bridge({ release: rest.includes("--release") });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exitCode = result.status ?? 1;
    return;
  }
  if (!["run", "exchange"].includes(mode)) {
    throw new Error(
      "usage: node scripts/v4-bridge-bootstrap.mjs <build|run|exchange> ...",
    );
  }
  const { command, commandArgs } = parseRunArgs(rest);
  const input = fs.readFileSync(0);
  const request = createV4HostRequest({ command, args: commandArgs, input });
  const result = runV4Bridge(request, {
    mode: mode === "run" ? "compat" : "exchange",
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout || Buffer.alloc(0));
  process.stderr.write(result.stderr || Buffer.alloc(0));
  process.exitCode = result.status ?? 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`buildchain v4 bridge bootstrap: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { bridgeBinary, buildV4Bridge, createV4HostRequest, main, runV4Bridge };

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBuildchainLogger } from "../packages/core/logging.js";

function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
}

function timed(logger, eventName, details, callback) {
  const spanId = crypto.randomUUID();
  const startedAt = Date.now();
  logger.info(`${eventName}.start`, { ...details, spanId });
  try {
    const result = callback();
    logger.info(`${eventName}.end`, {
      ...details,
      spanId,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logger.error(`${eventName}.error`, {
      ...details,
      spanId,
      durationMs: Date.now() - startedAt,
      message: error.message,
      attributes: {
        ...(details.attributes || {}),
        errorName: error.name,
      },
    });
    throw error;
  }
}

const WINDOWS_CMD_SHIMS = new Set(["corepack", "npm", "npx", "pnpm", "yarn"]);

export function resolveSpawnCommand(command, platform = process.platform) {
  if (platform !== "win32") {
    return command;
  }
  if (!WINDOWS_CMD_SHIMS.has(command)) {
    return command;
  }
  return `${command}.cmd`;
}

export function usesShellForSpawnCommand(command, platform = process.platform) {
  return platform === "win32" && WINDOWS_CMD_SHIMS.has(command);
}

function run(command, args, options = {}) {
  const { logger, event = "process.run", phase = "process", attributes = {}, ...spawnOptions } = options;
  const resolvedCommand = resolveSpawnCommand(command);
  const shell = spawnOptions.shell ?? usesShellForSpawnCommand(command);
  const runCommand = () => {
    const result = spawnSync(resolvedCommand, args, {
      stdio: "inherit",
      ...spawnOptions,
      shell,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
    }
  };
  if (logger) {
    return timed(logger, event, {
      phase,
      attributes: {
        command,
        resolvedCommand,
        args: args.join(" "),
        ...attributes,
      },
    }, runCommand);
  }
  return runCommand();
}

function relativePath(cwd, targetPath) {
  return path.relative(cwd, targetPath).split(path.sep).join("/");
}

function writeLogSummary(logger, cwd, outputDir, archiveBase) {
  if (!logger.path) {
    return "";
  }
  const summaryPath = path.join(outputDir, `${archiveBase}.log-summary.json`);
  const summary = logger.summary();
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return relativePath(cwd, summaryPath);
}

function readLogPath(value) {
  if (value === false || value === "false") {
    return false;
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return undefined;
}

function noopLogger() {
  return {
    path: "",
    info: () => undefined,
    error: () => undefined,
    summary: () => ({
      schemaVersion: 1,
      contract: "kungfu-buildchain-log-summary",
      eventCount: 0,
      warningCount: 0,
      errorCount: 0,
      durationMs: 0,
      sources: {},
      phases: {},
      components: {},
    }),
  };
}

function platformTriple() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  return `${arch}-${platform}`;
}

function copyNodeBinary(destination) {
  fs.copyFileSync(process.execPath, destination);
  if (process.platform !== "win32") {
    fs.chmodSync(destination, 0o755);
  }
}

function packageVersion(cwd) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  return packageJson.version;
}

function bundleCli({ cwd, tempDir, version, logger }) {
  const outDir = path.join(tempDir, "bundle");
  const configPath = path.join(tempDir, "tsup.config.mjs");
  const kfdAgentRuntimeVerifierWasmBase64 = fs
    .readFileSync(
      fileURLToPath(
        import.meta.resolve("@kungfu-tech/kfd-agent-runtime/verifier/wasm"),
      ),
    )
    .toString("base64");
  fs.writeFileSync(configPath, `export default {
  entry: {
    buildchain: ${JSON.stringify(path.join(cwd, "bin", "buildchain.mjs"))},
  },
  format: ["cjs"],
  platform: "node",
  target: "node24",
  outDir: ${JSON.stringify(outDir)},
  clean: true,
  silent: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: true,
  noExternal: ["ajv", /^ajv\\//, "smol-toml", /^@kungfu-tech\\/kfd(?:-|\\/|$)/],
  define: {
    "process.env.BUILDCHAIN_EMBEDDED_PACKAGE_VERSION": ${JSON.stringify(JSON.stringify(version || packageVersion(cwd)))},
    "process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT": ${JSON.stringify(JSON.stringify("1"))},
    "__BUILDCHAIN_EMBEDDED_KFD_AGENT_RUNTIME_WASM_BASE64__": ${JSON.stringify(JSON.stringify(kfdAgentRuntimeVerifierWasmBase64))},
  },
};
`);
  run("pnpm", ["exec", "tsup", "--config", configPath], {
    cwd,
    logger,
    event: "standalone.cli-bundle.create",
    phase: "prepare",
    attributes: {
      outDir,
    },
  });
  return path.join(outDir, "buildchain.cjs");
}

function postjectArgs(binaryPath, blobPath) {
  const args = [
    "--yes",
    "postject",
    binaryPath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ];
  if (process.platform === "darwin") {
    args.push("--macho-segment-name", "NODE_SEA");
  }
  return args;
}

export function buildStandaloneBinary({
  cwd = process.cwd(),
  outputDir = "dist/binary",
  name = "buildchain",
  version = "",
  packageManagerInstall = false,
  logPath = undefined,
} = {}) {
  const resolvedOutputDir = path.resolve(cwd, outputDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-sea-"));
  const triple = platformTriple();
  const archiveBase = `${name}-${triple}`;
  const logger = createBuildchainLogger({
    cwd,
    path: readLogPath(logPath),
    source: "buildchain",
    component: "standalone-binary",
    phase: "binary",
    attributes: {
      name,
      version,
      platform: triple,
      outputDir: relativePath(cwd, resolvedOutputDir),
    },
  }) || noopLogger();
  logger.info("standalone.build.requested", {
    attributes: {
      packageManagerInstall,
      node: process.version,
    },
  });
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  if (packageManagerInstall) {
    run("pnpm", ["install", "--frozen-lockfile"], {
      cwd,
      logger,
      event: "standalone.dependencies.install",
      phase: "setup",
    });
  }
  const blobPath = path.join(tempDir, "sea-prep.blob");
  const configPath = path.join(tempDir, "sea-config.json");
  const bundledCliPath = bundleCli({
    cwd,
    tempDir,
    version,
    logger,
  });
  timed(logger, "standalone.sea-config.write", {
    phase: "prepare",
    attributes: {
      configPath,
      blobPath,
      bundledCliPath,
    },
  }, () => {
    fs.writeFileSync(configPath, `${JSON.stringify({
      main: bundledCliPath,
      mainFormat: "commonjs",
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }, null, 2)}\n`);
  });
  run(process.execPath, ["--experimental-sea-config", configPath], {
    cwd,
    logger,
    event: "standalone.sea-blob.create",
    phase: "prepare",
  });
  const extension = process.platform === "win32" ? ".exe" : "";
  const binaryPath = path.join(resolvedOutputDir, `${name}${extension}`);
  timed(logger, "standalone.node.copy", {
    phase: "prepare",
    attributes: {
      source: process.execPath,
      destination: relativePath(cwd, binaryPath),
    },
  }, () => copyNodeBinary(binaryPath));
  if (process.platform === "darwin") {
    timed(logger, "standalone.codesign.remove", {
      phase: "sign",
      attributes: {
        binary: relativePath(cwd, binaryPath),
      },
    }, () => {
      spawnSync("codesign", ["--remove-signature", binaryPath], { stdio: "ignore" });
    });
  }
  run("npx", postjectArgs(binaryPath, blobPath), {
    cwd,
    logger,
    event: "standalone.sea-blob.inject",
    phase: "package",
  });
  if (process.platform === "darwin") {
    run("codesign", ["--sign", "-", binaryPath], {
      logger,
      event: "standalone.codesign.adhoc",
      phase: "sign",
    });
  }
  const archiveName = process.platform === "win32" ? `${archiveBase}.zip` : `${archiveBase}.tar.gz`;
  const archivePath = path.join(resolvedOutputDir, archiveName);
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${binaryPath.replaceAll("'", "''")}' -DestinationPath '${archivePath.replaceAll("'", "''")}' -Force`,
    ], {
      logger,
      event: "standalone.archive.create",
      phase: "archive",
    });
  } else {
    run("tar", ["-czf", archivePath, "-C", resolvedOutputDir, path.basename(binaryPath)], {
      logger,
      event: "standalone.archive.create",
      phase: "archive",
    });
  }
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-standalone-binary",
    name,
    version,
    platform: triple,
    binary: relativePath(cwd, binaryPath),
    archive: relativePath(cwd, archivePath),
    node: process.version,
    observability: {
      eventLog: logger.path ? relativePath(cwd, logger.path) : "",
      summary: logger.path ? relativePath(cwd, path.join(resolvedOutputDir, `${archiveBase}.log-summary.json`)) : "",
    },
  };
  timed(logger, "standalone.manifest.write", {
    phase: "evidence",
    attributes: {
      manifest: `${archiveBase}.json`,
    },
  }, () => {
    fs.writeFileSync(path.join(resolvedOutputDir, `${archiveBase}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  });
  logger.info("standalone.build.complete", {
    attributes: {
      archive: manifest.archive,
      binary: manifest.binary,
    },
  });
  writeLogSummary(logger, cwd, resolvedOutputDir, archiveBase);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = buildStandaloneBinary({
      cwd: path.resolve(readArg("cwd", process.cwd())),
      outputDir: readArg("output-dir", "dist/binary"),
      name: readArg("name", "buildchain"),
      version: readArg("version", ""),
      packageManagerInstall: process.argv.includes("--install"),
      logPath: readArg("log-path", ""),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`buildchain binary: ${error.message}`);
    process.exitCode = 1;
  }
}

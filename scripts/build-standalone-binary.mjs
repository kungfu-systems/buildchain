#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildStandaloneBinary } from "../packages/core/build/standalone/build.js";
function readArg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return process.argv[index + 1] || "";
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

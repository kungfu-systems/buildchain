#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { writePublicationArtifact } from "../packages/core/publication-artifact.js";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readBooleanFlag(args, name) {
  return args.includes(`--${name}`);
}

function readRegistryInputs(args, cwd) {
  const inputs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--registry-input" && args[index + 1]) inputs.push(args[index + 1]);
  }
  const inputDir = readFlag(args, "registry-input-dir", "");
  if (inputDir) {
    const resolved = path.resolve(cwd, inputDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`publication registry input directory is missing: ${inputDir}`);
    inputs.push(...fs.readdirSync(resolved).filter((entry) => entry.endsWith(".json")).sort().map((entry) => path.join(resolved, entry)));
  }
  return inputs;
}

export function runPublicationArtifactCli(args = process.argv.slice(2)) {
  const [mode = "manifest"] = args;
  if (!["manifest", "collect"].includes(mode)) {
    throw new Error("usage: buildchain publication-artifact manifest [--cwd <dir>] [--source-sha <sha>] [--output <file>] [--passport-output <file>] [--registry-output <file>] [--registry-input <file>] [--registry-input-dir <dir>] [--source-bundle <file>] [--no-source-bundle] [--json]");
  }
  const cwd = readFlag(args, "cwd", process.cwd());
  const result = writePublicationArtifact({
    cwd,
    output: readFlag(args, "output", ""),
    passportOutput: readFlag(args, "passport-output", ""),
    registryOutput: readFlag(args, "registry-output", ""),
    registryInputs: readRegistryInputs(args, cwd),
    sourceSha: readFlag(args, "source-sha", ""),
    sourceBundlePath: readFlag(args, "source-bundle", ""),
    sourceBundle: !readBooleanFlag(args, "no-source-bundle"),
    generatedAt: readFlag(args, "generated-at", ""),
  });
  if (readBooleanFlag(args, "json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`publication-manifest=${result.manifestPath}\n`);
    process.stdout.write(`publication-passport=${result.passportPath}\n`);
    if (result.registryPath) {
      process.stdout.write(`publication-registry=${result.registryPath}\n`);
    }
    process.stdout.write(`publication-primary-artifact=${result.manifest.publication.primaryArtifact}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPublicationArtifactCli();
  } catch (error) {
    console.error(`publication-artifact: ${error.message}`);
    process.exitCode = 1;
  }
}

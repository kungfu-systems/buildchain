#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { writePublicationArtifact } from "../packages/core/publication-artifact.js";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function readBooleanFlag(args, name) {
  return args.includes(`--${name}`);
}

export function runPublicationArtifactCli(args = process.argv.slice(2)) {
  const [mode = "manifest"] = args;
  if (!["manifest", "collect"].includes(mode)) {
    throw new Error("usage: buildchain publication-artifact manifest [--cwd <dir>] [--source-sha <sha>] [--output <file>] [--passport-output <file>] [--source-bundle <file>] [--no-source-bundle] [--json]");
  }
  const result = writePublicationArtifact({
    cwd: readFlag(args, "cwd", process.cwd()),
    output: readFlag(args, "output", ""),
    passportOutput: readFlag(args, "passport-output", ""),
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

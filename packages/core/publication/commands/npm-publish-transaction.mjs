#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { npmPublishTransaction } from "../npm/transaction.js";
import { npmPublicationEnvironment } from "../npm/environment.js";
function readArg(argv, name, fallback = "") {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return argv[index + 1] || "";
}

function hasFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function writeGitHubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  fs.appendFileSync(outputPath, Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
    .join("\n") + "\n");
}

function usage() {
  return `Usage:
  node packages/core/publication/commands/npm-publish-transaction.mjs [--cwd <dir>] [--registry <url>]
                                           [--dry-run-publish] [--skip-registry-lookup]
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, "help") || argv.includes("-h")) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = npmPublishTransaction({
      publication: npmPublicationEnvironment(process.env), env: process.env,
      cwd: readArg(argv, "cwd", process.cwd()),
      registry: readArg(argv, "registry", "https://registry.npmjs.org/"),
      dryRunPublish: hasFlag(argv, "dry-run-publish"),
      skipRegistryLookup: hasFlag(argv, "skip-registry-lookup"),
    });
    writeGitHubOutputs({ version: result.package.version, "exact-tag": result.exactTag, "dist-tag": result.distTag, "artifact-digest": result.evidence.artifacts[0].digest, "publish-action": result.publishAction, "publish-evidence": result.evidencePath });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`npm-publish-transaction: ${error.message}`);
    process.exitCode = 1;
  }
}

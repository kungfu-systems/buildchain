#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { npmPublishDryRun } from "../npm/preview.js";
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

function usage() {
  return `Usage:
  node packages/core/publication/commands/npm-publish-dry-run.mjs [--cwd <dir>] [--expected-tag <tag>]
                                      [--registry <url>] [--dist-tag <tag>]
                                      [--skip-npm-publish-dry-run] [--json]
`;
}

if (!process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv = process.argv.slice(2);
    if (hasFlag(argv, "help") || hasFlag(argv, "h")) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = npmPublishDryRun({
      cwd: readArg(argv, "cwd", process.cwd()),
      expectedTag: readArg(argv, "expected-tag", ""),
      registry: readArg(argv, "registry", "https://registry.npmjs.org/"),
      distTag: readArg(argv, "dist-tag", ""),
      skipNpmPublishDryRun: hasFlag(argv, "skip-npm-publish-dry-run"),
    });
    if (hasFlag(argv, "json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`npm publish dry-run ok: ${result.package.name}@${result.package.version} -> ${result.distTag}\n`);
      process.stdout.write(`pack entries: ${result.pack.entryCount}\n`);
    }
  } catch (error) {
    console.error(`npm-publish-dry-run: ${error.message}`);
    process.exitCode = 1;
  }
}

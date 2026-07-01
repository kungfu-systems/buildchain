#!/usr/bin/env node
import {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} from "../packages/core/release-line-dry-run.js";

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  return args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function usage() {
  return `Usage:
  node scripts/release-line-dry-run.mjs --target-ref <ref> [--cwd <dir>]
                                        [--sha <sha>] [--source-ref <ref>]
                                        [--tags <comma-list>] [--json]
`;
}

function main(argv = process.argv.slice(2)) {
  if (hasFlag(argv, "help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const plan = explainReleaseLineDryRun({
    cwd: readFlag(argv, "cwd", process.cwd()),
    targetRef: readFlag(argv, "target-ref", ""),
    sourceRef: readFlag(argv, "source-ref", ""),
    sha: readFlag(argv, "sha", ""),
    tags: readFlag(argv, "tags", ""),
    publishTransaction: hasFlag(argv, "publish-transaction"),
    publishCommand: readFlag(argv, "publish-command", ""),
  });
  if (hasFlag(argv, "json")) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    process.stdout.write(formatReleaseLineDryRun(plan));
  }
}

try {
  main();
} catch (error) {
  console.error(`release-line-dry-run: ${error.message}`);
  process.exitCode = 1;
}

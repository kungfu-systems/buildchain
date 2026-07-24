#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  planReleasePropagation,
  readReleasePropagationJson,
  writeReleasePropagationLock,
} from "../packages/core/release-propagation.js";

function usage() {
  return `Usage:
  buildchain release-propagation plan --graph <json-or-path>
                                      --upstream-release <json-or-path>
                                      [--source-node <id>] [--output <file>] [--json]
  buildchain release-propagation write-lock --plan <json-or-path>
                                            [--target <id-or-repo>] [--cwd <dir>]
                                            [--output <file>] [--json]
`;
}

function readFlag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeOutput(filePath, value) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function runReleasePropagationCli(argv = process.argv.slice(2)) {
  const [mode = "", ...args] = argv;
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (mode === "plan") {
    const graph = readReleasePropagationJson(readFlag(args, "graph"), {
      label: "--graph",
      cwd: process.cwd(),
    });
    const upstreamRelease = readReleasePropagationJson(readFlag(args, "upstream-release"), {
      label: "--upstream-release",
      cwd: process.cwd(),
    });
    const plan = planReleasePropagation({
      graph,
      upstreamRelease,
      sourceNode: readFlag(args, "source-node", ""),
    });
    writeOutput(readFlag(args, "output", ""), plan);
    if (hasFlag(args, "json")) {
      printJson(plan);
    } else {
      process.stdout.write(`release propagation targets: ${plan.summary.targetCount}\n`);
      for (const target of plan.targets) {
        process.stdout.write(`- ${target.repository} ${target.channel} lock=${target.lockPath}\n`);
      }
    }
    return;
  }
  if (mode === "write-lock") {
    const plan = readReleasePropagationJson(readFlag(args, "plan"), {
      label: "--plan",
      cwd: process.cwd(),
    });
    const result = writeReleasePropagationLock({
      plan,
      target: readFlag(args, "target", ""),
      cwd: readFlag(args, "cwd", process.cwd()),
      output: readFlag(args, "output", ""),
    });
    if (hasFlag(args, "json")) {
      printJson(result);
    } else {
      process.stdout.write(`release propagation lock: ${result.path}\n`);
      process.stdout.write(`lock sha256: ${result.lockSha256}\n`);
    }
    return;
  }
  throw new Error(`unsupported release-propagation command: ${mode}`);
}

if (!process.env.BUILDCHAIN_EMBEDDED_ENTRYPOINT && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleasePropagationCli();
}

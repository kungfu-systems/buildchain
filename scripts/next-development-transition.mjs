#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { materializeNextDevelopmentTransition } from "../packages/core/next-development-transition.js";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : String(args[index + 1] || "");
}

function usage() {
  return `usage: node scripts/next-development-transition.mjs materialize --input <request.json> [--cwd <checkout>] [--write]\n`;
}

export function runNextDevelopmentAdapter(args = process.argv.slice(2)) {
  const [command] = args;
  if (command !== "materialize") throw new Error(usage().trim());
  const inputPath = flag(args, "input");
  if (!inputPath)
    throw new Error(
      "next-development materialize requires --input <request.json>",
    );
  const cwd = path.resolve(flag(args, "cwd", process.cwd()));
  const request = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
  return materializeNextDevelopmentTransition({
    cwd,
    request,
    write: args.includes("--write"),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(runNextDevelopmentAdapter(), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`next-development transition: ${error.message}\n`);
    process.exitCode = 1;
  }
}

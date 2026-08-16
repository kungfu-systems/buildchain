#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { nextDevelopmentManual } from "../packages/core/next-development-projection.js";

export const NEXT_DEVELOPMENT_MANUAL_PATH =
  "docs/next-development-transition.md";

export function generateNextDevelopmentGuidance({
  cwd = process.cwd(),
  check = false,
} = {}) {
  const target = path.resolve(cwd, NEXT_DEVELOPMENT_MANUAL_PATH);
  const expected = nextDevelopmentManual();
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (check) {
    if (current !== expected) {
      throw new Error(
        `${NEXT_DEVELOPMENT_MANUAL_PATH} drifted from its contract source`,
      );
    }
    return { ok: true, changed: false, path: NEXT_DEVELOPMENT_MANUAL_PATH };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (current !== expected) fs.writeFileSync(target, expected);
  return {
    ok: true,
    changed: current !== expected,
    path: NEXT_DEVELOPMENT_MANUAL_PATH,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = generateNextDevelopmentGuidance({
      check: process.argv.includes("--check"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`next-development guidance: ${error.message}\n`);
    process.exitCode = 1;
  }
}

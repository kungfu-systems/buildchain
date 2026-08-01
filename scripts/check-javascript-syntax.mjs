#!/usr/bin/env node

import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = process.cwd();
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter((file) => [".js", ".mjs", ".cjs"].includes(path.extname(file)))
  .filter((file) => !/^actions\/[^/]+\/dist\//u.test(file))
  .sort();

const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failures.push(`${file}: ${(result.stderr || result.stdout).trim()}`);
  }
}

if (failures.length > 0) {
  throw new Error(`JavaScript syntax check failed:\n${failures.join("\n")}`);
}
console.log(`JavaScript syntax check passed: ${files.length} files`);

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUILDCHAIN_USAGE } from "./buildchain-cli-help.mjs";
import {
  createCliReference,
  createNodeApiReference,
  renderCliReference,
  renderNodeApiReference,
} from "./public-reference.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function publicReferenceOutputs({ repoRoot = root } = {}) {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  return {
    "docs/cli-reference.md": renderCliReference(
      createCliReference(BUILDCHAIN_USAGE),
    ),
    "docs/node-api-reference.md": renderNodeApiReference(
      createNodeApiReference({ root: repoRoot, packageJson }),
    ),
  };
}

export function generatePublicReference({
  check = false,
  repoRoot = root,
} = {}) {
  const outputs = publicReferenceOutputs({ repoRoot });
  const stale = [];
  for (const [relPath, content] of Object.entries(outputs)) {
    const filePath = path.join(repoRoot, relPath);
    const current = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, "utf8")
      : "";
    if (current !== content) {
      if (check) stale.push(relPath);
      else fs.writeFileSync(filePath, content);
    }
  }
  if (stale.length > 0) {
    throw new Error(`public reference is stale: ${stale.join(", ")}`);
  }
  return {
    contract: "kungfu-buildchain-public-reference-generation/v1",
    check,
    files: Object.keys(outputs),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      `${JSON.stringify(generatePublicReference({ check: process.argv.includes("--check") }), null, 2)}\n`,
    );
  } catch (error) {
    console.error(`buildchain public reference: ${error.message}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeGitHubOutputs } from "./build-contract-core.mjs";

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function safeId(value) {
  const normalized = String(value || "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") throw new Error("unsafe signing result id");
  return normalized;
}

function walk(root, output = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) walk(child, output);
    else if (entry.isFile() && entry.name === "index.json") output.push(child);
  }
  return output;
}

export function mergeArtifactSigningResults({
  inputRoot = process.env.BUILDCHAIN_SIGNING_RESULT_INPUT_ROOT,
  outputRoot = process.env.BUILDCHAIN_SIGNING_RESULT_ROOT,
} = {}) {
  const input = path.resolve(required(inputRoot, "signing result input root"));
  const output = path.resolve(required(outputRoot, "signing result output root"));
  fs.mkdirSync(output, { recursive: true });
  const merged = [];
  const seen = new Set();
  for (const indexPath of walk(input)) {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (index.contract !== "kungfu-buildchain-artifact-signing-result-index/v1") continue;
    for (const entry of index.results || []) {
      if (seen.has(entry.id)) throw new Error(`duplicate signing result: ${entry.id}`);
      seen.add(entry.id);
      const sourceResult = path.resolve(path.dirname(indexPath), entry.result);
      const sourceDirectory = path.dirname(sourceResult);
      const relative = path.relative(path.dirname(indexPath), sourceDirectory);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("signing result escapes provider root");
      const destinationName = safeId(entry.id);
      const destination = path.join(output, destinationName);
      fs.cpSync(sourceDirectory, destination, { recursive: true, errorOnExist: true, force: false });
      merged.push({
        ...entry,
        result: `${destinationName}/${path.basename(sourceResult)}`,
        ...(entry.payload ? { payload: `${destinationName}/${path.relative(sourceDirectory, path.resolve(path.dirname(indexPath), entry.payload)).split(path.sep).join("/")}` } : {}),
        ...(entry.envelope ? { envelope: `${destinationName}/${path.relative(sourceDirectory, path.resolve(path.dirname(indexPath), entry.envelope)).split(path.sep).join("/")}` } : {}),
        ...(entry.receipt ? { receipt: `${destinationName}/${path.relative(sourceDirectory, path.resolve(path.dirname(indexPath), entry.receipt)).split(path.sep).join("/")}` } : {}),
      });
    }
  }
  if (merged.length === 0) throw new Error("no artifact signing results found");
  merged.sort((a, b) => a.id.localeCompare(b.id));
  const index = { schemaVersion: 1, contract: "kungfu-buildchain-artifact-signing-result-index/v1", results: merged };
  const indexPath = path.join(output, "index.json");
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  writeGitHubOutputs({ "result-count": String(merged.length), "result-index": indexPath, "result-root": output });
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    mergeArtifactSigningResults();
  } catch (error) {
    console.error(`::error::${String(error?.message || error).replace(/\r?\n/gu, "%0A")}`);
    process.exitCode = 1;
  }
}

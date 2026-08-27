import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRepoText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertOccurrences(source, pattern, count, message) {
  assert.equal((source.match(pattern) || []).length, count, message);
}

export { assert, assertOccurrences, fs, path, readRepoText, root, test };

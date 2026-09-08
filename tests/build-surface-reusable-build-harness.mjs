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

function workflowJob(name) {
  const source = readRepoText(".github/workflows/.build.yml");
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `Missing job ${name}`);
  const tail = source.slice(start + 1);
  const next = tail.slice(1).search(/^  [a-z0-9-]+:\n/mu);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function readComposite(name) {
  return readRepoText(`actions/${name}/action.yml`);
}

function assertOrder(source, names) {
  let previous = -1;
  for (const name of names) {
    const position = source.indexOf(name, previous + 1);
    assert.ok(position > previous, `Missing or misordered ${name}`);
    previous = position;
  }
}

export { assert, assertOccurrences, assertOrder, fs, path, readComposite, readRepoText, root, test, workflowJob };

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { gitPatchRoot } from "../packages/core/providers/git/patch-root.js";

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-patch-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(cwd, "base"), "base\n");
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  return { cwd, commit, base: commit() };
}

async function streamedPatch(cwd, base, head) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const child = spawn(
    "git",
    ["diff", "--binary", "--full-index", "--no-ext-diff", `${base}..${head}`],
    { cwd },
  );
  child.stdout.on("data", (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  const status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(status, 0);
  return { bytes, root: `sha256:${hash.digest("hex")}` };
}

test("patch roots conserve exact binary bytes and reject missing commits", async (t) => {
  const f = repository(t);
  fs.writeFileSync(
    path.join(f.cwd, "binary"),
    Buffer.from([0, 255, 128, 13, 10]),
  );
  const head = f.commit();
  const expected = await streamedPatch(f.cwd, f.base, head);
  assert.equal(gitPatchRoot({ cwd: f.cwd, base: f.base, head }), expected.root);
  assert.equal(
    gitPatchRoot({ cwd: f.cwd, base: f.base, head, mergeBase: true }),
    expected.root,
  );
  assert.throws(
    () => gitPatchRoot({ cwd: f.cwd, base: "a".repeat(40), head }),
    /Git patch read failed/,
  );
});

test("patch roots support real diffs exceeding the former 64 MiB output ceiling", async (t) => {
  const f = repository(t);
  const chunk = Buffer.from(`${"x".repeat(1023)}\n`.repeat(1024));
  for (let index = 0; index < 65; index++)
    fs.appendFileSync(path.join(f.cwd, "large"), chunk);
  const head = f.commit();
  const expected = await streamedPatch(f.cwd, f.base, head);
  assert.ok(expected.bytes > 64 * 1024 * 1024);
  assert.equal(gitPatchRoot({ cwd: f.cwd, base: f.base, head }), expected.root);
});

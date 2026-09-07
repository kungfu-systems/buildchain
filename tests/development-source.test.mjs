import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareDevelopmentSource } from "../actions/release-candidate-promote/development-source.js";

test("development snapshot uses the exact protected commit instead of stale publication or dirty local files", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-source-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  fs.writeFileSync(path.join(cwd, "source.txt"), "protected development\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "source",
  );
  git("remote", "add", "origin", cwd);
  const sourceSha = git("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(cwd, "source.txt"),
    "stale or dirty publication\n",
  );
  const snapshot = prepareDevelopmentSource({ cwd, sourceSha });
  assert.equal(
    fs.readFileSync(path.join(snapshot.cwd, "source.txt"), "utf8"),
    "protected development\n",
  );
  snapshot.dispose();
  assert.equal(fs.existsSync(snapshot.cwd), false);
  assert.equal(
    fs.readFileSync(path.join(cwd, "source.txt"), "utf8"),
    "stale or dirty publication\n",
  );
  assert.throws(
    () => prepareDevelopmentSource({ cwd, sourceSha: "HEAD" }),
    /exact commit/u,
  );
});

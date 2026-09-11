import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { prepareDevelopmentSource } from "../packages/core/release/promote-candidate/development-source.js";
import { localVersionFiles } from "../packages/core/release/promote-candidate/product-provider-adapters.js";

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

for (const shallow of [false, true]) test(`protected snapshot supports real version generation and rejects unrelated writes (shallow=${shallow})`, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-generator-test-"));
  let cwd = path.join(root, "origin");
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  for (const directory of [".buildchain", "dist/site", "scripts", "node_modules"])
    fs.mkdirSync(path.join(cwd, directory), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(cwd, "source.txt"), "protected source\n");
  fs.writeFileSync(path.join(cwd, "package.json"), '{"version":"4.0.3-alpha.1"}\n');
  fs.writeFileSync(path.join(cwd, "dist/site/kfd-claims.json"), '{"version":"4.0.3-alpha.1"}\n');
  fs.writeFileSync(path.join(cwd, ".buildchain/buildchain.toml"), `schema = 1
[version]
required = true
derived_files = ["dist/site/kfd-claims.json"]
[[version.files]]
type = "json"
path = "package.json"
key = "version"
[lifecycle.version-state]
command = "node scripts/generate.mjs"
[lifecycle.verify]
command = "node --version"
`);
  fs.writeFileSync(path.join(cwd, "scripts/generate.mjs"), `import fs from "node:fs";
fs.writeFileSync("dist/site/kfd-claims.json", JSON.stringify({version: process.env.BUILDCHAIN_VERSION}) + "\\n");
if (fs.existsSync(".buildchain/reconciliation/reject-unrelated")) fs.writeFileSync("source.txt", "unexpected change\\n");
`);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "source");
  git("remote", "add", "origin", cwd);
  git("branch", "alpha");
  fs.writeFileSync(path.join(cwd, "source.txt"), "new protected source\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "new development");
  const sourceSha = git("rev-parse", "HEAD");
  if (shallow) {
    const caller = path.join(root, "caller");
    git("clone", "--depth", "1", "--single-branch", "--branch", "alpha", `file://${cwd}`, caller);
    cwd = caller;
    git("checkout", "--detach");
    fs.mkdirSync(path.join(cwd, "node_modules"));
    assert.equal(git("rev-parse", "--is-shallow-repository"), "true");
    assert.notEqual(git("rev-parse", "HEAD"), sourceSha);
  }
  const callerHead = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "source.txt"), "caller dirty work\n");
  const before = git("status", "--porcelain", "--untracked-files=all");
  const snapshot = prepareDevelopmentSource({ cwd, sourceSha });
  t.after(snapshot.dispose);
  assert.equal(fs.readFileSync(path.join(snapshot.cwd, "source.txt"), "utf8"), "new protected source\n");
  const intent = { channel: "alpha", version: "4.0.4-alpha.0", sourceSha, sourceTimestamp: "2026-09-07T15:01:00.000Z" };
  const files = localVersionFiles(snapshot.cwd, intent);
  assert.deepEqual(files.map(({ path: file }) => file), ["dist/site/kfd-claims.json", "package.json"]);
  for (const file of files) assert.equal(JSON.parse(file.content).version, intent.version);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: snapshot.cwd, encoding: "utf8" }).trim(), sourceSha);
  assert.equal(JSON.parse(fs.readFileSync(path.join(snapshot.cwd, "package.json"))).version, "4.0.3-alpha.1");
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), before);
  assert.equal(git("rev-parse", "HEAD"), callerHead);
  assert.equal(fs.existsSync(path.join(snapshot.cwd, ".buildchain/runtime")), false);
  assert.equal(fs.lstatSync(path.join(snapshot.cwd, "node_modules")).isSymbolicLink(), false);
  fs.mkdirSync(path.join(snapshot.cwd, ".buildchain/reconciliation"), { recursive: true });
  fs.writeFileSync(path.join(snapshot.cwd, ".buildchain/reconciliation/reject-unrelated"), "");
  assert.throws(() => localVersionFiles(snapshot.cwd, intent), /Unexpected version changes:.*source\.txt/u);
  assert.equal(fs.readFileSync(path.join(cwd, "source.txt"), "utf8"), "caller dirty work\n");
});

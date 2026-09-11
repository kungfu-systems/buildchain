import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { localVersionFiles } from "../packages/core/release/promote-candidate/product-provider-adapters.js";

function fixture(t, { failInstall = false, generator = true } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "version-generator-deps-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const directory of [".buildchain", "scripts", "dist/site"])
    fs.mkdirSync(path.join(cwd, directory), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(cwd, "package.json"), '{"version":"4.1.0-alpha.1"}\n');
  fs.writeFileSync(path.join(cwd, "dist/site/kfd-claims.json"), '{"version":"4.1.0-alpha.1"}\n');
  fs.writeFileSync(path.join(cwd, ".buildchain/buildchain.toml"), `schema = 1
[version]
required = true
${generator ? 'derived_files = ["dist/site/kfd-claims.json"]' : ""}
[[version.files]]
type = "json"
path = "package.json"
key = "version"
[lifecycle.install]
command = "node scripts/install.mjs"
${generator ? '[lifecycle.version-state]\ncommand = "node scripts/generate.mjs"' : ""}
[lifecycle.verify]
command = "node --version"
`);
  fs.writeFileSync(path.join(cwd, "scripts/install.mjs"), `import fs from "node:fs";
import assert from "node:assert/strict";
assert.equal(JSON.parse(fs.readFileSync("package.json")).version, "4.1.0-alpha.1");
${failInstall ? 'process.exit(7);' : ''}
fs.mkdirSync("node_modules/fixture-generator", {recursive:true});
fs.writeFileSync("node_modules/fixture-generator/package.json", JSON.stringify({type:"module",main:"index.js"}));
fs.writeFileSync("node_modules/fixture-generator/index.js", "export const render = version => JSON.stringify({version});");
`);
  fs.writeFileSync(path.join(cwd, "scripts/generate.mjs"), `import fs from "node:fs";
import {render} from "fixture-generator";
fs.writeFileSync("dist/site/kfd-claims.json", render(process.env.BUILDCHAIN_VERSION));
`);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "source");
  return { cwd, git, intent: { channel: "alpha", version: "4.1.0-alpha.2", sourceSha: git("rev-parse", "HEAD"), sourceTimestamp: "2026-09-11T09:35:33.000Z" } };
}

test("version generation installs source dependencies before changing manifests and restores source bytes", (t) => {
  const { cwd, git, intent } = fixture(t);
  assert.equal(fs.existsSync(path.join(cwd, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(cwd, ".buildchain/runtime")), false);
  const files = localVersionFiles(cwd, intent);
  assert.deepEqual(files.map(({path}) => path), ["dist/site/kfd-claims.json", "package.json"]);
  for (const file of files) assert.equal(JSON.parse(file.content).version, intent.version);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"))).version, "4.1.0-alpha.1");
});

test("failed source installation stops version generation without changing tracked source", (t) => {
  const { cwd, git, intent } = fixture(t, { failInstall: true });
  assert.throws(() => localVersionFiles(cwd, intent), /Command failed/u);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(cwd, "node_modules")), false);
});

test("a version-only transition does not install unused generator dependencies", (t) => {
  const { cwd, git, intent } = fixture(t, { failInstall: true, generator: false });
  const files = localVersionFiles(cwd, intent);
  assert.deepEqual(files.map(({path}) => path), ["package.json"]);
  assert.equal(JSON.parse(files[0].content).version, intent.version);
  assert.equal(fs.existsSync(path.join(cwd, "node_modules")), false);
  assert.equal(git("status", "--porcelain"), "");
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function runBuildchain(args, options = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

function runBuildchainFailure(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

test("CLI prints help and version", () => {
  assert.match(runBuildchain(["--help"]), /buildchain init/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(runBuildchain(["version"]).trim(), packageJson.version);
});

test("init package creates buildchain.toml and reusable workflow", () => {
  const cwd = tempDir("init-package");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  const result = JSON.parse(runBuildchain([
    "init",
    "--cwd",
    cwd,
    "--type",
    "package",
    "--package-manager",
    "npm",
    "--artifact-name",
    "fixture-{platform}",
  ]));

  assert.equal(result.type, "package");
  assert.equal(result.packageManager, "npm");
  assert.deepEqual(result.written.sort(), [".github/workflows/build.yml", "buildchain.toml"]);
  assert.match(fs.readFileSync(path.join(cwd, "buildchain.toml"), "utf8"), /npm ci/);
  assert.match(fs.readFileSync(path.join(cwd, ".github/workflows/build.yml"), "utf8"), /artifact-name-template: "fixture-\{platform\}"/);
  const failure = runBuildchainFailure(["init", "--cwd", cwd]);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /already exists/);
});

test("validate reads initialized package config", () => {
  const cwd = tempDir("validate-package");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  runBuildchain(["init", "--cwd", cwd, "--type", "package"]);
  const validation = JSON.parse(runBuildchain([
    "validate",
    "--cwd",
    cwd,
    "--require-version-state",
    "--require-lifecycle-stages",
    "install,build,verify",
  ]));

  assert.equal(validation.project.type, "package");
  assert.equal(validation.versionFiles[0].path, "package.json");
  assert.deepEqual(validation.lifecycleStages.map((stage) => stage.name).sort(), ["build", "install", "verify"]);
});

test("lifecycle run writes deterministic artifact manifest", () => {
  const cwd = tempDir("lifecycle");
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[lifecycle.build]
command = "node -e \\"require('node:fs').mkdirSync('out',{recursive:true});require('node:fs').writeFileSync('out/result.txt','ok')\\""
`);
  const output = runBuildchain([
    "lifecycle",
    "run",
    "build",
    "--cwd",
    cwd,
    "--artifact-path",
    "out",
    "--artifact-name",
    "fixture",
  ], { cwd });
  const manifest = JSON.parse(output.slice(output.indexOf("{")));

  assert.equal(manifest.artifactName, "fixture");
  assert.equal(manifest.lifecycle.stage, "build");
  assert.equal(manifest.files[0].path, "out/result.txt");
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "artifacts", "manifest.json")));
});

test("npm dry-run validates package publish shape without publishing", () => {
  const cwd = tempDir("npm-dry-run");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "buildchain-dry-run-fixture",
    version: "1.2.3-alpha.0",
    private: false,
    license: "Apache-2.0",
  }, null, 2));
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  const result = JSON.parse(runBuildchain([
    "npm",
    "dry-run",
    "--cwd",
    cwd,
    "--json",
    "--skip-npm-publish-dry-run",
  ]));

  assert.equal(result.package.name, "buildchain-dry-run-fixture");
  assert.equal(result.exactTag, "v1.2.3-alpha.0");
  assert.equal(result.distTag, "alpha");
  assert.equal(result.wouldPublish, false);
  assert.ok(result.pack.entryCount >= 2);
});

test("npm dry-run fails closed when expected tag does not match package version", () => {
  const cwd = tempDir("npm-dry-run-mismatch");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "buildchain-dry-run-mismatch",
    version: "1.2.3",
    private: false,
  }, null, 2));
  const failure = runBuildchainFailure([
    "npm",
    "dry-run",
    "--cwd",
    cwd,
    "--expected-tag",
    "v1.2.4",
    "--skip-npm-publish-dry-run",
  ]);

  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /tag=v1\.2\.4 expected=v1\.2\.3/);
});

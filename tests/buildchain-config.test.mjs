import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverConfiguredVersionStateFiles,
  loadBuildchainConfig,
  normalizeBuildchainConfig,
  runLifecycleStage,
  updateConfiguredVersionStateContents,
  validateBuildchainConfig,
} from "../packages/core/buildchain-config.js";

function withTempRepo(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-config-"));
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("buildchain.toml discovers and updates configured version files", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"

[[version.files]]
type = "regex"
path = "CMakeLists.txt"
pattern = 'project\\(demo VERSION (?<version>[^ )]+)\\)'
replacement = '\${version}'
`,
      "package.json": '{ "name": "demo", "version": "1.0.0" }\n',
      "pyproject.toml": '[project]\nname = "demo"\nversion = "1.0.0"\n',
      "CMakeLists.txt": "project(demo VERSION 1.0.0)\n",
    },
    (dir) => {
      const loaded = loadBuildchainConfig(dir);
      const files = discoverConfiguredVersionStateFiles(dir, loaded);
      assert.deepEqual(files.map((file) => file.path), [
        "package.json",
        "pyproject.toml",
        "CMakeLists.txt",
      ]);
      const changed = updateConfiguredVersionStateContents(files, "1.0.1");
      assert.deepEqual(changed.map((file) => file.path), [
        "package.json",
        "pyproject.toml",
        "CMakeLists.txt",
      ]);
      assert.match(changed.find((file) => file.path === "package.json").content, /"version": "1.0.1"/);
      assert.match(changed.find((file) => file.path === "pyproject.toml").content, /version = "1.0.1"/);
      assert.equal(changed.find((file) => file.path === "CMakeLists.txt").content, "project(demo VERSION 1.0.1)\n");
    },
  );
});

test("lifecycle stage supports command arrays and scripts", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[lifecycle.env]
BUILDCHAIN_TEST_VALUE = "ok"

[lifecycle.build]
commands = [
  "node -e \\"require('node:fs').writeFileSync('a.txt', process.env.BUILDCHAIN_TEST_VALUE)\\"",
  "node -e \\"require('node:fs').appendFileSync('a.txt', '-done')\\"",
]

[lifecycle.verify]
shell = "bash"
script = """
set -euo pipefail
test "$(cat a.txt)" = "ok-done"
test "$BUILDCHAIN_VERSION" = "1.2.3"
"""
`,
    },
    (dir) => {
      const loaded = loadBuildchainConfig(dir);
      assert.equal(runLifecycleStage({ cwd: dir, loadedConfig: loaded, name: "build" }), true);
      assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "ok-done");
      assert.equal(
        runLifecycleStage({
          cwd: dir,
          loadedConfig: loaded,
          name: "verify",
          env: { BUILDCHAIN_VERSION: "1.2.3" },
        }),
        true,
      );
    },
  );
});

test("validateBuildchainConfig checks lifecycle declarations without executing them", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.build]
command = "node -e \\"require('node:fs').writeFileSync('should-not-exist.txt', 'ran')\\""

[lifecycle.verify]
command = "node -e \\"require('node:fs').writeFileSync('also-should-not-exist.txt', 'ran')\\""
`,
      "package.json": '{ "name": "demo", "version": "1.0.0" }\n',
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir, {
        requireVersionState: true,
        requireLifecycleStages: ["build", "verify"],
      });

      assert.deepEqual(summary.versionFiles.map((file) => file.path), ["package.json"]);
      assert.deepEqual(summary.lifecycleStages.map((stage) => stage.name), ["build", "verify"]);
      assert.equal(fs.existsSync(path.join(dir, "should-not-exist.txt")), false);
      assert.equal(fs.existsSync(path.join(dir, "also-should-not-exist.txt")), false);
    },
  );
});

test("validateBuildchainConfig fails when required lifecycle stages are missing", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[lifecycle.verify]
command = "echo verify"
`,
    },
    (dir) => {
      assert.throws(
        () =>
          validateBuildchainConfig(dir, {
            requireLifecycleStages: ["build", "verify"],
          }),
        /required lifecycle stage missing: build/,
      );
    },
  );
});

test("lifecycle stage fails closed when multiple execution modes are configured", () => {
  assert.throws(
    () =>
      normalizeBuildchainConfig({
        schema: 1,
        lifecycle: {
          build: {
            command: "echo one",
            commands: ["echo two"],
          },
        },
      }),
    /exactly one of command, commands, or script/,
  );
});

test("regex version files require a named version capture", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[[version.files]]
type = "regex"
path = "VERSION.txt"
pattern = 'version=([^ ]+)'
replacement = '\${version}'
`,
      "VERSION.txt": "version=1.0.0\n",
    },
    (dir) => {
      assert.throws(
        () => discoverConfiguredVersionStateFiles(dir, loadBuildchainConfig(dir)),
        /named capture group called version/,
      );
    },
  );
});

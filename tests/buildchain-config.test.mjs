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
  "node -e \\"import('node:fs').then((fs) => fs.writeFileSync('a.txt', process.env.BUILDCHAIN_TEST_VALUE))\\"",
  "node -e \\"import('node:fs').then((fs) => fs.appendFileSync('a.txt', '-done'))\\"",
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
command = "node -e \\"import('node:fs').then((fs) => fs.writeFileSync('should-not-exist.txt', 'ran'))\\""

[lifecycle.verify]
command = "node -e \\"import('node:fs').then((fs) => fs.writeFileSync('also-should-not-exist.txt', 'ran'))\\""

[lifecycle.publish]
commands = [
  "node scripts/publish-artifacts.mjs",
  "node scripts/write-evidence.mjs",
]
`,
      "package.json": '{ "name": "demo", "version": "1.0.0" }\n',
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir, {
        requireVersionState: true,
        requireLifecycleStages: ["build", "verify", "publish"],
      });

      assert.deepEqual(summary.versionFiles.map((file) => file.path), ["package.json"]);
      assert.deepEqual(summary.lifecycleStages.map((stage) => stage.name), ["build", "verify", "publish"]);
      assert.equal(summary.lifecycleStages.find((stage) => stage.name === "publish").commandCount, 2);
      assert.equal(fs.existsSync(path.join(dir, "should-not-exist.txt")), false);
      assert.equal(fs.existsSync(path.join(dir, "also-should-not-exist.txt")), false);
    },
  );
});

test("buildchain.toml accepts anchored manual version strategy with manifest summary", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node -e \\"process.exit(0)\\""
`,
      "package.json": '{ "name": "@kungfu-tech/libnode", "version": "22.22.3-kf.0" }\n',
      "libnode.release.json": JSON.stringify(
        {
          nodeVersion: "22.22.3",
          nodeTag: "v22.22.3",
          nodeCommit: "abc123",
          libnodeRevision: "kf.0",
          npmVersion: "22.22.3-kf.0",
        },
        null,
        2,
      ) + "\n",
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir, {
        requireVersionState: true,
        requireLifecycleStages: ["verify"],
      });

      assert.deepEqual(summary.version, {
        strategy: "anchored",
        next: "manual",
        manifest: "libnode.release.json",
      });
      assert.equal(summary.anchorManifest.path, "libnode.release.json");
      assert.equal(summary.anchorManifest.fields.nodeTag, "v22.22.3");
      assert.equal(summary.anchorManifest.fields.npmVersion, "22.22.3-kf.0");
      assert.deepEqual(summary.versionFiles.map((file) => file.path), ["package.json"]);
    },
  );
});

test("manual next version is only valid for anchored strategy", () => {
  assert.throws(
    () =>
      normalizeBuildchainConfig({
        schema: 1,
        version: {
          next: "manual",
        },
      }),
    /requires version\.strategy = "anchored"/,
  );
  assert.throws(
    () =>
      normalizeBuildchainConfig({
        schema: 1,
        version: {
          strategy: "anchored",
        },
      }),
    /requires version\.next = "manual"/,
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

test("buildchain.toml validates web-surface channels and deploy adapters", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "web-surface"
name = "site-demo"
site = "demo-site"

[channels.preview]
url_pattern = "https://{alias}.preview.example.test"
visibility = "ephemeral"
noindex = true

[channels.staging]
url = "https://staging.example.test"
visibility = "protected"
access_control = "managed-network"
edge_auth = "none"
noindex = true

[channels.production]
url = "https://example.test"
visibility = "public"
canonical = true
noindex = false

[deploy.preview]
adapter = "aws-s3-cloudfront"
bucket = "demo-preview"
artifact_path = "dist"
secret_refs = ["AWS_ROLE_ARN"]

[deploy.staging]
adapter = "aws-s3-cloudfront"
bucket = "demo-staging"
artifact_path = "dist"

[deploy.production]
adapter = "aws-s3-cloudfront"
bucket = "demo-production"
artifact_path = "dist"

[security.staging]
noindex = true
isolated_providers = true
`,
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.equal(summary.project.type, "web-surface");
      assert.equal(summary.channels.preview.urlPattern, "https://{alias}.preview.example.test");
      assert.equal(summary.channels.staging.accessControl, "managed-network");
      assert.equal(summary.channels.staging.edgeAuth, "none");
      assert.equal(summary.channels.staging.requiresControlledAccess, true);
      assert.equal(summary.deploy.production.adapter, "aws-s3-cloudfront");
    },
  );
});

test("web-surface staging must be access-controlled and noindex", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "web-surface"

[channels.preview]
url_pattern = "https://{alias}.preview.example.test"

[channels.staging]
url = "https://staging.example.test"
access_control = "none"
noindex = true

[channels.production]
url = "https://example.test"

[deploy.preview]
adapter = "aws-s3-cloudfront"

[deploy.staging]
adapter = "aws-s3-cloudfront"

[deploy.production]
adapter = "aws-s3-cloudfront"
`,
    },
    (dir) => {
      assert.throws(
        () => validateBuildchainConfig(dir),
        /channels\.staging\.access_control must protect staging/,
      );
    },
  );
});

test("web-surface deploy config rejects inline secret values", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "web-surface"

[channels.preview]
url_pattern = "https://{alias}.preview.example.test"

[channels.staging]
url = "https://staging.example.test"
access_control = "managed-network"
edge_auth = "none"
noindex = true

[channels.production]
url = "https://example.test"

[deploy.preview]
adapter = "aws-s3-cloudfront"

[deploy.staging]
adapter = "aws-s3-cloudfront"

[deploy.production]
adapter = "aws-s3-cloudfront"
aws_secret_access_key = "not-allowed"
`,
    },
    (dir) => {
      assert.throws(
        () => validateBuildchainConfig(dir),
        /must be declared as a secret reference/,
      );
    },
  );
});

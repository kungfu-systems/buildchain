import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverConfiguredVersionStateFiles,
  getNativeDiagnosticsProfile,
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

test(".buildchain/buildchain.toml is preferred over legacy root buildchain.toml", () => {
  withTempRepo(
    {
      ".buildchain/buildchain.toml": `
schema = 1

[project]
type = "package"
name = "canonical"

[lifecycle.verify]
command = "node -e \\"process.exit(0)\\""
`,
      "buildchain.toml": `
schema = 1

[project]
type = "package"
name = "legacy"

[lifecycle.verify]
command = "node -e \\"process.exit(0)\\""
`,
    },
    (dir) => {
      const loaded = loadBuildchainConfig(dir);
      assert.equal(loaded.path, ".buildchain/buildchain.toml");
      assert.equal(loaded.config.project.name, "canonical");
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

test("buildchain.toml normalizes explicit publish contract", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
package_set_order = "platforms-first-main-last"
main_package = "@kungfu-tech/libnode"
`,
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.deepEqual(summary.publish, {
        mode: "promote-existing-version",
        auth: "npm-token",
        distTag: "latest",
        packageSetOrder: "platforms-first-main-last",
        mainPackage: "@kungfu-tech/libnode",
      });
    },
  );
});

test("buildchain.toml accepts distribution-index project type", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "distribution-index"
name = "homebrew-tap"

[lifecycle.verify]
command = "buildchain homebrew check"
`,
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.deepEqual(summary.project, {
        type: "distribution-index",
        name: "homebrew-tap",
      });
      assert.deepEqual(summary.lifecycleStages.map((stage) => stage.name), ["verify"]);
    },
  );
});

test("buildchain.toml accepts publication artifact project type", () => {
  withTempRepo(
    {
      ".buildchain/buildchain.toml": `
schema = 1

[project]
type = "publication-artifact"
name = "paper-fixture"

[publication]
kind = "paper"
title = "Paper Fixture"
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md"]
source_paths = ["paper", "README.md", "LICENSE", "Makefile"]
site_consumers = ["papers.example.com"]

[lifecycle.build]
command = "make pdf"

[lifecycle.verify]
command = "make check"
`,
      "README.md": "# Paper Fixture\n",
      "LICENSE": "fixture\n",
      "Makefile": "check:\n\ttrue\npdf:\n\ttrue\n",
      "paper/main.tex": "\\documentclass{article}\n",
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir, {
        requireLifecycleStages: ["build", "verify"],
      });
      assert.equal(summary.project.type, "publication-artifact");
      assert.equal(summary.publication.title, "Paper Fixture");
      assert.equal(summary.publication.primaryArtifact, "_build/main.pdf");
      assert.deepEqual(summary.publication.sourcePaths, ["paper", "README.md", "LICENSE", "Makefile"]);
    },
  );
});

test("buildchain.toml normalizes optional native diagnostics profile", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[diagnostics.native]
enabled = true
sample_process_tree = true
compiler_cache = "ccache"
expected_tools = ["ccache", "clang", "cmake"]
artifact_dirs = ["build", "dist"]
cache_dirs = [".ccache"]

[lifecycle.build]
command = "cmake --build build"
`,
    },
    (dir) => {
      const loaded = loadBuildchainConfig(dir);
      assert.deepEqual(getNativeDiagnosticsProfile(loaded), {
        enabled: true,
        sampleProcessTree: true,
        compilerCache: "ccache",
        expectedTools: ["ccache", "clang", "cmake"],
        artifactDirs: ["build", "dist"],
        cacheDirs: [".ccache"],
      });
    },
  );
});

test("buildchain.toml rejects unsupported native diagnostics cache mode", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[diagnostics.native]
compiler_cache = "compiler-cache"
`,
    },
    (dir) => {
      assert.throws(
        () => loadBuildchainConfig(dir),
        /diagnostics\.native\.compiler_cache must be one of auto, ccache, sccache, or none/,
      );
    },
  );
});

test("buildchain.toml rejects dist-tag promotion without npm token auth", () => {
  assert.throws(
    () =>
      normalizeBuildchainConfig({
        schema: 1,
        publish: {
          mode: "promote-existing-version",
          auth: "trusted-publishing",
        },
      }),
    /requires publish\.auth = "npm-token"/,
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

test("buildchain.toml validates web-surface named surface host mappings", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "web-surface"
name = "site-libkungfu-dev"
site = "libkungfu-dev"

[channels.preview]
url_pattern = "https://{alias}.preview.libkungfu.dev"

[channels.staging]
url = "https://staging.libkungfu.dev"
access_control = "managed-network"
edge_auth = "none"
noindex = true

[channels.production]
url = "https://libkungfu.dev"
noindex = false

[surfaces.hub]
path = "/"
production_url = "https://libkungfu.dev"
staging_url = "https://staging.libkungfu.dev"
preview_url_pattern = "https://{alias}.preview.libkungfu.dev"

[surfaces.core]
path = "/core"
production_url = "https://core.libkungfu.dev"
staging_url = "https://core.staging.libkungfu.dev"
preview_url_pattern = "https://core-{alias}.preview.libkungfu.dev"

[deploy.preview]
adapter = "aws-s3-cloudfront"

[deploy.staging]
adapter = "aws-s3-cloudfront"

[deploy.production]
adapter = "aws-s3-cloudfront"
`,
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.equal(summary.surfaces.core.path, "/core/");
      assert.equal(summary.surfaces.core.previewUrlPattern, "https://core-{alias}.preview.libkungfu.dev");
      assert.equal(summary.surfaces.hub.canonical, true);
    },
  );
});

test("buildchain.toml validates externally managed web-surface directory index rewrites", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "web-surface"
name = "site-libkungfu-dev"
site = "libkungfu-dev"

[channels.preview]
url_pattern = "https://{alias}.preview.libkungfu.dev"

[channels.staging]
url = "https://staging.libkungfu.dev"
access_control = "managed-network"
edge_auth = "none"
noindex = true

[channels.production]
url = "https://libkungfu.dev"
noindex = false

[surfaces.hub]
path = "/"
production_url = "https://libkungfu.dev"
staging_url = "https://staging.libkungfu.dev"
preview_url_pattern = "https://{alias}.preview.libkungfu.dev"

[deploy.preview]
adapter = "aws-s3-cloudfront"
directory_index_rewrite = "external"

[deploy.staging]
adapter = "aws-s3-cloudfront"

[deploy.production]
adapter = "aws-s3-cloudfront"
`,
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.equal(summary.deploy.preview.directoryIndexRewrite, "external");
      assert.equal(summary.deploy.staging.directoryIndexRewrite, "buildchain");
    },
  );
});

test("buildchain.toml normalizes infra-contract configuration", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "infra-contract"
name = "infra-demo"

[infra]
adapter = "manual-observed"
desired = ["desired/site.json"]
contract = ["outputs/site.json"]

[[consumers]]
repo = "kungfu-systems/site-demo"
path = "infra/outputs.json"
source = "outputs/site.json"
`,
      "desired/site.json": "{ \"site\": \"demo\" }\n",
      "outputs/site.json": "{ \"outputs\": { \"url\": \"https://demo.example\" } }\n",
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.equal(summary.project.type, "infra-contract");
      assert.deepEqual(summary.infra, {
        adapter: "manual-observed",
        adoptionMode: "manual-observed",
        applyMode: "disabled",
        environment: "",
        identityRef: "",
        desired: ["desired/site.json"],
        contract: ["outputs/site.json"],
        secretRefs: [],
        commands: undefined,
      });
      assert.deepEqual(summary.consumers, [
        {
          repo: "kungfu-systems/site-demo",
          path: "infra/outputs.json",
          source: "outputs/site.json",
          branch: "",
        },
      ]);
    },
  );
});

test("buildchain.toml rejects infra-contract apply without target environment", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "infra-contract"
name = "infra-demo"

[infra]
adapter = "terraform"
adoption_mode = "managed-apply"
apply = "manual-approval"
identity_ref = "AWS_ROLE_ARN"
desired = ["desired/site.json"]
contract = ["outputs/site.json"]

[[consumers]]
repo = "kungfu-systems/site-demo"
path = "infra/outputs.json"
source = "outputs/site.json"
`,
    },
    (dir) => {
      assert.throws(
        () => validateBuildchainConfig(dir),
        /infra.apply requires infra.environment/,
      );
    },
  );
});

test("buildchain.toml rejects infra-contract apply without identity reference", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "infra-contract"
name = "infra-demo"

[infra]
adapter = "terraform"
adoption_mode = "managed-apply"
apply = "manual-approval"
environment = "preview"
desired = ["desired/site.json"]
contract = ["outputs/site.json"]

[[consumers]]
repo = "kungfu-systems/site-demo"
path = "infra/outputs.json"
source = "outputs/site.json"
`,
    },
    (dir) => {
      assert.throws(
        () => validateBuildchainConfig(dir),
        /infra.apply requires infra.identity_ref/,
      );
    },
  );
});

test("buildchain.toml rejects infra-contract apply without managed ownership", () => {
  withTempRepo(
    {
      "buildchain.toml": `
schema = 1

[project]
type = "infra-contract"
name = "infra-demo"

[infra]
adapter = "terraform"
adoption_mode = "observe-only"
apply = "manual-approval"
desired = ["desired/site.json"]
contract = ["outputs/site.json"]

[[consumers]]
repo = "kungfu-systems/site-demo"
path = "infra/outputs.json"
source = "outputs/site.json"
`,
    },
    (dir) => {
      assert.throws(
        () => validateBuildchainConfig(dir),
        /infra.apply requires infra.adoption_mode = managed-apply/,
      );
    },
  );
});

test("buildchain.toml rejects incomplete first-class web-surface host mappings", () => {
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

[surfaces.core]
path = "/core/"
production_url = "https://core.example.test"
preview_url_pattern = "https://core-{alias}.preview.example.test"

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
        /surfaces\.core\.staging_url is required unless path_only = true/,
      );
    },
  );
});

test("buildchain.toml allows explicit path-only web-surface fallback", () => {
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

[surfaces.docs]
path = "/docs/"
path_only = true

[deploy.preview]
adapter = "aws-s3-cloudfront"

[deploy.staging]
adapter = "aws-s3-cloudfront"

[deploy.production]
adapter = "aws-s3-cloudfront"
`,
    },
    (dir) => {
      const summary = validateBuildchainConfig(dir);
      assert.equal(summary.surfaces.docs.pathOnly, true);
      assert.equal(summary.surfaces.docs.path, "/docs/");
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

test("web-surface deploy surface overrides normalize paths and reject inline secrets", () => {
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

[surfaces.docs]
path = "/docs/"
path_only = true

[deploy.preview]
adapter = "aws-s3-cloudfront"

[deploy.staging]
adapter = "aws-s3-cloudfront"

[deploy.staging.surfaces.docs]
bucket = "docs-staging"
artifact_path = "dist/docs"
origin_path = "/docs"
secret_refs = ["AWS_ROLE_ARN"]

[deploy.production]
adapter = "aws-s3-cloudfront"
`,
    },
    (dir) => {
      validateBuildchainConfig(dir);
      const loaded = loadBuildchainConfig(dir);
      assert.equal(loaded.config.deploy.staging.surfaces.docs.artifactPath, "dist/docs");
      assert.equal(loaded.config.deploy.staging.surfaces.docs.originPath, "/docs");
      assert.deepEqual(loaded.config.deploy.staging.surfaces.docs.secretRefs, ["AWS_ROLE_ARN"]);
    },
  );

  assert.throws(
    () =>
      normalizeBuildchainConfig({
        schema: 1,
        deploy: {
          staging: {
            adapter: "aws-s3-cloudfront",
            surfaces: {
              docs: {
                token: "not-allowed",
              },
            },
          },
        },
      }),
    /deploy\.staging\.surfaces\.docs\.token must be declared as a secret reference/,
  );
});

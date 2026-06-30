import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
import { validateBuildchainConfig } from "../packages/core/buildchain-config.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("reusable build workflow exposes the required surface contract", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /platforms-json:/);
  assert.match(workflow, /fromJSON\(inputs\.platforms-json\)/);
  assert.match(workflow, /require-trusted-event:/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(workflow, /install-command:/);
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /artifact-name:/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
});

test("libnode-shaped fixture declares the build lifecycle contract", () => {
  const fixture = path.join(root, "fixtures/libnode-shaped");
  const summary = validateBuildchainConfig(fixture, {
    requireVersionState: true,
    requireLifecycleStages: ["install", "build", "verify"],
  });
  assert.deepEqual(summary.versionFiles.map((file) => file.path), ["package.json"]);
  assert.deepEqual(summary.lifecycleStages.map((stage) => stage.name), ["install", "build", "verify"]);
});

test("runLifecycle writes deterministic artifact manifest", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-surface-"));
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  try {
    runLifecycle({
      cwd: fixture,
      stageName: "install",
      required: true,
      workspace,
    });
    runLifecycle({
      cwd: fixture,
      stageName: "build",
      required: true,
      workspace,
      artifactPaths: ["fixtures/libnode-shaped/dist"],
      manifestPath: ".buildchain/artifacts/linux-x64/manifest.json",
      artifactName: "libnode-shaped-linux-x64-abc123",
      platformId: "linux-x64",
      platformName: "Linux x64",
    });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, ".buildchain/artifacts/linux-x64/manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.contract, "kungfu-buildchain-artifact");
    assert.equal(manifest.artifactName, "libnode-shaped-linux-x64-abc123");
    assert.equal(manifest.platform.id, "linux-x64");
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      [
        "fixtures/libnode-shaped/dist/install.txt",
        "fixtures/libnode-shaped/dist/libnode-shaped.txt",
      ],
    );
    assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

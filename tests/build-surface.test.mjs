import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_ARTIFACT_NAME_TEMPLATE,
  parseExpectedArtifactsJson,
  resolveArtifactContract,
  resolvePublishGate,
  resolveRunnerMatrix,
} from "../scripts/build-contract-core.mjs";
import { aggregateBuildSummaryCli } from "../scripts/aggregate-build-summary.mjs";
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";
import { validateBuildchainConfig } from "../packages/core/buildchain-config.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("reusable build workflow exposes the required surface contract", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/.build.yml"), "utf8");
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /runner-preset:/);
  assert.match(workflow, /platforms-json:/);
  assert.match(workflow, /resolve-contract:/);
  assert.match(workflow, /fromJSON\(needs\.resolve-contract\.outputs\.platforms-json\)/);
  assert.match(workflow, /require-trusted-event:/);
  assert.match(workflow, /publish-channel:/);
  assert.match(workflow, /publish-refs-json:/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name/);
  assert.match(workflow, /resolve-publish-gate\.mjs/);
  assert.match(workflow, /install-command:/);
  assert.match(workflow, /build-command:/);
  assert.match(workflow, /verify-command:/);
  assert.match(workflow, /artifact-name:/);
  assert.match(workflow, /artifact-name-template:/);
  assert.match(workflow, /expected-artifacts-json:/);
  assert.match(workflow, /manifest\.json/);
  assert.match(workflow, /summary\.json/);
  assert.match(workflow, /build-summary-artifact:/);
  assert.match(workflow, /publish-allowed:/);
  assert.match(workflow, /publish-reason:/);
  assert.match(workflow, /actions\/upload-artifact@v7\.0\.1/);
});

test("runner presets resolve to explicit matrices", () => {
  const hosted = resolveRunnerMatrix({ runnerPreset: "github-hosted" });
  assert.equal(hosted.runnerPreset, "github-hosted");
  assert.equal(hosted.platformCount, 3);
  assert.equal(hosted.platforms[0].id, "linux-x64");

  const kungfu = resolveRunnerMatrix({ runnerPreset: "kungfu-v4-self-hosted" });
  assert.equal(kungfu.runnerPreset, "kungfu-v4-self-hosted");
  assert.deepEqual(
    kungfu.platforms.map((platform) => platform.id),
    ["linux-x64", "macos-arm64", "windows-x64"],
  );
  assert.match(kungfu.platforms[0].runner, /kungfu-build-v4-linux-x64/);

  const custom = resolveRunnerMatrix({
    platformsJson: '[{"id":"linux","name":"Linux","runner":"[\\"self-hosted\\",\\"Linux\\"]"}]',
  });
  assert.equal(custom.runnerPreset, "custom");
  assert.equal(custom.platformCount, 1);
});

test("artifact name templates resolve deterministically", () => {
  const resolved = resolveArtifactContract({
    artifactName: "libnode",
    artifactNameTemplate: DEFAULT_ARTIFACT_NAME_TEMPLATE,
    platformId: "linux-x64",
    platformName: "Linux x64",
    sha: "1234567890abcdef",
  });
  assert.equal(resolved.artifactName, "libnode-linux-x64-1234567890abcdef");

  const short = resolveArtifactContract({
    artifactName: "libnode",
    artifactNameTemplate: "{artifact}-{platform}-{shortSha}-{ref}",
    platformId: "linux-x64",
    sha: "1234567890abcdef",
    ref: "refs/heads/dev/v1/v1.0",
  });
  assert.equal(short.artifactName, "libnode-linux-x64-1234567890ab-refs-heads-dev-v1-v1.0");
});

test("publish gate separates verification trust from publish eligibility", () => {
  assert.deepEqual(
    resolvePublishGate({
      trusted: true,
      publishChannel: "release",
      eventName: "push",
      ref: "refs/heads/release/v2/v2.0",
    }),
    {
      trusted: true,
      publishChannel: "release",
      publishAllowed: true,
      publishReason: "ref matched ^refs/heads/release/v\\d+/v\\d+\\.\\d+$",
    },
  );

  const sameRepoPr = resolvePublishGate({
    trusted: true,
    publishChannel: "release",
    eventName: "pull_request",
    ref: "refs/pull/123/merge",
  });
  assert.equal(sameRepoPr.publishAllowed, false);
  assert.match(sameRepoPr.publishReason, /pull_request events may verify/);

  const forkPr = resolvePublishGate({
    trusted: false,
    publishChannel: "alpha",
    eventName: "pull_request",
    ref: "refs/pull/456/merge",
  });
  assert.equal(forkPr.publishAllowed, false);
  assert.equal(forkPr.publishReason, "event is not trusted");

  assert.equal(
    resolvePublishGate({
      trusted: true,
      publishChannel: "alpha",
      eventName: "push",
      ref: "refs/tags/v2.0.5-alpha.0",
    }).publishAllowed,
    true,
  );
});

test("publish gate supports custom publish channels", () => {
  const resolved = resolvePublishGate({
    trusted: true,
    publishChannel: "nightly",
    eventName: "push",
    ref: "refs/heads/nightly/v2",
    publishRefsJson: '{"nightly":["^refs/heads/nightly/v\\\\d+$"]}',
  });
  assert.equal(resolved.publishAllowed, true);
  assert.equal(resolved.publishChannel, "nightly");

  assert.equal(
    resolvePublishGate({
      trusted: true,
      publishChannel: "nightly",
      eventName: "push",
      ref: "refs/heads/dev/v2/v2.0",
      publishRefsJson: '{"nightly":["^refs/heads/nightly/v\\\\d+$"]}',
    }).publishAllowed,
    false,
  );
});

test("expected artifact JSON normalizes supported checks", () => {
  assert.deepEqual(
    parseExpectedArtifactsJson(
      '{"minFiles":2,"maxFiles":5,"minTotalBytes":1,"requiredPaths":["dist/a.txt"]}',
    ),
    {
      minFiles: 2,
      maxFiles: 5,
      minTotalBytes: 1,
      requiredPaths: ["dist/a.txt"],
    },
  );
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
    assert.equal(manifest.summary.contract, "kungfu-buildchain-artifact-summary");
    assert.equal(manifest.summary.fileCount, 2);
    assert.ok(manifest.summary.totalBytes > 0);
    assert.equal(manifest.expectedArtifacts.ok, true);
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

test("aggregate build summary reads uploaded platform manifests", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-summary-"));
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixtures/libnode-shaped");
  fs.cpSync(fixtureSource, fixture, { recursive: true });

  const originalEnv = { ...process.env };
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
      manifestPath: ".buildchain/uploaded/libnode-manifest-linux-x64-sha/manifest.json",
      summaryPath: ".buildchain/uploaded/libnode-manifest-linux-x64-sha/summary.json",
      artifactName: "libnode-linux-x64-sha",
      platformId: "linux-x64",
      platformName: "Linux x64",
      expectedArtifactsJson:
        '{"minFiles":2,"requiredPaths":["fixtures/libnode-shaped/dist/install.txt","fixtures/libnode-shaped/dist/libnode-shaped.txt"]}',
    });

    process.env.BUILDCHAIN_SUMMARY_INPUT = path.join(workspace, ".buildchain/uploaded");
    process.env.BUILDCHAIN_SUMMARY_OUTPUT = path.join(workspace, ".buildchain/artifacts/build-summary.json");
    process.env.BUILDCHAIN_ARTIFACT_NAME = "libnode";
    process.env.BUILDCHAIN_PLATFORM_COUNT = "1";
    process.env.BUILDCHAIN_TRUSTED_EVENT = "true";
    process.env.BUILDCHAIN_PUBLISH_CHANNEL = "release";
    process.env.BUILDCHAIN_PUBLISH_ALLOWED = "true";
    process.env.BUILDCHAIN_PUBLISH_REASON = "ref matched release";
    process.env.GITHUB_OUTPUT = path.join(workspace, "github-output.txt");
    const summary = aggregateBuildSummaryCli();

    assert.equal(summary.contract, "kungfu-buildchain-build-summary");
    assert.equal(summary.platformCount, 1);
    assert.equal(summary.fileCount, 2);
    assert.ok(summary.totalBytes > 0);
    assert.deepEqual(summary.publishGate, {
      trustedEvent: true,
      channel: "release",
      allowed: true,
      reason: "ref matched release",
    });
    assert.equal(summary.platforms[0].artifactName, "libnode-linux-x64-sha");
    assert.equal(summary.platforms[0].expectedArtifacts.ok, true);
  } finally {
    process.env = originalEnv;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("run-lifecycle action accepts hyphenated GitHub Action inputs", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-action-"));
  const fixtureSource = path.join(root, "fixtures/libnode-shaped");
  const fixture = path.join(workspace, "fixture");
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
    });
    const manifestPath = path.join(workspace, ".buildchain/artifacts/linux-x64/manifest-action.json");
    const outputPath = path.join(workspace, "github-output.txt");
    const result = spawnSync(process.execPath, [path.join(root, "actions/run-lifecycle/dist/index.js")], {
      cwd: workspace,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        INPUT_CWD: fixture,
        INPUT_STAGE: "verify",
        INPUT_REQUIRED: "true",
        "INPUT_ARTIFACT-NAME": "libnode-shaped-linux-x64-test",
        "INPUT_PLATFORM-ID": "linux-x64",
        "INPUT_PLATFORM-NAME": "Linux x64",
        "INPUT_ARTIFACT-PATHS": "fixture/dist",
        "INPUT_MANIFEST-PATH": ".buildchain/artifacts/linux-x64/manifest-action.json",
        "INPUT_SUMMARY-PATH": ".buildchain/artifacts/linux-x64/summary-action.json",
        "INPUT_EXPECTED-ARTIFACTS-JSON":
          '{"minFiles":2,"requiredPaths":["fixture/dist/install.txt","fixture/dist/libnode-shaped.txt"]}',
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const summary = JSON.parse(
      fs.readFileSync(path.join(workspace, ".buildchain/artifacts/linux-x64/summary-action.json"), "utf8"),
    );
    const outputs = fs.readFileSync(outputPath, "utf8");
    assert.equal(manifest.artifactName, "libnode-shaped-linux-x64-test");
    assert.equal(manifest.platform.id, "linux-x64");
    assert.equal(summary.artifactName, "libnode-shaped-linux-x64-test");
    assert.match(outputs, /artifact-summary-json=/);
    assert.match(outputs, /expected-artifacts-ok=true/);
    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ["fixture/dist/install.txt", "fixture/dist/libnode-shaped.txt"],
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

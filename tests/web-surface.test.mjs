import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyWebSurfaceCleanup,
  applyWebSurfaceDeploy,
  checkWebSurfaceHealth,
  createWebSurfaceDeploymentManifest,
  defaultWebSurfaceAlias,
  planWebSurfaceCleanup,
  planWebSurfaceDeploy,
  preflightWebSurfaceProduction,
  validateWebSurfaceProject,
} from "../scripts/web-surface-core.mjs";
import {
  cloudFrontInvalidationWaitTargets,
  compactWebSurfaceApplyResult,
  waitForCloudFrontInvalidations,
  webSurfaceCli,
} from "../scripts/web-surface.mjs";
import { runLifecycle } from "../scripts/run-lifecycle-core.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function withFixture(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-web-surface-"));
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(path.join(root, "fixtures/web-surface-shaped"), fixture, { recursive: true });
  try {
    return fn(fixture);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function withFixtureAsync(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-web-surface-"));
  const fixture = path.join(workspace, "fixture");
  fs.cpSync(path.join(root, "fixtures/web-surface-shaped"), fixture, { recursive: true });
  try {
    return await fn(fixture);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function writeInstallerPublicationFixture(fixture, { appendOnly = true } = {}) {
  const dist = path.join(fixture, "dist");
  const immutablePath = "installers/v1/alpha/0123456789abcdef";
  fs.mkdirSync(path.join(dist, immutablePath), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "hello\n");
  const assets = [
    ["install.sh", Buffer.from("#!/bin/sh\nexit 0\n")],
    ["install.ps1", Buffer.from("exit 0\r\n")],
  ].map(([name, bytes]) => {
    fs.writeFileSync(path.join(dist, name), bytes);
    fs.writeFileSync(path.join(dist, immutablePath, name), bytes);
    return {
      name,
      contentType:
        name === "install.sh"
          ? "text/x-shellscript; charset=utf-8"
          : "text/plain; charset=utf-8",
      size: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      friendlyUrl: `https://libkungfu.dev/${name}`,
      immutableUrl: `https://libkungfu.dev/${immutablePath}/${name}`,
    };
  });
  fs.writeFileSync(
    path.join(dist, "installer-publication.json"),
    `${JSON.stringify({
      schema: "kungfu.bootstrap-installer-publication/v1",
      installerVersion: "v1",
      channel: "alpha",
      sourceCommit: "a".repeat(40),
      channelUrl: "https://releases.kungfu.tech/channels/alpha.json",
      channelPayloadRoot: `sha256:${"1".repeat(64)}`,
      channelFileDigest: `sha256:${"2".repeat(64)}`,
      releasePassport: {
        ref: "buildchain:release-candidate-passport/fixture",
        root: `sha256:${"3".repeat(64)}`,
      },
      immutablePath,
      entries: [{
        platform: "linux",
        architecture: "x64",
        version: "4.0.0-alpha.1",
        sourceCommit: "a".repeat(40),
        manifestRoot: `sha256:${"4".repeat(64)}`,
        artifactRoot: `sha256:${"5".repeat(64)}`,
        artifactUrl:
          "https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-cli-linux-x64.tar.gz",
        artifactSize: 4096,
        artifactDigest: `sha256:${"6".repeat(64)}`,
        artifactSignature: "sigstore:fixture",
        archiveName: "kungfu-cli-linux-x64.tar.gz",
        archiveBase: "kungfu-cli-linux-x64",
      }],
      assets,
    }, null, 2)}\n`,
  );
  if (appendOnly) {
    fs.writeFileSync(
      path.join(dist, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "kungfu-bootstrap-installer-web-surface/v1",
        archivePolicy: {
          contract: "kungfu-buildchain-publication-archive-policy",
          deploymentBoundary: "append-only immutable version prefixes",
        },
        installerPublication: "installer-publication.json",
        publications: [{
          id: "kungfu-bootstrap-installer-alpha",
          versions: [{
            version: `sha256:${"1".repeat(64)}`,
            immutablePath: `/${immutablePath}/`,
          }],
        }],
      }, null, 2)}\n`,
    );
  }
}

test("web-surface fixture validates and runs lifecycle without version state", () => {
  withFixture((fixture) => {
    const summary = validateWebSurfaceProject(fixture);
    assert.equal(summary.project.type, "web-surface");
    assert.equal(summary.channels.preview.urlPattern, "https://{alias}.preview.libkungfu.dev");
    assert.deepEqual(Object.keys(summary.surfaces), ["hub", "core", "buildchain", "kfd"]);
    assert.equal(summary.surfaces.core.stagingUrl, "https://core.staging.libkungfu.dev");
    assert.equal(summary.surfaces.kfd.productionUrl, "https://kfd.libkungfu.dev");
    assert.equal(summary.version, undefined);

    assert.equal(runLifecycle({ cwd: fixture, stageName: "build" }).lifecycle.executed, true);
    assert.equal(runLifecycle({ cwd: fixture, stageName: "verify", required: true }).lifecycle.executed, true);
  });
});

test("web-surface deploy plan emits deterministic manifest without touching AWS", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const sourceSha = "a".repeat(40);
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "sha-aaaaaaaaaaaa",
      sourceSha,
      deployedAt: "2026-07-01T00:00:00.000Z",
    });

    assert.equal(plan.dryRun, true);
    assert.equal(plan.adapter, "aws-s3-cloudfront");
    assert.equal(plan.url, "https://sha-aaaaaaaaaaaa.preview.libkungfu.dev");
    assert.deepEqual(plan.urls, {
      hub: "https://sha-aaaaaaaaaaaa.preview.libkungfu.dev",
      core: "https://core-sha-aaaaaaaaaaaa.preview.libkungfu.dev",
      buildchain: "https://buildchain-sha-aaaaaaaaaaaa.preview.libkungfu.dev",
      kfd: "https://kfd-sha-aaaaaaaaaaaa.preview.libkungfu.dev",
    });
    assert.equal(plan.manifest.site, "libkungfu-dev");
    assert.equal(plan.manifest.sourceSha, sourceSha);
    assert.equal(plan.manifest.generatedAt, "2026-07-01T00:00:00.000Z");
    assert.equal(plan.manifest.publishedAt, "2026-07-01T00:00:00.000Z");
    assert.equal(plan.manifest.reproducible, true);
    assert.equal(plan.manifest.timestampPolicy, "ci-injected");
    assert.equal(plan.manifest.sourceRevision, sourceSha);
    assert.equal(
      plan.manifest.timestampPolicyDetails.timestampFieldsParticipateInArtifactDigest,
      false,
    );
    assert.match(
      plan.manifest.timestampPolicyDetails.artifactDigestScope,
      /excludes deployment manifest timestamps/,
    );
    assert.equal(plan.manifest.surfaceBindings.length, 4);
    assert.deepEqual(
      plan.manifest.surfaceBindings.map((binding) => [binding.surface, binding.sourcePath, binding.canonicalUrl]),
      [
        ["hub", "/", "https://libkungfu.dev"],
        ["core", "/core/", "https://core.libkungfu.dev"],
        ["buildchain", "/buildchain/", "https://buildchain.libkungfu.dev"],
        ["kfd", "/kfd/", "https://kfd.libkungfu.dev"],
      ],
    );
    assert.match(plan.manifest.artifactHash, /^[0-9a-f]{64}$/);
    assert.equal(plan.manifest.retentionClass, "preview-sha-immutable");
    assert.equal(plan.manifest.expiresAt, "2026-09-29T00:00:00.000Z");
    assert.deepEqual(
      plan.steps.map((step) => step.action),
      [
        "ensure-cloudfront-directory-index-rewrite",
        "sync-static-artifact",
        "write-deployment-manifest",
        "invalidate-cdn",
        "sync-static-artifact",
        "write-deployment-manifest",
        "invalidate-cdn",
        "sync-static-artifact",
        "write-deployment-manifest",
        "invalidate-cdn",
        "sync-static-artifact",
        "write-deployment-manifest",
        "invalidate-cdn",
      ],
    );
  });
});

test("web-surface deploy welds installer bytes, append-only policy, and cache metadata", () => {
  withFixture((fixture) => {
    writeInstallerPublicationFixture(fixture);
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "sha-aaaaaaaaaaaa",
      sourceSha: "a".repeat(40),
      deployedAt: "2026-07-24T00:00:00.000Z",
    });
    assert.equal(plan.manifest.installerPublicationEvidence.state, "verified");
    assert.match(plan.manifest.installerPublicationEvidence.evidenceRoot, /^sha256:[a-f0-9]{64}$/);

    const calls = [];
    applyWebSurfaceDeploy({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const immutableSync = calls.find((operation) => operation.action === "sync-immutable-artifact");
    assert.deepEqual(immutableSync.args.slice(-4), [
      "--content-type",
      "application/octet-stream",
      "--cache-control",
      "public,max-age=31536000,immutable",
    ]);
    const friendly = calls.filter((operation) => operation.action === "publish-friendly-installer");
    assert.deepEqual(
      friendly.map((operation) => operation.installer.name).sort(),
      ["install.ps1", "install.sh"],
    );
    assert.equal(
      friendly.every((operation) =>
        operation.args.includes("public,max-age=300,must-revalidate")),
      true,
    );
  });
});

test("web-surface deploy rejects installer publication without append-only coverage", () => {
  withFixture((fixture) => {
    writeInstallerPublicationFixture(fixture, { appendOnly: false });
    assert.throws(
      () => planWebSurfaceDeploy({
        cwd: fixture,
        channel: "preview",
        alias: "sha-aaaaaaaaaaaa",
        sourceSha: "a".repeat(40),
        deployedAt: "2026-07-24T00:00:00.000Z",
      }),
      /not covered by append-only publication policy/,
    );
  });
});

test("web-surface deploy apply defaults to dry-run operations", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-123",
      sourceSha: "a".repeat(40),
      appliedAt: "2026-07-01T00:00:00.000Z",
      commandRunner() {
        throw new Error("dry-run must not execute commands");
      },
    });

    assert.equal(result.contract, "kungfu-buildchain-web-surface-deploy-apply");
    assert.equal(result.applyMode, "dry-run");
    assert.equal(result.status, "planned");
    assert.equal(result.objectPrefix, "pr-123");
    assert.equal(result.manifestKey, ".buildchain/deployments/pr-123/hub.json");
    assert.equal(result.surfaceBindings.length, 4);
    assert.deepEqual(
      result.operations.map((operation) => operation.executed),
      Array.from({ length: 21 }, () => false),
    );
    assert.equal(
      result.operations.filter((operation) => operation.action === "ensure-cloudfront-directory-index-rewrite").length,
      1,
    );
    assert.equal(result.operations.filter((operation) => operation.action === "ensure-cloudfront-default-root-object").length, 0);
  });
});

test("web-surface deploy apply can treat directory index rewrite as externally managed", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace(
        "[deploy.preview]\nadapter = \"aws-s3-cloudfront\"",
        "[deploy.preview]\nadapter = \"aws-s3-cloudfront\"\ndirectory_index_rewrite = \"external\"",
      ),
    );
    fs.mkdirSync(path.join(fixture, "dist", "buildchain", "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "docs", "index.html"), "docs\n");

    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "a".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(
      plan.steps.some((step) => step.action === "ensure-cloudfront-directory-index-rewrite"),
      false,
    );
    assert.deepEqual(
      [...new Set(plan.manifest.surfaceBindings.map((binding) => binding.directoryIndexRewrite))],
      ["external"],
    );
    assert.deepEqual(
      [...new Set(plan.manifest.surfaceBindings.map((binding) => binding.routing.directoryIndexStrategy))],
      ["external-viewer-request-function"],
    );
    const buildchainBinding = plan.manifest.surfaceBindings.find((binding) => binding.surface === "buildchain");
    assert.equal(buildchainBinding.routing.directoryIndexManagedBy, "external");
    assert.deepEqual(
      buildchainBinding.smokeUrls.map((entry) => [entry.kind, entry.requestPath]),
      [
        ["root", "/"],
        ["nested", "/docs/"],
      ],
    );

    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "a".repeat(40),
      dryRun: true,
      appliedAt: "2026-07-01T00:00:00.000Z",
    });
    assert.equal(
      result.operations.some((operation) => operation.action === "ensure-cloudfront-directory-index-rewrite"),
      false,
    );
    assert.equal(result.operations.some((operation) => operation.action === "sync-static-artifact"), true);
  });
});

test("web-surface deploy apply executes aws s3 and cloudfront commands through runner", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: false,
      appliedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.equal(result.applyMode, "apply");
    assert.equal(result.status, "applied");
    assert.equal(result.target, "libkungfu-dev-staging");
    assert.equal(result.operations.length, 21);
    const rewrite = calls.find((call) => call.action === "ensure-cloudfront-directory-index-rewrite");
    assert.equal(rewrite.command, "node");
    assert.equal(path.basename(rewrite.args[0]), "web-surface-cloudfront-rewrite.mjs");
    assert.deepEqual(rewrite.args.slice(1), [
      "--distribution-id",
      "E-STAGING",
      "--function-name",
      "buildchain-web-surface-index-E-STAGING",
    ]);
    assert.equal(calls.some((call) => call.action === "ensure-cloudfront-default-root-object"), false);
    const hubSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.deepEqual(hubSync.args.slice(0, 3), ["s3", "sync", path.join(fixture, "dist")]);
    assert.equal(hubSync.args[3], "s3://libkungfu-dev-staging/staging");
    const hubManifest = calls.find((call) => call.action === "write-deployment-manifest" && call.surface === "hub");
    assert.equal(hubManifest.args[0], "s3");
    assert.equal(hubManifest.args[2], "-");
    assert.match(hubManifest.stdin, /"channel": "staging"/);
    const hubInvalidation = calls.find((call) => call.action === "invalidate-cdn" && call.surface === "hub");
    assert.deepEqual(hubInvalidation.args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-STAGING",
      "--paths",
      "/*",
      "/.buildchain/deployments/staging/hub.json",
    ]);
    const coreSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "core");
    const coreInvalidation = calls.find((call) => call.action === "invalidate-cdn" && call.surface === "core");
    assert.equal(coreSync.args[3], "s3://libkungfu-dev-staging/staging/core");
    assert.deepEqual(coreInvalidation.args.slice(-2), [
      "/*",
      "/.buildchain/deployments/staging/core.json",
    ]);
    assert.deepEqual(
      result.operations.map((operation) => operation.executed),
      Array.from({ length: 21 }, () => true),
    );
  });
});

test("web-surface deploy records and applies explicit cache-control classes", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace(
        '[deploy.staging]\nadapter = "aws-s3-cloudfront"',
        [
          '[deploy.staging]',
          'adapter = "aws-s3-cloudfront"',
          'cache_control_default = "public,max-age=3600"',
          'cache_control_mutable = "public,max-age=300,must-revalidate"',
          'cache_control_immutable = "public,max-age=31536000,immutable"',
        ].join("\n"),
      ),
    );
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    fs.writeFileSync(path.join(fixture, "dist", "manifest.json"), "{}\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "a".repeat(40),
      dryRun: false,
      appliedAt: "2026-07-22T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.deepEqual(result.surfaceBindings[0].cacheControl, {
      default: "public,max-age=3600",
      mutable: "public,max-age=300,must-revalidate",
      immutable: "public,max-age=31536000,immutable",
    });
    const sync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.deepEqual(sync.args.slice(-2), ["--cache-control", "public,max-age=3600"]);
    const mutable = calls.find((call) => call.action === "apply-mutable-cache-control" && call.surface === "hub");
    assert.deepEqual(mutable.args.slice(-2), ["--cache-control", "public,max-age=300,must-revalidate"]);
    assert.deepEqual(
      mutable.args.filter((value, index) => mutable.args[index - 1] === "--include"),
      ["*.html", "*.json", "*.xml"],
    );
    const manifest = calls.find((call) => call.action === "write-deployment-manifest" && call.surface === "hub");
    assert.deepEqual(manifest.args.slice(-2), ["--cache-control", "public,max-age=300,must-revalidate"]);
    assert.match(manifest.stdin, /"cacheControl"/);
  });
});

test("web-surface health waits for applied CloudFront invalidations", () => {
  const result = {
    operations: [
      {
        action: "invalidate-cdn",
        surface: "hub",
        status: "applied",
        args: ["cloudfront", "create-invalidation", "--distribution-id", "E-HUB", "--paths", "/*"],
        stdout: JSON.stringify({ Invalidation: { Id: "I-HUB" } }),
      },
      {
        action: "invalidate-cdn",
        surface: "hub",
        status: "applied",
        args: ["cloudfront", "create-invalidation", "--distribution-id", "E-HUB", "--paths", "/*"],
        stdout: JSON.stringify({ Invalidation: { Id: "I-HUB" } }),
      },
      {
        action: "invalidate-cdn",
        surface: "core",
        status: "planned",
        args: ["cloudfront", "create-invalidation", "--distribution-id", "E-CORE", "--paths", "/*"],
        stdout: JSON.stringify({ Invalidation: { Id: "I-CORE" } }),
      },
    ],
  };
  assert.deepEqual(cloudFrontInvalidationWaitTargets(result), [
    {
      distributionId: "E-HUB",
      invalidationId: "I-HUB",
      surface: "hub",
    },
  ]);

  const calls = [];
  assert.deepEqual(waitForCloudFrontInvalidations(result, {
    commandRunner(args, target) {
      calls.push({ args, target });
      return { status: 0, stdout: "", stderr: "" };
    },
  }), [
    {
      distributionId: "E-HUB",
      invalidationId: "I-HUB",
      surface: "hub",
      status: "completed",
    },
  ]);
  assert.deepEqual(calls.map((call) => call.args), [[
    "cloudfront",
    "wait",
    "invalidation-completed",
    "--distribution-id",
    "E-HUB",
    "--id",
    "I-HUB",
  ]]);
});

test("web-surface deploy apply rewrites surface host roots to artifact path prefixes", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist", "buildchain", "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "docs", "index.html"), "docs\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "b".repeat(40),
      dryRun: false,
      appliedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    const buildchainBinding = result.surfaceBindings.find((binding) => binding.surface === "buildchain");
    const buildchainSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "buildchain");
    const buildchainAliases = calls
      .filter((call) => call.action === "write-directory-index-alias" && call.surface === "buildchain")
      .map((call) => ({
        key: call.args[call.args.indexOf("--key") + 1],
        body: call.args[call.args.indexOf("--body") + 1],
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
    assert.equal(buildchainBinding.url, "https://buildchain-pr-29.preview.libkungfu.dev");
    assert.equal(buildchainBinding.artifactPathPrefix, "buildchain");
    assert.equal(buildchainBinding.routing.viewerPathPrefix, "/");
    assert.equal(buildchainBinding.routing.artifactPathPrefix, "buildchain");
    assert.deepEqual(
      buildchainBinding.smokeUrls.map((entry) => [entry.kind, entry.requestPath, entry.url]),
      [
        ["root", "/", "https://buildchain-pr-29.preview.libkungfu.dev/"],
        ["nested", "/docs/", "https://buildchain-pr-29.preview.libkungfu.dev/docs/"],
      ],
    );
    assert.equal(buildchainSync.args[2], path.join(fixture, "dist", "buildchain"));
    assert.equal(buildchainSync.args[3], "s3://libkungfu-dev-preview/pr-29/buildchain");
    assert.deepEqual(buildchainAliases, [
      {
        key: "pr-29/buildchain",
        body: path.join(fixture, "dist", "buildchain", "index.html"),
      },
      {
        key: "pr-29/buildchain/",
        body: path.join(fixture, "dist", "buildchain", "index.html"),
      },
      {
        key: "pr-29/buildchain/docs",
        body: path.join(fixture, "dist", "buildchain", "docs", "index.html"),
      },
      {
        key: "pr-29/buildchain/docs/",
        body: path.join(fixture, "dist", "buildchain", "docs", "index.html"),
      },
    ]);
  });
});

test("web-surface deploy apply only records nested smoke URLs when nested HTML exists", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist", "buildchain"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");

    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    const buildchainBinding = result.surfaceBindings.find((binding) => binding.surface === "buildchain");

    assert.deepEqual(
      buildchainBinding.smokeUrls.map((entry) => [entry.kind, entry.requestPath, entry.url]),
      [
        ["root", "/", "https://buildchain-pr-29.preview.libkungfu.dev/"],
      ],
    );
    assert.equal(buildchainBinding.smokeUrls.some((entry) => entry.missing), false);
  });
});

test("web-surface deploy apply honors per-surface deploy overrides", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.appendFileSync(configPath, `

[deploy.staging.surfaces.core]
bucket = "libkungfu-dev-core-staging"
cloudfront_distribution = "E-CORE-STAGING"
prefix = "core-staging"
origin_path = "/core"
secret_refs = ["CORE_AWS_ROLE_ARN"]
`);
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: false,
      appliedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    const coreBinding = result.surfaceBindings.find((binding) => binding.surface === "core");
    assert.equal(coreBinding.bucket, "libkungfu-dev-core-staging");
    assert.equal(coreBinding.distributionId, "E-CORE-STAGING");
    assert.equal(coreBinding.originPath, "/core");
    assert.equal(coreBinding.objectPrefix, "core-staging");
    const coreSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "core");
    const coreInvalidation = calls.find((call) => call.action === "invalidate-cdn" && call.surface === "core");
    assert.equal(coreSync.args[3], "s3://libkungfu-dev-core-staging/core-staging");
    assert.deepEqual(coreInvalidation.args.slice(-2), [
      "/*",
      "/.buildchain/deployments/staging/core.json",
    ]);
  });
});

test("web-surface deploy apply can execute a saved deploy plan", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.equal(result.status, "applied");
    assert.equal(result.sourceSha, "b".repeat(40));
    assert.equal(result.artifactHash, plan.artifact.hash);
    const hubSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.equal(hubSync.args[3], "s3://libkungfu-dev-staging/staging");
  });
});

test("web-surface deploy apply honors explicit bucket-root prefix", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace(
        '[deploy.staging]\nadapter = "aws-s3-cloudfront"',
        '[deploy.staging]\nprefix = ""\nadapter = "aws-s3-cloudfront"',
      ),
    );
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: false,
      appliedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.equal(result.objectPrefix, "");
    const hubSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.deepEqual(hubSync.args, [
      "s3",
      "sync",
      path.join(fixture, "dist"),
      "s3://libkungfu-dev-staging",
      "--delete",
      "--exclude",
      ".buildchain/*",
    ]);
    const hubInvalidation = calls.find((call) => call.action === "invalidate-cdn" && call.surface === "hub");
    assert.deepEqual(hubInvalidation.args.slice(-2), ["/*", "/.buildchain/deployments/staging/hub.json"]);
  });
});

test("web-surface deploy preserves version prefixes while updating the archive index", async () => {
  await withFixtureAsync(async (fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace(
        '[deploy.staging]\nadapter = "aws-s3-cloudfront"',
        [
          '[deploy.staging]',
          'adapter = "aws-s3-cloudfront"',
          'cache_control_mutable = "public,max-age=300,must-revalidate"',
          'cache_control_immutable = "public,max-age=31536000,immutable"',
        ].join("\n"),
      ),
    );
    const archiveIndex = path.join(fixture, "dist", "buildchain", "archive", "index.html");
    const archiveRoot = path.join(fixture, "dist", "buildchain", "archive", "paper", "v1.0.0");
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.writeFileSync(archiveIndex, "mutable archive index\n");
    fs.writeFileSync(path.join(archiveRoot, "index.html"), "immutable reader\n");
    fs.writeFileSync(path.join(archiveRoot, "main.pdf"), "immutable pdf\n");
    fs.writeFileSync(
      path.join(fixture, "dist", "buildchain", "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "consumer-publication-archive-surface",
        archivePolicy: {
          contract: "kungfu-buildchain-publication-archive-policy",
          deploymentBoundary: "append-only immutable version prefixes",
        },
        publications: [{
          id: "paper",
          versions: [{ version: "1.0.0", immutablePath: "/archive/paper/v1.0.0/" }],
        }],
      }, null, 2)}\n`,
    );

    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    const binding = plan.manifest.surfaceBindings.find((entry) => entry.surface === "buildchain");
    assert.deepEqual(binding.immutablePublication?.preservedRoots, ["archive/paper/v1.0.0"]);
    assert.deepEqual(binding.immutablePublication?.declaredPrefixes, ["archive/paper/v1.0.0"]);
    assert.deepEqual(
      binding.immutablePublication?.files.map((file) => file.path),
      ["archive/paper/v1.0.0/index.html", "archive/paper/v1.0.0/main.pdf"],
    );
    const hubBinding = plan.manifest.surfaceBindings.find((entry) => entry.surface === "hub");
    assert.deepEqual(hubBinding.mutableDeleteExcludes, ["buildchain/archive/paper/v1.0.0/*"]);
    assert.deepEqual(binding.mutableDeleteExcludes, ["archive/paper/v1.0.0/*"]);

    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });
    const buildchainCalls = calls.filter((call) => call.surface === "buildchain");
    assert.equal(calls[0].action, "verify-immutable-artifact-before-upload");
    assert.deepEqual(buildchainCalls.slice(0, 6).map((call) => call.action), [
      "verify-immutable-artifact-before-upload",
      "verify-immutable-artifact-before-upload",
      "sync-immutable-artifact",
      "verify-immutable-artifact-after-upload",
      "verify-immutable-artifact-after-upload",
      "sync-static-artifact",
    ]);
    const immutableSync = buildchainCalls.find((call) => call.action === "sync-immutable-artifact");
    assert.deepEqual(immutableSync.args.slice(-5), [
      "--no-overwrite",
      "--checksum-algorithm",
      "SHA256",
      "--cache-control",
      "public,max-age=31536000,immutable",
    ]);
    assert.equal(immutableSync.args[2], path.join(fixture, "dist", "buildchain", "archive", "paper", "v1.0.0"));
    assert.equal(immutableSync.args[3], "s3://libkungfu-dev-staging/staging/buildchain/archive/paper/v1.0.0");
    const mutableSync = buildchainCalls.find((call) => call.action === "sync-static-artifact");
    assert.deepEqual(mutableSync.args.slice(-2), ["--exclude", "archive/paper/v1.0.0/*"]);
    const mutableMetadata = buildchainCalls.find((call) => call.action === "apply-mutable-cache-control");
    assert.deepEqual(mutableMetadata.args.slice(-4), [
      "--exclude",
      "archive/paper/v1.0.0/*",
      "--cache-control",
      "public,max-age=300,must-revalidate",
    ]);
    const hubMutableSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.deepEqual(hubMutableSync.args.slice(-2), ["--exclude", "buildchain/archive/paper/v1.0.0/*"]);
    assert.ok(
      calls.findLastIndex((call) => call.action === "verify-immutable-artifact-after-upload") <
      calls.indexOf(hubMutableSync),
    );
    const directoryIndexAliases = buildchainCalls
      .filter((call) => call.action === "write-directory-index-alias")
      .map((call) => call.args[call.args.indexOf("--key") + 1]);
    assert.ok(directoryIndexAliases.some((key) => key?.endsWith("/archive")));
    assert.equal(directoryIndexAliases.some((key) => key?.includes("/archive/paper/v1.0.0")), false);
    assert.deepEqual(result.immutablePreservation, [{
      surface: "buildchain",
      manifestPath: "buildchain/manifest.json",
      preservedRoots: ["archive/paper/v1.0.0"],
      declaredPrefixes: ["archive/paper/v1.0.0"],
      fileCount: 2,
      mutableDeleteExcludes: ["archive/paper/v1.0.0/*"],
      coveringBindings: [
        { surface: "buildchain", mutableDeleteExcludes: ["archive/paper/v1.0.0/*"] },
        { surface: "hub", mutableDeleteExcludes: ["buildchain/archive/paper/v1.0.0/*"] },
      ],
      status: "applied",
    }]);
    assert.deepEqual(
      compactWebSurfaceApplyResult(result).immutablePreservation,
      result.immutablePreservation,
    );

    const health = await checkWebSurfaceHealth({
      result,
      cwd: fixture,
      managedNetworkS3ObjectVerification: false,
      fetchImpl() {
        throw new Error("managed-network health must not require public fetch");
      },
    });
    const preservation = health.checks.find((check) => check.surface === "__immutable__");
    assert.equal(preservation.status, "pass");
    assert.equal(preservation.bindings[0].fileCount, 2);
    assert.deepEqual(preservation.bindings[0].coveringBindings, [
      { surface: "buildchain", mutableDeleteExcludes: ["archive/paper/v1.0.0/*"], status: "pass" },
      { surface: "hub", mutableDeleteExcludes: ["buildchain/archive/paper/v1.0.0/*"], status: "pass" },
    ]);

    const failedCalls = [];
    const failed = applyWebSurfaceDeploy({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        failedCalls.push(operation);
        return { exitCode: 1, stdout: "", stderr: "immutable object digest mismatch" };
      },
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.immutablePreservation[0].status, "failed");
    assert.deepEqual(failedCalls.map((call) => call.action), ["verify-immutable-artifact-before-upload"]);
  });
});

test("web-surface deploy preserves Patrol-owned observed evidence paths", async () => {
  await withFixtureAsync(async (fixture) => {
    const policyDir = path.join(fixture, "dist", ".buildchain");
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      path.join(policyDir, "observed-evidence-ownership.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "kungfu-buildchain-observed-evidence-ownership",
        paths: ["dogfood-evidence.json", "dogfood-evidence/snapshots/*"],
      }, null, 2)}\n`,
    );
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    const hub = plan.manifest.surfaceBindings.find((entry) => entry.surface === "hub");
    assert.deepEqual(hub.observedEvidenceOwnership?.paths, [
      "dogfood-evidence.json",
      "dogfood-evidence/snapshots/*",
    ]);
    assert.deepEqual(hub.mutableDeleteExcludes, [
      "dogfood-evidence.json",
      "dogfood-evidence/snapshots/*",
    ]);
    const calls = [];
    applyWebSurfaceDeploy({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });
    const sync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.deepEqual(sync.args.slice(-4), [
      "--exclude", "dogfood-evidence.json",
      "--exclude", "dogfood-evidence/snapshots/*",
    ]);
  });
});

test("publication package-pin fast path touches one surface and bounded files only", async () => {
  await withFixtureAsync(async (fixture) => {
    const surfaceRoot = path.join(fixture, "dist", "buildchain");
    const oldPrefix = path.join(surfaceRoot, "archive", "paper", "v0.9.0");
    const newPrefix = path.join(surfaceRoot, "archive", "paper", "v1.0.0");
    fs.mkdirSync(oldPrefix, { recursive: true });
    fs.mkdirSync(newPrefix, { recursive: true });
    fs.mkdirSync(path.join(surfaceRoot, "paper", "latest"), { recursive: true });
    fs.writeFileSync(path.join(oldPrefix, "index.html"), "old immutable reader\n");
    fs.writeFileSync(path.join(oldPrefix, "main.pdf"), "old immutable pdf\n");
    fs.writeFileSync(path.join(newPrefix, "index.html"), "new immutable reader\n");
    fs.writeFileSync(path.join(newPrefix, "main.pdf"), "new immutable pdf\n");
    fs.writeFileSync(path.join(surfaceRoot, "index.html"), "paper shelf\n");
    fs.writeFileSync(path.join(surfaceRoot, "paper", "latest", "index.html"), "latest paper\n");
    fs.writeFileSync(
      path.join(surfaceRoot, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "consumer-publication-archive-surface",
        archivePolicy: {
          contract: "kungfu-buildchain-publication-archive-policy",
          deploymentBoundary: "append-only immutable version prefixes",
        },
        publications: [{
          id: "paper",
          versions: [
            { version: "0.9.0", immutablePath: "/archive/paper/v0.9.0/" },
            { version: "1.0.0", immutablePath: "/archive/paper/v1.0.0/" },
          ],
        }],
      }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(fixture, "dist", "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "consumer-generated-site-manifest",
        publicationFastPath: {
          contract: "kungfu-buildchain-publication-package-pin-fast-path",
          mode: "package-pin-only",
          targetSurface: "buildchain",
          qualificationRoot: `sha256:${"a".repeat(64)}`,
          immutablePrefixes: ["archive/paper/v1.0.0"],
          mutableFiles: ["index.html", "manifest.json", "paper/latest/index.html"],
          invalidationPaths: ["/", "/archive/paper/v1.0.0/*", "/paper/latest/*"],
        },
      }, null, 2)}\n`,
    );

    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(plan.urls), ["buildchain"]);
    assert.equal(plan.surfaceBindings.length, 1);
    assert.equal(plan.publicationFastPath.targetSurface, "buildchain");
    const binding = plan.surfaceBindings[0];
    assert.deepEqual(binding.immutablePublication.uploadRoots, ["archive/paper/v1.0.0"]);
    assert.deepEqual(
      binding.immutablePublication.files.map((file) => file.path),
      ["archive/paper/v1.0.0/index.html", "archive/paper/v1.0.0/main.pdf"],
    );
    assert.equal(plan.steps.some((step) => step.action === "sync-static-artifact"), false);
    assert.equal(
      plan.steps.filter((step) => step.action === "sync-publication-fast-path").length,
      3,
    );

    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });
    assert.equal(calls.some((call) => call.surface !== "buildchain"), false);
    assert.equal(calls.some((call) => call.action === "sync-static-artifact"), false);
    assert.equal(
      calls.filter((call) => call.action === "sync-publication-fast-path").length,
      3,
    );
    const immutableSync = calls.find((call) => call.action === "sync-immutable-artifact");
    assert.equal(
      immutableSync.args[2],
      path.join(fixture, "dist", "buildchain", "archive", "paper", "v1.0.0"),
    );
    assert.equal(immutableSync.args.some((arg) => String(arg).includes("v0.9.0")), false);
    const invalidation = calls.find((call) => call.action === "invalidate-cdn");
    assert.deepEqual(
      invalidation.args.slice(invalidation.args.indexOf("--paths") + 1, -1),
      ["/", "/archive/paper/v1.0.0/*", "/paper/latest/*"],
    );
    assert.deepEqual(result.invalidationPaths.slice(0, -1), [
      "/",
      "/archive/paper/v1.0.0/*",
      "/paper/latest/*",
    ]);
    assert.equal(result.immutablePreservation[0].status, "applied");

    const health = await checkWebSurfaceHealth({
      result,
      cwd: fixture,
      managedNetworkS3ObjectVerification: false,
      fetchImpl() {
        throw new Error("managed-network health must not require public fetch");
      },
    });
    const root = health.checks.find((check) => check.surface === "buildchain" && check.kind === "root");
    assert.equal(health.status, "passed");
    assert.equal(root.evidence.status, "pass");
    assert.deepEqual(root.evidence.requiredActions, [
      "sync-publication-fast-path",
      "write-deployment-manifest",
    ]);
    assert.equal(
      health.checks.find((check) => check.surface === "__immutable__").status,
      "pass",
    );
  });
});

test("publication package-pin fast path preserves metadata-only historical prefixes", async () => {
  await withFixtureAsync(async (fixture) => {
    const surfaceRoot = path.join(fixture, "dist", "buildchain");
    const currentPrefix = path.join(surfaceRoot, "archive", "paper", "v1.0.0");
    fs.mkdirSync(currentPrefix, { recursive: true });
    fs.mkdirSync(path.join(surfaceRoot, "paper", "latest"), { recursive: true });
    fs.writeFileSync(path.join(currentPrefix, "index.html"), "current immutable reader\n");
    fs.writeFileSync(path.join(currentPrefix, "main.pdf"), "current immutable pdf\n");
    fs.writeFileSync(path.join(surfaceRoot, "index.html"), "paper shelf\n");
    fs.writeFileSync(path.join(surfaceRoot, "paper", "latest", "index.html"), "latest paper\n");
    fs.writeFileSync(
      path.join(surfaceRoot, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "consumer-publication-archive-surface",
        archivePolicy: {
          contract: "kungfu-buildchain-publication-archive-policy",
          deploymentBoundary: "append-only immutable version prefixes",
        },
        publications: [{
          id: "paper",
          versions: [
            { version: "0.9.0", immutablePath: "/archive/paper/v0.9.0/" },
            {
              version: "1.0.0",
              immutablePath: "/archive/paper/v1.0.0/",
              immutableIndex: { path: "index.html" },
            },
          ],
        }],
      }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(fixture, "dist", "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contract: "consumer-generated-site-manifest",
        publicationFastPath: {
          contract: "kungfu-buildchain-publication-package-pin-fast-path",
          mode: "package-pin-only",
          targetSurface: "buildchain",
          qualificationRoot: `sha256:${"a".repeat(64)}`,
          immutablePrefixes: ["archive/paper/v1.0.0"],
          mutableFiles: ["index.html", "manifest.json", "paper/latest/index.html"],
          invalidationPaths: ["/", "/archive/paper/v1.0.0/*", "/paper/latest/*"],
        },
      }, null, 2)}\n`,
    );

    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    const binding = plan.surfaceBindings[0];
    assert.deepEqual(binding.immutablePublication.preservedRoots, [
      "archive/paper/v0.9.0",
      "archive/paper/v1.0.0",
    ]);
    assert.deepEqual(binding.immutablePublication.materializedPrefixes, [
      "archive/paper/v1.0.0",
    ]);
    assert.deepEqual(binding.immutablePublication.uploadRoots, [
      "archive/paper/v1.0.0",
    ]);
    assert.deepEqual(
      binding.immutablePublication.files.map((file) => file.path),
      ["archive/paper/v1.0.0/index.html", "archive/paper/v1.0.0/main.pdf"],
    );
  });
});

test("web-surface deploy apply fails closed when saved plan artifact drifted", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
    });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "changed\n");

    assert.throws(
      () => applyWebSurfaceDeploy({ cwd: fixture, plan, dryRun: false }),
      /artifact hash mismatch/,
    );
  });
});

test("web-surface deploy apply rejects artifact canonical hosts from another channel", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "production page\n");
    fs.writeFileSync(path.join(fixture, "dist", "manifest.json"), `${JSON.stringify({
      contract: "consumer-generated-site-manifest",
      canonicalHost: "staging.libkungfu.dev",
      pages: [{ host: "core.staging.libkungfu.dev", path: "/core/" }],
    }, null, 2)}\n`);
    const plan = planWebSurfaceDeploy({ cwd: fixture, channel: "production", sourceSha: "b".repeat(40) });
    assert.throws(() => applyWebSurfaceDeploy({ cwd: fixture, plan, dryRun: true }), /artifact channel facts mismatch.*staging\.libkungfu\.dev/i);
  });
});

test("web-surface deploy apply fails closed on placeholder AWS targets", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    const source = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      source
        .replace('bucket = "libkungfu-dev-staging"', 'bucket = "pending-staging-bucket"')
        .replace('cloudfront_distribution = "E-STAGING"', 'cloudfront_distribution = "pending-staging-distribution"'),
    );
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");

    assert.doesNotThrow(() => planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
    }));
    assert.throws(
      () => applyWebSurfaceDeploy({
        cwd: fixture,
        channel: "staging",
        sourceSha: "b".repeat(40),
        dryRun: false,
      }),
      /deploy\.staging\.surfaces\.hub\.bucket/,
    );
  });
});

test("web-surface deploy apply fails closed on placeholder per-surface AWS targets", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.appendFileSync(configPath, `

[deploy.staging.surfaces.core]
bucket = "pending-core-bucket"
cloudfront_distribution = "E-CORE-STAGING"
`);
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");

    assert.throws(
      () => applyWebSurfaceDeploy({
        cwd: fixture,
        channel: "staging",
        sourceSha: "b".repeat(40),
        dryRun: false,
      }),
      /deploy\.staging\.surfaces\.core\.bucket/,
    );
  });
});

test("web-surface deploy apply records failure and stops subsequent operations", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-456",
      sourceSha: "b".repeat(40),
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        throw new Error("simulated sync failure");
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].status, "failed");
    assert.match(result.operations[0].stderr, /simulated sync failure/);
    assert.equal(calls.length, 1);
  });
});

test("web-surface manifest supports managed-network staging without Basic Auth", () => {
  withFixture((fixture) => {
    const manifest = createWebSurfaceDeploymentManifest({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      artifactHash: "c".repeat(64),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });

    assert.equal(manifest.url, "https://staging.libkungfu.dev");
    assert.deepEqual(
      Object.fromEntries(manifest.surfaceBindings.map((binding) => [binding.surface, binding.url])),
      {
        hub: "https://staging.libkungfu.dev",
        core: "https://core.staging.libkungfu.dev",
        buildchain: "https://buildchain.staging.libkungfu.dev",
        kfd: "https://kfd.staging.libkungfu.dev",
      },
    );
    assert.equal(manifest.retentionClass, "staging-protected");
    assert.equal(manifest.expiresAt, "2026-09-29T00:00:00.000Z");
    assert.equal(manifest.accessControl, "managed-network");
    assert.equal(manifest.edgeAuth, "none");
    assert.equal(manifest.noindex, true);
    assert.deepEqual(manifest.secretRefs.sort(), ["AWS_ROLE_ARN"].sort());
  });
});

test("web-surface production manifest uses canonical retention and public indexability", () => {
  withFixture((fixture) => {
    const manifest = createWebSurfaceDeploymentManifest({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
      artifactHash: "c".repeat(64),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });

    assert.equal(manifest.url, "https://libkungfu.dev");
    assert.equal(manifest.retentionClass, "production-canonical");
    assert.equal(manifest.expiresAt, "2027-07-01T00:00:00.000Z");
    assert.equal(manifest.mutableAlias, false);
    assert.equal(manifest.canonical, true);
    assert.equal(manifest.noindex, false);
  });
});

test("web-surface production deploy apply executes against production target", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const calls = [];
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
      dryRun: false,
      appliedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.equal(result.status, "applied");
    assert.equal(result.objectPrefix, "production");
    assert.equal(result.manifestKey, ".buildchain/deployments/production/hub.json");
    const hubSync = calls.find((call) => call.action === "sync-static-artifact" && call.surface === "hub");
    assert.equal(hubSync.args[3], "s3://libkungfu-dev-production/production");
    const hubInvalidation = calls.find((call) => call.action === "invalidate-cdn" && call.surface === "hub");
    const kfdInvalidation = calls.find((call) => call.action === "invalidate-cdn" && call.surface === "kfd");
    assert.deepEqual(hubInvalidation.args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-PRODUCTION",
      "--paths",
      "/*",
      "/.buildchain/deployments/production/hub.json",
    ]);
    assert.deepEqual(kfdInvalidation.args.slice(-2), [
      "/*",
      "/.buildchain/deployments/production/kfd.json",
    ]);
  });
});

test("web-surface production preflight validates every product surface host", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
      deployedAt: "2026-07-01T00:00:00.000Z",
    });
    const calls = [];
    const result = await preflightWebSurfaceProduction({
      cwd: fixture,
      plan,
      execute: true,
      checkedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        calls.push(operation);
        if (operation.action === "preflight-get-distribution") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Distribution: {
                DistributionConfig: {
                  Aliases: {
                    Items: [
                      "libkungfu.dev",
                      "core.libkungfu.dev",
                      "buildchain.libkungfu.dev",
                      "kfd.libkungfu.dev",
                    ],
                  },
                },
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      dnsResolver(host) {
        return [{ type: "A", value: `203.0.113.${host.length}` }];
      },
    });

    assert.equal(result.contract, "kungfu-buildchain-web-surface-production-preflight");
    assert.equal(result.status, "passed");
    assert.equal(result.urls.kfd, "https://kfd.libkungfu.dev");
    assert.equal(calls.filter((call) => call.action === "preflight-head-bucket").length, 1);
    assert.equal(calls.filter((call) => call.action === "preflight-get-distribution").length, 1);
    assert.deepEqual(
      result.checks.find((check) => check.name === "production-cloudfront-aliases").details.aliases.map((entry) => entry.host),
      ["libkungfu.dev", "core.libkungfu.dev", "buildchain.libkungfu.dev", "kfd.libkungfu.dev"],
    );
  });
});

test("web-surface production preflight fails when kfd host is not aliased", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
    });
    const result = await preflightWebSurfaceProduction({
      cwd: fixture,
      plan,
      execute: true,
      commandRunner(operation) {
        if (operation.action === "preflight-get-distribution") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Distribution: {
                DistributionConfig: {
                  Aliases: {
                    Items: ["libkungfu.dev", "core.libkungfu.dev", "buildchain.libkungfu.dev"],
                  },
                },
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      dnsResolver() {
        return [{ type: "A", value: "203.0.113.10" }];
      },
    });

    const aliasCheck = result.checks.find((check) => check.name === "production-cloudfront-aliases");
    assert.equal(result.status, "failed");
    assert.equal(aliasCheck.status, "fail");
    assert.match(aliasCheck.message, /kfd\.libkungfu\.dev/);
  });
});

test("web-surface production preflight fails when deploy plan omits configured kfd surface", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
    });
    plan.urls = Object.fromEntries(Object.entries(plan.urls).filter(([surface]) => surface !== "kfd"));
    plan.manifest.surfaceBindings = plan.manifest.surfaceBindings.filter((binding) => binding.surface !== "kfd");
    const result = await preflightWebSurfaceProduction({
      cwd: fixture,
      plan,
      execute: false,
    });

    const surfaceSet = result.checks.find((check) => check.name === "production-surface-set");
    assert.equal(result.status, "failed");
    assert.equal(surfaceSet.status, "fail");
    assert.deepEqual(surfaceSet.details.missing, ["kfd"]);
  });
});

test("web-surface health check covers kfd and fails closed on production noindex", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      httpRetryAttempts: 1,
      fetchImpl(url) {
        return {
          status: 200,
          url,
          headers: {
            get(name) {
              return name.toLowerCase() === "x-robots-tag" && url === "https://kfd.libkungfu.dev/"
                ? "noindex"
                : "";
            },
          },
        };
      },
    });

    assert.equal(health.contract, "kungfu-buildchain-web-surface-health-check");
    assert.equal(health.status, "failed");
    assert.equal(health.urls.kfd, "https://kfd.libkungfu.dev");
    assert.match(health.checks.find((check) => check.surface === "kfd" && check.kind === "root").message, /noindex=true/);
  });
});

test("web-surface health check smokes root and nested surface URLs", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist", "buildchain", "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "docs", "index.html"), "docs\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    const fetched = [];
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      httpRetryAttempts: 1,
      fetchImpl(url) {
        fetched.push(url);
        return {
          status: url === "https://buildchain-pr-29.preview.libkungfu.dev/docs/" ? 403 : 200,
          url,
          headers: {
            get() {
              return "";
            },
          },
          text() {
            return "<!doctype html>";
          },
        };
      },
    });

    const nested = health.checks.find((check) => check.surface === "buildchain" && check.kind === "nested");
    assert.equal(health.status, "failed");
    assert.equal(nested.url, "https://buildchain-pr-29.preview.libkungfu.dev/docs/");
    assert.equal(nested.httpStatus, 403);
    assert.ok(fetched.includes("https://buildchain-pr-29.preview.libkungfu.dev/"));
    assert.ok(fetched.includes("https://buildchain-pr-29.preview.libkungfu.dev/docs/"));
  });
});

test("web-surface health check retries transient HTTP failures", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    let calls = 0;
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      httpRetryAttempts: 2,
      httpRetryIntervalMs: 0,
      fetchImpl(url) {
        calls += 1;
        return {
          status: calls === 1 ? 403 : 200,
          url,
          headers: {
            get() {
              return "";
            },
          },
          text() {
            return "<!doctype html>";
          },
        };
      },
    });

    const root = health.checks.find((check) => check.surface === "hub" && check.kind === "root");
    assert.equal(health.status, "passed");
    assert.equal(root.httpStatus, 200);
    assert.equal(root.attempts, 2);
    assert.ok(calls >= 2);
  });
});

test("web-surface health check default retry window absorbs extended transient HTTP failures", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    let calls = 0;
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      httpRetryIntervalMs: 0,
      fetchImpl(url) {
        calls += 1;
        return {
          status: calls < 5 ? 403 : 200,
          url,
          headers: {
            get() {
              return "";
            },
          },
          text() {
            return "<!doctype html>";
          },
        };
      },
    });

    const root = health.checks.find((check) => check.surface === "hub" && check.kind === "root");
    assert.equal(health.status, "passed");
    assert.equal(root.httpStatus, 200);
    assert.equal(root.attempts, 5);
    assert.ok(calls >= 5);
  });
});

test("web-surface health check retries transient installer route failures", async () => {
  await withFixtureAsync(async (fixture) => {
    writeInstallerPublicationFixture(fixture);
    const result = applyWebSurfaceDeploy({ cwd: fixture, channel: "preview", alias: "pr-29", sourceSha: "b".repeat(40), dryRun: true });
    const contents = new Map([["install.sh", Buffer.from("#!/bin/sh\nexit 0\n")], ["install.ps1", Buffer.from("exit 0\r\n")]]);
    let ps1Attempts = 0;
    const health = await checkWebSurfaceHealth({
      cwd: fixture, result, httpRetryAttempts: 2, httpRetryIntervalMs: 0,
      fetchImpl(url, options) {
        const parsed = new URL(url);
        const name = parsed.pathname.split("/").at(-1);
        if (!contents.has(name)) return { status: 200, url, headers: new Headers(), text: async () => "<!doctype html>" };
        assert.equal(options.redirect, "manual");
        if (parsed.pathname === "/install.ps1" && ++ps1Attempts === 1) return { status: 403, url, headers: new Headers(), arrayBuffer: async () => Buffer.alloc(0) };
        const immutable = parsed.pathname.includes("/installers/");
        return { status: 200, url, headers: new Headers({
          "content-type": name === "install.sh" ? "text/x-shellscript" : "text/plain",
          "cache-control": immutable ? "public,max-age=31536000,immutable"
            : "public,max-age=300,must-revalidate",
        }), arrayBuffer: async () => contents.get(name) };
      },
    });
    assert.equal(health.status, "passed");
    assert.equal(ps1Attempts, 2);
  });
});

test("web-surface health check verifies managed-network staging from deployment evidence", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist", "buildchain", "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "docs", "index.html"), "docs\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      fetchImpl() {
        throw new Error("managed-network health must not require public fetch");
      },
    });

    const buildchainRoot = health.checks.find((check) => check.surface === "buildchain" && check.kind === "root");
    const buildchainNested = health.checks.find((check) => check.surface === "buildchain" && check.kind === "nested");
    assert.equal(health.status, "passed");
    assert.equal(buildchainRoot.healthStrategy, "deployment-evidence");
    assert.equal(buildchainRoot.accessControl, "managed-network");
    assert.deepEqual(buildchainRoot.evidence.requiredActions, ["sync-static-artifact", "write-deployment-manifest"]);
    assert.equal(buildchainRoot.evidence.status, "pass");
    assert.equal(buildchainNested.healthStrategy, "deployment-evidence");
  });
});

test("web-surface health check verifies managed-network live apply with S3 head checks", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist", "buildchain", "docs"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "docs", "index.html"), "docs\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: false,
      commandRunner() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const headOperations = [];
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        headOperations.push(operation);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      fetchImpl() {
        throw new Error("managed-network health must not require public fetch");
      },
    });

    const buildchainRoot = health.checks.find((check) => check.surface === "buildchain" && check.kind === "root");
    const buildchainNested = health.checks.find((check) => check.surface === "buildchain" && check.kind === "nested");
    assert.equal(health.status, "passed");
    assert.equal(buildchainRoot.healthStrategy, "s3-object");
    assert.equal(buildchainRoot.objectKey, "staging/buildchain/index.html");
    assert.equal(buildchainNested.objectKey, "staging/buildchain/docs/index.html");
    assert.ok(headOperations.some((operation) => operation.args.includes(".buildchain/deployments/staging/buildchain.json")));
    assert.ok(headOperations.some((operation) => operation.args.includes("staging/buildchain/index.html")));
    assert.ok(headOperations.some((operation) => operation.args.includes("staging/buildchain/docs/index.html")));
  });
});

test("web-surface health check accepts managed-network bucket-root object prefix", async () => {
  await withFixtureAsync(async (fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace(
        '[deploy.staging]\nadapter = "aws-s3-cloudfront"',
        '[deploy.staging]\nprefix = ""\nadapter = "aws-s3-cloudfront"',
      ),
    );
    fs.mkdirSync(path.join(fixture, "dist", "about"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "about", "index.html"), "about\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: false,
      commandRunner() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const headOperations = [];
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        headOperations.push(operation);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      fetchImpl() {
        throw new Error("managed-network bucket-root health must not require public fetch");
      },
    });

    const hubRoot = health.checks.find((check) => check.surface === "hub" && check.kind === "root");
    const hubNested = health.checks.find((check) => check.surface === "hub" && check.kind === "nested");
    assert.equal(health.status, "passed");
    assert.equal(hubRoot.objectPrefix, "");
    assert.equal(hubRoot.objectKey, "index.html");
    assert.equal(hubNested.objectKey, "about/index.html");
    assert.ok(headOperations.some((operation) => operation.args.includes(".buildchain/deployments/staging/hub.json")));
    assert.ok(headOperations.some((operation) => operation.args.includes("index.html")));
    assert.ok(headOperations.some((operation) => operation.args.includes("about/index.html")));
  });
});

test("web-surface health check supports explicit S3 object health for public preview", async () => {
  await withFixtureAsync(async (fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    fs.writeFileSync(
      configPath,
      fs.readFileSync(configPath, "utf8").replace(
        'artifact_path = "dist"\nsecret_refs = ["AWS_ROLE_ARN"]',
        'artifact_path = "dist"\nhealth_strategy = "s3-object"\nsecret_refs = ["AWS_ROLE_ARN"]',
      ),
    );
    fs.mkdirSync(path.join(fixture, "dist", "buildchain"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hub\n");
    fs.writeFileSync(path.join(fixture, "dist", "buildchain", "index.html"), "buildchain\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "preview",
      alias: "pr-29",
      sourceSha: "b".repeat(40),
      dryRun: false,
      commandRunner() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const headOperations = [];
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      checkedAt: "2026-07-01T00:00:00.000Z",
      commandRunner(operation) {
        headOperations.push(operation);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      fetchImpl() {
        throw new Error("explicit S3 object health must not require public fetch");
      },
    });

    const hubRoot = health.checks.find((check) => check.surface === "hub" && check.kind === "root");
    const buildchainRoot = health.checks.find((check) => check.surface === "buildchain" && check.kind === "root");
    assert.equal(health.status, "passed");
    assert.equal(hubRoot.accessControl, "none");
    assert.equal(hubRoot.healthStrategy, "s3-object");
    assert.equal(hubRoot.objectKey, "pr-29/index.html");
    assert.equal(buildchainRoot.objectKey, "pr-29/buildchain/index.html");
    assert.ok(headOperations.some((operation) => operation.args.includes(".buildchain/deployments/pr-29/buildchain.json")));
    assert.ok(headOperations.some((operation) => operation.args.includes("pr-29/buildchain/index.html")));
  });
});

test("web-surface health check can use an allowed runner for managed-network HTTP smoke", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    const fetched = [];
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      allowedManagedNetworkRunner: true,
      fetchImpl(url) {
        fetched.push(url);
        return {
          status: 200,
          url,
          headers: {
            get() {
              return "";
            },
          },
          text() {
            return "<!doctype html>";
          },
        };
      },
    });

    const hub = health.checks.find((check) => check.surface === "hub" && check.kind === "root");
    assert.equal(health.status, "passed");
    assert.equal(hub.healthStrategy, "http");
    assert.ok(fetched.includes("https://staging.libkungfu.dev/"));
  });
});

test("web-surface health check fails production on html robots noindex meta", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const result = applyWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "b".repeat(40),
      dryRun: true,
    });
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result,
      fetchImpl(url) {
        return {
          status: 200,
          url,
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "text/html" : "";
            },
          },
          text() {
            return url === "https://kfd.libkungfu.dev/"
              ? '<!doctype html><meta name="robots" content="noindex">'
              : "<!doctype html>";
          },
        };
      },
    });

    const kfd = health.checks.find((check) => check.surface === "kfd" && check.kind === "root");
    assert.equal(health.status, "failed");
    assert.equal(kfd.noindexHeaderValue, false);
    assert.equal(kfd.noindexMeta, true);
    assert.match(kfd.message, /noindex=true/);
  });
});

test("web-surface health check fails closed without surface URLs", async () => {
  await withFixtureAsync(async (fixture) => {
    const health = await checkWebSurfaceHealth({
      cwd: fixture,
      result: { channel: "production", urls: {}, manifest: { surfaceBindings: [] } },
      fetchImpl() {
        throw new Error("fetch must not run without urls");
      },
    });

    assert.equal(health.status, "failed");
    assert.match(health.checks.find((check) => check.surface === "__urls__").message, /requires at least one surface URL/);
    assert.equal(health.checks.find((check) => check.surface === "__manifest__").status, "fail");
  });
});

test("web-surface CLI production-preflight writes output", async () => {
  await withFixtureAsync(async (fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "production",
      sourceSha: "d".repeat(40),
    });
    const planPath = path.join(fixture, ".buildchain", "web-surface-plan.json");
    const output = path.join(fixture, ".buildchain", "web-surface-production-preflight.json");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const originalArgv = process.argv;
    try {
      process.argv = [
        "node",
        "web-surface.mjs",
        "--mode",
        "production-preflight",
        "--cwd",
        fixture,
        "--plan",
        planPath,
        "--output",
        output,
      ];
      const preflight = await webSurfaceCli();
      assert.equal(preflight.status, "passed");
      assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).urls.kfd, "https://kfd.libkungfu.dev");
    } finally {
      process.argv = originalArgv;
    }
  });
});

test("web-surface cleanup plan distinguishes mutable PR aliases from immutable SHA aliases", () => {
  withFixture((fixture) => {
    const cleanup = planWebSurfaceCleanup({
      cwd: fixture,
      aliases: ["pr-123", "sha-abcdef123456"],
    });

    assert.equal(cleanup.dryRun, true);
    assert.equal(cleanup.status, "planned");
    assert.equal(cleanup.applyMode, "dry-run");
    assert.equal(cleanup.entries[0].aliasKind, "pr");
    assert.equal(cleanup.entries[0].mutableAlias, true);
    assert.equal(cleanup.entries[0].retentionDays, 14);
    assert.equal(cleanup.entries[0].action, "delete-preview-alias");
    assert.equal(cleanup.entries[0].manifestKey, ".buildchain/deployments/pr-123/hub.json");
    assert.equal(cleanup.entries[0].surfaceBindings.length, 4);
    assert.equal(cleanup.entries[1].aliasKind, "sha");
    assert.equal(cleanup.entries[1].mutableAlias, false);
    assert.equal(cleanup.entries[1].retentionDays, 90);
  });
});

test("web-surface closed PR cleanup can plan apply from pull number", () => {
  withFixture((fixture) => {
    const cleanup = planWebSurfaceCleanup({
      cwd: fixture,
      pullNumber: "321",
      event: "pull-request-closed",
      sourceSha: "1".repeat(40),
      actor: "octocat",
      runId: "12345",
      dryRun: false,
    });

    assert.equal(cleanup.dryRun, false);
    assert.equal(cleanup.applyMode, "apply");
    assert.equal(cleanup.event, "pull-request-closed");
    assert.equal(cleanup.status, "planned");
    assert.equal(cleanup.pullNumber, "321");
    assert.equal(cleanup.sourceSha, "1".repeat(40));
    assert.equal(cleanup.entries.length, 1);
    assert.equal(cleanup.entries[0].alias, "pr-321");
    assert.deepEqual(
      cleanup.entries[0].steps.map((step) => step.action),
      [
        "delete-static-prefix",
        "delete-deployment-manifest",
        "invalidate-cdn",
        "delete-static-prefix",
        "delete-deployment-manifest",
        "invalidate-cdn",
        "delete-static-prefix",
        "delete-deployment-manifest",
        "invalidate-cdn",
        "delete-static-prefix",
        "delete-deployment-manifest",
        "invalidate-cdn",
      ],
    );
  });
});

test("web-surface cleanup without aliases is an auditable no-op", () => {
  withFixture((fixture) => {
    const cleanup = planWebSurfaceCleanup({
      cwd: fixture,
      event: "pull-request-closed",
      dryRun: false,
    });

    assert.equal(cleanup.status, "no-op");
    assert.equal(cleanup.applyMode, "apply");
    assert.deepEqual(cleanup.entries, []);
  });
});

test("web-surface cleanup apply executes preview deletion through runner", () => {
  withFixture((fixture) => {
    const calls = [];
    const result = applyWebSurfaceCleanup({
      cwd: fixture,
      pullNumber: "123",
      event: "pull-request-closed",
      sourceSha: "c".repeat(40),
      actor: "octocat",
      runId: "run-1",
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.equal(result.contract, "kungfu-buildchain-web-surface-cleanup-apply");
    assert.equal(result.applyMode, "apply");
    assert.equal(result.status, "applied");
    assert.equal(result.entries[0].alias, "pr-123");
    assert.deepEqual(calls[0].args, ["s3", "rm", "s3://libkungfu-dev-preview/pr-123", "--recursive"]);
    assert.deepEqual(calls[1].args, ["s3", "rm", "s3://libkungfu-dev-preview/.buildchain/deployments/pr-123/hub.json"]);
    assert.deepEqual(calls[2].args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-PREVIEW",
      "--paths",
      "/*",
      "/.buildchain/deployments/pr-123/hub.json",
    ]);
    assert.deepEqual(calls[3].args, ["s3", "rm", "s3://libkungfu-dev-preview/pr-123/core", "--recursive"]);
  });
});

test("web-surface cleanup apply fails closed on placeholder preview distribution", () => {
  withFixture((fixture) => {
    const configPath = path.join(fixture, "buildchain.toml");
    const source = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      source.replace('cloudfront_distribution = "E-PREVIEW"', 'cloudfront_distribution = "pending-preview-distribution"'),
    );

    assert.throws(
      () => applyWebSurfaceCleanup({
        cwd: fixture,
        pullNumber: "123",
        sourceSha: "c".repeat(40),
        dryRun: false,
      }),
      /deploy\.preview\.surfaces\.hub\.cloudfront_distribution/,
    );
  });
});

test("web-surface cleanup apply can execute a saved cleanup plan", () => {
  withFixture((fixture) => {
    const plan = planWebSurfaceCleanup({
      cwd: fixture,
      pullNumber: "456",
      event: "pull-request-closed",
      dryRun: false,
    });
    const calls = [];
    const result = applyWebSurfaceCleanup({
      cwd: fixture,
      plan,
      dryRun: false,
      commandRunner(operation) {
        calls.push(operation);
        return { exitCode: 0, stdout: `${operation.action}\n`, stderr: "" };
      },
    });

    assert.equal(result.status, "applied");
    assert.equal(result.entries[0].alias, "pr-456");
    assert.deepEqual(calls[0].args, ["s3", "rm", "s3://libkungfu-dev-preview/pr-456", "--recursive"]);
  });
});

test("web-surface CLI writes manifest output", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const output = path.join(fixture, ".buildchain", "web-surface-manifest.json");
    const originalArgv = process.argv;
    try {
      process.argv = [
        "node",
        "web-surface.mjs",
        "--mode",
        "manifest",
        "--cwd",
        fixture,
        "--source-sha",
        "d".repeat(40),
        "--alias",
        "pr-123",
        "--output",
        output,
      ];
      const manifest = webSurfaceCli();
      assert.equal(manifest.alias, "pr-123");
      assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).alias, "pr-123");
    } finally {
      process.argv = originalArgv;
    }
  });
});

test("web-surface CLI deploy-apply writes dry-run apply result by default", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const output = path.join(fixture, ".buildchain", "web-surface-apply.json");
    const originalArgv = process.argv;
    try {
      process.argv = [
        "node",
        "web-surface.mjs",
        "--mode",
        "deploy-apply",
        "--cwd",
        fixture,
        "--channel",
        "staging",
        "--source-sha",
        "d".repeat(40),
        "--output",
        output,
      ];
      const result = webSurfaceCli();
      assert.equal(result.applyMode, "dry-run");
      assert.equal(result.status, "planned");
      assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).contract, "kungfu-buildchain-web-surface-deploy-apply");
    } finally {
      process.argv = originalArgv;
    }
  });
});

test("web-surface CLI deploy-apply preserves failed operation diagnostics", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const output = path.join(fixture, ".buildchain", "web-surface-apply.json");
    const originalArgv = process.argv;
    try {
      process.argv = [
        "node",
        "web-surface.mjs",
        "--mode",
        "deploy-apply",
        "--cwd",
        fixture,
        "--channel",
        "staging",
        "--source-sha",
        "d".repeat(40),
        "--dry-run",
        "false",
        "--output",
        output,
      ];
      assert.throws(() => webSurfaceCli(), /see apply result/);
      const result = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(result.status, "failed");
      assert.equal(result.operations[0].action, "ensure-cloudfront-directory-index-rewrite");
      assert.equal(result.operations[0].surface, "__distribution__");
      assert.equal(result.operations[0].command, "node");
      assert.equal(path.basename(result.operations[0].args[0]), "web-surface-cloudfront-rewrite.mjs");
      assert.match(result.operations[0].stderr, /aws|ENOENT|exit code/);
    } finally {
      process.argv = originalArgv;
    }
  });
});

test("web-surface CLI deploy-apply can read a saved plan without source sha args", () => {
  withFixture((fixture) => {
    fs.mkdirSync(path.join(fixture, "dist"), { recursive: true });
    fs.writeFileSync(path.join(fixture, "dist", "index.html"), "hello\n");
    const plan = planWebSurfaceDeploy({
      cwd: fixture,
      channel: "staging",
      sourceSha: "d".repeat(40),
    });
    const planPath = path.join(fixture, ".buildchain", "web-surface-plan.json");
    const output = path.join(fixture, ".buildchain", "web-surface-apply.json");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const originalArgv = process.argv;
    try {
      process.argv = [
        "node",
        "web-surface.mjs",
        "--mode",
        "deploy-apply",
        "--cwd",
        fixture,
        "--plan",
        planPath,
        "--output",
        output,
      ];
      const result = webSurfaceCli();
      assert.equal(result.applyMode, "dry-run");
      assert.equal(result.sourceSha, "d".repeat(40));
      assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).artifactHash, plan.artifact.hash);
    } finally {
      process.argv = originalArgv;
    }
  });
});

test("web-surface default preview aliases prefer PR then source SHA", () => {
  assert.equal(
    defaultWebSurfaceAlias({ channel: "preview", pullNumber: "77", sourceSha: "e".repeat(40) }),
    "pr-77",
  );
  assert.equal(
    defaultWebSurfaceAlias({ channel: "preview", sourceSha: "f".repeat(40) }),
    "sha-ffffffffffff",
  );
  assert.equal(defaultWebSurfaceAlias({ channel: "production", sourceSha: "f".repeat(40) }), "");
});

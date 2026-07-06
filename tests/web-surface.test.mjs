import assert from "node:assert/strict";
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
import { webSurfaceCli } from "../scripts/web-surface.mjs";
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
      [false, false, false, false, false, false, false, false, false, false, false, false],
    );
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
    assert.equal(result.operations.length, 12);
    assert.deepEqual(calls[0].args.slice(0, 3), ["s3", "sync", path.join(fixture, "dist")]);
    assert.equal(calls[0].args[3], "s3://libkungfu-dev-staging/staging");
    assert.equal(calls[1].args[0], "s3");
    assert.equal(calls[1].args[2], "-");
    assert.match(calls[1].stdin, /"channel": "staging"/);
    assert.deepEqual(calls[2].args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-STAGING",
      "--paths",
      "/*",
      "/.buildchain/deployments/staging/hub.json",
    ]);
    assert.equal(calls[3].args[3], "s3://libkungfu-dev-staging/staging/core");
    assert.deepEqual(calls[5].args.slice(-2), [
      "/*",
      "/.buildchain/deployments/staging/core.json",
    ]);
    assert.deepEqual(
      result.operations.map((operation) => operation.executed),
      [true, true, true, true, true, true, true, true, true, true, true, true],
    );
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
    assert.equal(calls[3].args[3], "s3://libkungfu-dev-core-staging/core-staging");
    assert.deepEqual(calls[5].args.slice(-2), [
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
    assert.equal(calls[0].args[3], "s3://libkungfu-dev-staging/staging");
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
    assert.deepEqual(calls[0].args, [
      "s3",
      "sync",
      path.join(fixture, "dist"),
      "s3://libkungfu-dev-staging",
      "--delete",
      "--exclude",
      ".buildchain/*",
    ]);
    assert.deepEqual(calls[2].args.slice(-2), ["/*", "/.buildchain/deployments/staging/hub.json"]);
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
    assert.equal(calls[0].args[3], "s3://libkungfu-dev-production/production");
    assert.deepEqual(calls[2].args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-PRODUCTION",
      "--paths",
      "/*",
      "/.buildchain/deployments/production/hub.json",
    ]);
    assert.deepEqual(calls[11].args.slice(-2), [
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
      fetchImpl(url) {
        return {
          status: 200,
          url,
          headers: {
            get(name) {
              return name.toLowerCase() === "x-robots-tag" && url === "https://kfd.libkungfu.dev"
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
    assert.match(health.checks.find((check) => check.surface === "kfd").message, /noindex=true/);
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
            return url === "https://kfd.libkungfu.dev"
              ? '<!doctype html><meta name="robots" content="noindex">'
              : "<!doctype html>";
          },
        };
      },
    });

    const kfd = health.checks.find((check) => check.surface === "kfd");
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

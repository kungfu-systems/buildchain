import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyWebSurfaceCleanup,
  applyWebSurfaceDeploy,
  createWebSurfaceDeploymentManifest,
  defaultWebSurfaceAlias,
  planWebSurfaceCleanup,
  planWebSurfaceDeploy,
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

test("web-surface fixture validates and runs lifecycle without version state", () => {
  withFixture((fixture) => {
    const summary = validateWebSurfaceProject(fixture);
    assert.equal(summary.project.type, "web-surface");
    assert.equal(summary.channels.preview.urlPattern, "https://{alias}.preview.kungfu.tech");
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
    assert.equal(plan.url, "https://sha-aaaaaaaaaaaa.preview.kungfu.tech");
    assert.equal(plan.manifest.site, "kungfu-tech");
    assert.equal(plan.manifest.sourceSha, sourceSha);
    assert.match(plan.manifest.artifactHash, /^[0-9a-f]{64}$/);
    assert.equal(plan.manifest.retentionClass, "preview-sha-immutable");
    assert.equal(plan.manifest.expiresAt, "2026-09-29T00:00:00.000Z");
    assert.deepEqual(
      plan.steps.map((step) => step.action),
      ["sync-static-artifact", "write-deployment-manifest", "invalidate-cdn"],
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
    assert.equal(result.manifestKey, ".buildchain/deployments/pr-123.json");
    assert.deepEqual(
      result.operations.map((operation) => operation.executed),
      [false, false, false],
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
    assert.equal(result.target, "kungfu-tech-staging");
    assert.equal(result.operations.length, 3);
    assert.deepEqual(calls[0].args.slice(0, 3), ["s3", "sync", path.join(fixture, "dist")]);
    assert.equal(calls[0].args[3], "s3://kungfu-tech-staging/staging");
    assert.equal(calls[1].args[0], "s3");
    assert.equal(calls[1].args[2], "-");
    assert.match(calls[1].stdin, /"channel": "staging"/);
    assert.deepEqual(calls[2].args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-STAGING",
      "--paths",
      "/staging/*",
      "/.buildchain/deployments/staging.json",
    ]);
    assert.deepEqual(
      result.operations.map((operation) => operation.executed),
      [true, true, true],
    );
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
    assert.equal(calls[0].args[3], "s3://kungfu-tech-staging/staging");
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
      "s3://kungfu-tech-staging",
      "--delete",
      "--exclude",
      ".buildchain/*",
    ]);
    assert.deepEqual(calls[2].args.slice(-2), ["/*", "/.buildchain/deployments/staging.json"]);
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
        .replace('bucket = "kungfu-tech-staging"', 'bucket = "pending-staging-bucket"')
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
      /deploy\.staging\.bucket/,
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

    assert.equal(manifest.url, "https://staging.kungfu.tech");
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

    assert.equal(manifest.url, "https://kungfu.tech");
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
    assert.equal(result.manifestKey, ".buildchain/deployments/production.json");
    assert.equal(calls[0].args[3], "s3://kungfu-tech-production/production");
    assert.deepEqual(calls[2].args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-PRODUCTION",
      "--paths",
      "/production/*",
      "/.buildchain/deployments/production.json",
    ]);
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
    assert.equal(cleanup.entries[0].manifestKey, ".buildchain/deployments/pr-123.json");
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
      ["delete-static-prefix", "delete-deployment-manifest", "invalidate-cdn"],
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
    assert.deepEqual(calls[0].args, ["s3", "rm", "s3://kungfu-tech-preview/pr-123", "--recursive"]);
    assert.deepEqual(calls[1].args, ["s3", "rm", "s3://kungfu-tech-preview/.buildchain/deployments/pr-123.json"]);
    assert.deepEqual(calls[2].args, [
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      "E-PREVIEW",
      "--paths",
      "/pr-123/*",
      "/.buildchain/deployments/pr-123.json",
    ]);
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
      /deploy\.preview\.cloudfront_distribution/,
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
    assert.deepEqual(calls[0].args, ["s3", "rm", "s3://kungfu-tech-preview/pr-456", "--recursive"]);
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

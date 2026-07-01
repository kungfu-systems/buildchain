import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
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

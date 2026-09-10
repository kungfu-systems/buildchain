import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyWebDeployment } from "../packages/core/web/deployment/apply.js";

async function workspace(channel, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-transaction-"));
  try {
    fs.mkdirSync(path.join(root, ".buildchain/downloaded-plans"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        root,
        `.buildchain/downloaded-plans/web-surface-${channel}-plan.json`,
      ),
      JSON.stringify({ channel, proof: "downloaded" }),
    );
    await run({
      workspace: root,
      channel,
      workingDirectory: "site $(literal)",
      actor: "actor",
      runId: "13",
      healthPolicy: {
        allowedManagedNetworkRunner: false,
        managedNetworkS3ObjectVerification: true,
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("production preflight failure prevents deployment and persists the failed readiness evidence", async () =>
  workspace("production", async (request) => {
    const effects = [];
    await assert.rejects(
      applyWebDeployment(request, () => {}, {
        preflight: ({ execute, plan }) => {
          assert.equal(execute, true);
          assert.equal(plan.proof, "downloaded");
          return { status: "failed", checks: [] };
        },
        deploy: () => effects.push("deploy"),
        health: () => effects.push("health"),
      }),
      /readiness preflight/,
    );
    assert.deepEqual(effects, []);
    const read = (name) =>
      JSON.parse(
        fs.readFileSync(
          path.join(
            request.workspace,
            `.buildchain/web-surface-production-${name}.json`,
          ),
        ),
      );
    assert.equal(read("preflight").status, "failed");
    assert.equal(read("execution").preflight.status, "failure");
  }));
test("health failure retains successful apply evidence and waits for CDN readback before probing", async () =>
  workspace("staging", async (request) => {
    const effects = [],
      outputs = {};
    await assert.rejects(
      applyWebDeployment(request, (v) => Object.assign(outputs, v), {
        deploy: ({ cwd, dryRun, plan }) => {
          assert.ok(cwd.endsWith("site $(literal)"));
          assert.equal(dryRun, false);
          assert.equal(plan.proof, "downloaded");
          effects.push("deploy");
          return {
            status: "applied",
            channel: "staging",
            sourceSha: "a".repeat(40),
          };
        },
        wait: () => effects.push("wait"),
        health: () => {
          effects.push("health");
          return { status: "failed", checks: [] };
        },
      }),
      /health check/,
    );
    assert.deepEqual(effects, ["deploy", "wait", "health"]);
    assert.equal(outputs["apply-outcome"], "success");
    assert.equal(
      JSON.parse(outputs["web-surface-apply-result-json"]).status,
      "applied",
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(
            request.workspace,
            ".buildchain/web-surface-staging-health.json",
          ),
        ),
      ).status,
      "failed",
    );
  }));
test("provider failure preserves original exit and cannot proceed to health", async () =>
  workspace("preview", async (request) => {
    const outputs = {};
    await assert.rejects(
      applyWebDeployment(request, (v) => Object.assign(outputs, v), {
        deploy: () => {
          throw Object.assign(new Error("provider failed"), { status: 42 });
        },
        health: () => assert.fail("health after failed apply"),
      }),
      (error) => error.status === 42,
    );
    assert.equal(outputs["apply-outcome"], "failure");
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(
            request.workspace,
            ".buildchain/web-surface-preview-apply.json",
          ),
        ),
      ).status,
      "failed",
    );
  }));
test("cleanup is one destructive domain transaction without invoking deploy or health", async () =>
  workspace("cleanup", async (request) => {
    const effects = [];
    await applyWebDeployment(request, () => {}, {
      cleanup: ({ dryRun }) => {
        assert.equal(dryRun, false);
        effects.push("cleanup");
        return { status: "applied", entries: [] };
      },
      deploy: () => assert.fail("deploy"),
      health: () => assert.fail("health"),
    });
    assert.deepEqual(effects, ["cleanup"]);
  }));

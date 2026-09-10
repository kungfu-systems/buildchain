import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWebDeployment } from "../packages/core/web/deployment/planning.js";
function fixture(t) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "web-plan-transaction-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return {
    workspace,
    request: {
      "working-directory": "site",
      "build-command": "build",
      "verify-command": "verify",
      "artifact-path": "dist",
    },
    runtime: { "runtime-sha": "b".repeat(40), "rollback-ref": "v4" },
    intent: {
      "production-source-sha": "a".repeat(40),
      "production-release-approved": "false",
    },
    selection: { "web-surface-channel": "staging", "web-surface-alias": "" },
    event: { name: "push", payload: {}, actor: "actor", runId: "1" },
  };
}
test("Web planning preserves phase environment updates and explicit channel overrides before freezing the manifest", async (t) => {
  const context = fixture(t),
    calls = [],
    outputs = {};
  const result = await buildWebDeployment(
    context,
    (value) => Object.assign(outputs, value),
    {
      execute: (_, args, { env }) => {
        const script = args.at(-1);
        calls.push(script);
        if (script === "build")
          fs.writeFileSync(
            env.GITHUB_ENV,
            "VALUE=build-value\nBUILDCHAIN_WEB_SURFACE_CHANNEL=production\nBUILDCHAIN_SITE_GENERATED_AT=2026-01-01T00:00:00Z\n",
          );
        else {
          assert.equal(env.VALUE, "build-value");
          assert.equal(env.BUILDCHAIN_WEB_SURFACE_CHANNEL, "staging");
        }
      },
      validate: () => calls.push("validate"),
      plan: (request) => {
        calls.push("plan");
        assert.equal(request.deployedAt, "2026-01-01T00:00:00Z");
        assert.equal(request.runtimeId, context.runtime["runtime-sha"]);
        return {
          channel: request.channel,
          manifest: { sourceSha: request.sourceSha },
        };
      },
    },
  );
  assert.deepEqual(calls, ["build", "verify", "validate", "plan"]);
  assert.equal(result["web-surface-channel"], "staging");
  assert.deepEqual(outputs, {
    "build-outcome": "success",
    "verify-outcome": "success",
  });
});
test("failed consumer build cannot produce a Web plan or claim verification", async (t) => {
  const context = fixture(t),
    outputs = {};
  await assert.rejects(
    buildWebDeployment(context, (value) => Object.assign(outputs, value), {
      consume: () => {
        throw Object.assign(new Error("build failed"), { status: 23 });
      },
      validate: () => assert.fail("validate after failure"),
      plan: () => assert.fail("plan after failure"),
    }),
    (error) => error.status === 23,
  );
  assert.deepEqual(outputs, {
    "build-outcome": "failure",
    "verify-outcome": "skipped",
  });
});
test("planning refuses competing persisted channel results", async (t) => {
  const context = fixture(t);
  context.request["build-command"] = "";
  context.request["verify-command"] = "";
  fs.mkdirSync(path.join(context.workspace, ".buildchain"));
  fs.writeFileSync(
    path.join(context.workspace, ".buildchain/web-surface-preview-plan.json"),
    "{}",
  );
  await assert.rejects(
    buildWebDeployment(context, () => {}, {
      validate: () => {},
      plan: () => ({ channel: "staging" }),
    }),
    /Multiple Web/,
  );
});

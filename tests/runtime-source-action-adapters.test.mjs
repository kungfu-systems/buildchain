import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { reconcileMergeQueueAction } from "../packages/core/dev-delivery/queue/reconciliation-action.js";
import { previewNpmPublicationAction } from "../packages/core/publication/npm/preview-action.js";
import { qualifyRunnerCompatibilityAction } from "../packages/core/build/verification/runner.js";
import {
  buildBinaryDistributionAction,
  qualifyBinaryDistributionAction,
} from "../packages/core/build/binary/actions.js";
import { prepareDemoBinaryAction } from "../packages/core/build/demo/binary-action.js";

function fixture(t) {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "runtime-source-adapter-"),
  );
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  fs.writeFileSync(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "consumer", version: "1.2.3" }),
  );
  git("add", "package.json");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const env = {
    ...process.env,
    GITHUB_WORKSPACE: workspace,
    GITHUB_SHA: git("rev-parse", "HEAD"),
    GITHUB_REPOSITORY: "fixture/consumer",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    BUILDCHAIN_RUNTIME_ROOT: path.resolve(import.meta.dirname, ".."),
    BUILDCHAIN_RUNTIME_SHA: "f".repeat(40),
  };
  const inputs = {
    branch: "dev/v4/v4.1",
    token: "fixture",
    tag: "v4.1.0-alpha.1",
    "matrix-json": JSON.stringify({
      platform: "linux-x64",
      os: "ubuntu-24.04",
    }),
  };
  const core = {
    getInput: (key) => inputs[key],
    getBooleanInput: () => true,
    info() {},
    setOutput() {},
    summary: {
      addHeading() {
        return this;
      },
      addList() {
        return this;
      },
      async write() {},
    },
  };
  return { workspace, env, core };
}

test("queue reconciliation reads consumer policy from a separate source workspace", async (t) => {
  const { workspace, env, core } = fixture(t);
  await reconcileMergeQueueAction(core, env, {
    reconcile: async (request) => {
      assert.equal(request.cwd, workspace);
      assert.equal(request.repository, "fixture/consumer");
      assert.equal(request.apply, true);
      return {
        policyResolution: { mode: "inherit" },
        action: "noop",
        applied: false,
      };
    },
  });
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(workspace, ".buildchain-dev-merge-queue.json")),
    ).action,
    "noop",
  );
});
test("npm preview verifies and packs the consumer from the selected runtime adapter", (t) => {
  const { workspace, env, core } = fixture(t),
    calls = [];
  previewNpmPublicationAction(core, env, {
    verify: (request) => {
      assert.equal(request.workspace, workspace);
      calls.push("verify");
    },
    preview: (request) => {
      assert.equal(request.cwd, workspace);
      calls.push("pack");
      return {
        package: { name: "consumer", version: "1.2.3" },
        pack: { entryCount: 1 },
      };
    },
  });
  assert.deepEqual(calls, ["verify", "pack"]);
});
test("runner qualification keeps consumer source identity with independent runtime code", async (t) => {
  const { workspace, env, core } = fixture(t);
  const report = await qualifyRunnerCompatibilityAction(core, env, {
    execute: (program, args, options) => {
      assert.equal(program, "pnpm");
      assert.deepEqual(args, ["run", "check"]);
      assert.equal(options.cwd, workspace);
    },
    collect: (request) => {
      assert.equal(request.sourceSha, env.GITHUB_SHA);
      assert.equal(request.cwd, workspace);
      return { checkReport: { ok: true } };
    },
    verify: async () => ({ ok: true }),
  });
  assert.equal(report.ok, true);
});
test("binary build and passport adapters accept separate source and reject source drift", async (t) => {
  const { workspace, env, core } = fixture(t);
  await buildBinaryDistributionAction(core, env, {
    build: async (request) => {
      assert.equal(request.workspace, workspace);
      assert.equal(request.tag, "v4.1.0-alpha.1");
    },
  });
  await qualifyBinaryDistributionAction(core, env, {
    qualify: async (request) => {
      assert.equal(request.workspace, workspace);
      assert.equal(request.sourceSha, env.GITHUB_SHA);
    },
  });
  const changed = { ...env, GITHUB_SHA: "0".repeat(40) };
  await assert.rejects(
    buildBinaryDistributionAction(core, changed),
    /exact checked-out source/,
  );
  await assert.rejects(
    qualifyBinaryDistributionAction(core, changed),
    /exact checked-out source/,
  );
});
test("demo binary executes selected implementation while preserving exact source and smoke paths", (t) => {
  const { workspace, env, core } = fixture(t),
    calls = [];
  prepareDemoBinaryAction(core, env, {
    build: (request) => {
      assert.equal(request.cwd, workspace);
      calls.push("build");
    },
    smoke: (request) => {
      assert.equal(
        request.artifactRoot,
        path.join(workspace, "dist/auditable-demo-binary"),
      );
      calls.push("smoke");
    },
  });
  assert.deepEqual(calls, ["build", "smoke"]);
  assert.throws(
    () => prepareDemoBinaryAction(core, { ...env, GITHUB_SHA: "0".repeat(40) }),
    /exact checked-out source/,
  );
});

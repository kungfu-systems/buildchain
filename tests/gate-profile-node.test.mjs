import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { resolveGateRuntime } from "../packages/core/build/nodes/gate-runtime.mjs";
import {
  resetGateWorkspace,
  windowsRustPlan,
  setupWindowsRust,
} from "../packages/core/providers/nodes/gate-toolchain.mjs";
const sha = "a".repeat(40);
const env = {
  BUILDCHAIN_REPOSITORY: "kungfu-systems/buildchain",
  BUILDCHAIN_WORKFLOW_SHA: sha,
};
const context = {
  eventName: "pull_request",
  repo: { owner: "consumer", repo: "project" },
  actor: "maintainer",
};
test("Gate defaults to the defining commit without a legacy or mutable fallback", async () => {
  const outputs = {};
  await resolveGateRuntime({
    env,
    context,
    github: {},
    core: { setOutput: (k, v) => (outputs[k] = v) },
  });
  assert.deepEqual(outputs, { "runtime-ref": sha, "runtime-sha": sha });
  await assert.rejects(
    resolveGateRuntime({
      env: { ...env, BUILDCHAIN_WORKFLOW_SHA: "" },
      context,
    }),
    /exact defining/,
  );
  await assert.rejects(
    resolveGateRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "v3" },
      context,
    }),
    /current channel/,
  );
});
test("Gate overrides require trusted dispatch permissions and resolve to commit objects", async () => {
  const requested = "train/v4/v4.1/gate";
  await assert.rejects(
    resolveGateRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: requested },
      context,
    }),
    /workflow_dispatch/,
  );
  const dispatch = { ...context, eventName: "workflow_dispatch" };
  const api = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: "read" },
        }),
      },
    },
  };
  await assert.rejects(
    resolveGateRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: requested },
      context: dispatch,
      github: api,
    }),
    /write permission/,
  );
  api.rest.repos.getCollaboratorPermissionLevel = async () => ({
    data: { permission: "write" },
  });
  api.rest.repos.getCommit = async ({ ref }) => {
    assert.equal(ref, requested);
    return { data: { sha: "b".repeat(40) } };
  };
  const outputs = {};
  await resolveGateRuntime({
    env: { ...env, BUILDCHAIN_REQUESTED_REF: requested },
    context: dispatch,
    github: api,
    core: { setOutput: (k, v) => (outputs[k] = v) },
  });
  assert.equal(outputs["runtime-sha"], "b".repeat(40));
  api.rest.repos.getCommit = async () => {
    throw Object.assign(new Error("denied"), { status: 403 });
  };
  await assert.rejects(
    resolveGateRuntime({
      env: { ...env, BUILDCHAIN_REQUESTED_REF: "v4-alpha" },
      context,
      github: api,
    }),
    (e) => e.status === 403,
  );
});
test("Gate source reset preserves only Git metadata and refuses junction escapes", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reset-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "source");
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  fs.writeFileSync(path.join(source, ".git", "HEAD"), "fixture");
  fs.writeFileSync(path.join(source, "residue"), "remove");
  resetGateWorkspace({ GITHUB_WORKSPACE: cwd });
  assert.deepEqual(fs.readdirSync(source), [".git"]);
  assert.equal(
    fs.readFileSync(path.join(source, ".git", "HEAD"), "utf8"),
    "fixture",
  );
  fs.renameSync(source, path.join(cwd, "other"));
  fs.symlinkSync(path.join(cwd, "other"), source, "junction");
  assert.throws(
    () => resetGateWorkspace({ GITHUB_WORKSPACE: cwd }),
    /symbolic links/,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "other", ".git", "HEAD"), "utf8"),
    "fixture",
  );
});
test("Windows Rust setup preserves literal argv and publishes environment only after success", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-rust-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const input = {
    RUNNER_TEMP: cwd,
    GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "3",
    BUILDCHAIN_RUST_TOOLCHAIN: "stable",
    GITHUB_PATH: path.join(cwd, "path"),
    GITHUB_ENV: path.join(cwd, "env"),
  };
  const plan = windowsRustPlan(input);
  assert.ok(plan.install.includes("--no-modify-path"));
  assert.ok(plan.download.includes("--fail"));
  assert.ok(plan.download.includes("https://win.rustup.rs/x86_64"));
  assert.throws(
    () =>
      setupWindowsRust(input, () => {
        throw Object.assign(new Error("download failed"), { status: 28 });
      }),
    (e) => e.status === 28,
  );
  assert.equal(fs.existsSync(input.GITHUB_ENV), false);
  const calls = [];
  setupWindowsRust(input, (...args) => calls.push(args));
  assert.equal(calls[1][2].env.CARGO_HOME, plan.cargo);
  assert.match(
    fs.readFileSync(input.GITHUB_ENV, "utf8"),
    /CARGO_HOME=.*buildchain-gate-cargo-12-3/,
  );
});
test("Gate nodes bind core Node before consumer toolchain selection and retain diagnostics on failure", () => {
  for (const stage of ["plan", "run-gates", "aggregate"]) {
    const action = YAML.parse(
      fs.readFileSync(`actions/build/gate-profile-${stage}/action.yml`, "utf8"),
    );
    const steps = action.runs.steps;
    assert.ok(
      steps.findIndex((s) => s.id === "core-runtime") <
        steps.findIndex((s) => s.name === "Setup Node.js"),
    );
    for (const step of steps.filter(
      (s) => s.run?.includes("packages/core/") || s.run?.includes("node -e"),
    )) {
      assert.ok(step.run.startsWith('"$BUILDCHAIN_NODE"'));
      assert.match(step.env.BUILDCHAIN_NODE, /outputs.node-path/);
    }
    if (stage === "run-gates")
      assert.match(
        steps.find((s) => s.name === "Upload locked checkout diagnostics").if,
        /always/,
      );
  }
});

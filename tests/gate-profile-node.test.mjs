import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { resetSourceWorktree } from "../packages/core/providers/source-checkout/workspace.js";
import { prepareWindowsRust } from "../packages/core/runtime/toolchain/windows-rust.js";
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
test("Gate source reset preserves only Git metadata and refuses junction escapes", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-reset-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const source = path.join(cwd, "source");
  fs.mkdirSync(path.join(source, ".git"), { recursive: true });
  fs.writeFileSync(path.join(source, ".git", "HEAD"), "fixture");
  fs.writeFileSync(path.join(source, "residue"), "remove");
  resetSourceWorktree({ workspace: cwd, checkoutPath: "source" });
  assert.deepEqual(fs.readdirSync(source), [".git"]);
  assert.equal(
    fs.readFileSync(path.join(source, ".git", "HEAD"), "utf8"),
    "fixture",
  );
  fs.renameSync(source, path.join(cwd, "other"));
  fs.symlinkSync(path.join(cwd, "other"), source, "junction");
  assert.throws(
    () => resetSourceWorktree({ workspace: cwd, checkoutPath: "source" }),
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
  const input = { runnerTemp: cwd, toolchain: "stable", environment: {}, platform: "win32" };
  assert.throws(() => prepareWindowsRust(input, () => { throw Object.assign(new Error("download failed"), { status: 28 }); }), e => e.status === 28);
  const calls = [];
  const prepared = prepareWindowsRust(input, (...args) => calls.push(args));
  assert.ok(calls[0][1].includes("--fail"));
  assert.ok(calls[0][1].includes("https://win.rustup.rs/x86_64"));
  assert.ok(calls[1][1].includes("--no-modify-path"));
  assert.equal(calls[1][2].env.CARGO_HOME, prepared.variables.CARGO_HOME);
  assert.ok(prepared.variables.CARGO_HOME.startsWith(cwd + path.sep));
  assert.deepEqual(prepared.paths, [path.join(prepared.variables.CARGO_HOME, "bin")]);

});
test("Gate nodes bind core Node before consumer toolchain selection and retain diagnostics on failure", () => {
  for (const stage of ["plan", "run-gates", "aggregate"]) {
    const action = YAML.parse(
      fs.readFileSync(`actions/build/gate/${stage === "run-gates" ? "execute" : stage}/action.yml`, "utf8"),
    );
    const steps = action.runs.steps;
    assert.ok(
      steps.findIndex((s) => s.id === "core-runtime") <
        steps.findIndex((s) => s.name === "Setup Node.js"),
    );
    for (const step of steps) {
      assert.ok(step.uses, "Composite steps must invoke actions");
      assert.equal(step.run, undefined);
      assert.equal(step.shell, undefined);
    }
    if (stage === "run-gates")
      assert.match(
        steps.find((s) => s.name === "Upload locked checkout diagnostics").if,
        /always/,
      );
  }
});

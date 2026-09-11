import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { sealBuildCheckpoint, restoreBuildCheckpoint } from "../packages/core/build/recovery/checkpoint.js";
import { resolveRecoverySource } from "../packages/core/runtime/entry/recovery.js";

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "build-runtime-recovery-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const sourceRoot = path.join(workspace, "producer");
  const output = "out/product.bin";
  fs.mkdirSync(path.join(sourceRoot, "out"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, output), "retained build output", {mode: 0o755});
  const plan = { run: { repository: "consumer/project", id: "111", attempt: "1" }, source: { sha: "a".repeat(40), tree_sha: "b".repeat(40) }, configuration_root: "config", project: { cwd: "." }, lifecycle: { build: { command: "build" } }, tools: { node: "24" }, environment: {}, artifacts: { paths: "out" }, runtime: { sha: "c".repeat(40) } };
  const platform = { id: "linux-x64" };
  const file = path.join(sourceRoot, ".buildchain/artifacts/linux-x64/manifest-build.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ contract: "kungfu-buildchain-artifact", platform, git: { sha: plan.source.sha, treeSha: plan.source.tree_sha, repository: plan.run.repository }, files: [{ path: output, sha256: crypto.createHash("sha256").update("retained build output").digest("hex") }] }));
  const sealed = sealBuildCheckpoint({ plan, platform, sourceRoot });
  assert.ok(sealed);
  const current = structuredClone(plan);
  current.run.id = "222";
  current.runtime.sha = "d".repeat(40);
  current.recovery = { runId: "111" };
  const fresh = path.join(workspace, "fresh");
  fs.mkdirSync(fresh);
  return { current, platform, retainedRoot: sourceRoot, sourceRoot: fresh, output };
}

test("a new execution using runtime Y restores the valid build from runtime X", t => {
  const f = fixture(t);
  const result = restoreBuildCheckpoint({ ...f, plan: f.current });
  assert.equal(result.stage, "build");
  assert.equal(result.producer.id, "111");
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, f.output), "utf8"), "retained build output");
});

for (const field of ["source", "configuration", "toolchain", "platform", "producer", "bytes"]) test(`recovery rejects changed ${field} before restoring any output`, t => {
  const f = fixture(t);
  if (field === "source") f.current.source.sha = "e".repeat(40);
  if (field === "configuration") f.current.configuration_root = "changed";
  if (field === "toolchain") f.current.tools.node = "26";
  if (field === "platform") f.platform.id = "windows-x64";
  if (field === "producer") f.current.recovery.runId = "333";
  if (field === "bytes") fs.writeFileSync(path.join(f.retainedRoot, f.output), "changed");
  assert.throws(() => restoreBuildCheckpoint({ ...f, plan: f.current }));
  assert.deepEqual(fs.readdirSync(f.sourceRoot), []);
});

test("entry recovery uses the original failed run source and refuses a fork or active run", async () => {
  const request = { repository: "consumer/project", runId: "111", currentRunId: "222" };
  const run = { id: 111, run_attempt: 2, repository: { full_name: request.repository }, head_repository: { full_name: request.repository }, head_sha: "a".repeat(40), head_branch: "dev", path: ".github/workflows/build.yml", status: "completed", conclusion: "failure" };
  assert.equal((await resolveRecoverySource(request, async () => run)).sha, run.head_sha);
  await assert.rejects(resolveRecoverySource(request, async () => ({ ...run, head_repository: { full_name: "fork/project" } })), /fork/u);
  await assert.rejects(resolveRecoverySource(request, async () => ({ ...run, status: "in_progress" })), /unsuccessful/u);
  await assert.rejects(resolveRecoverySource({ ...request, runId: "222" }, async () => assert.fail()), /different/u);
});

for (const broken of [false, true]) test(`recovery rejects ${broken ? "broken" : "live"} destination symlinks before writing`, t => {
  const f = fixture(t);
  const outside = path.join(f.retainedRoot, "outside");
  if (!broken) fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.sourceRoot, "out"), "junction");
  assert.throws(() => restoreBuildCheckpoint({...f, plan: f.current}), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, "product.bin")), false);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, ".buildchain")), false);
});
test("recovery preserves executable output modes", {skip: process.platform === "win32"}, t => {
  const f = fixture(t);
  restoreBuildCheckpoint({...f, plan: f.current});
  assert.equal(fs.statSync(path.join(f.sourceRoot, f.output)).mode & 0o777, 0o755);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import artifact from "@actions/artifact";

const repo = path.resolve(import.meta.dirname, "..");

test("real lifecycle artifacts survive transfer and isolated finalization; provider failures cannot qualify", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-pipeline-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const gitConfig = path.join(workspace, "empty.gitconfig");
  fs.writeFileSync(gitConfig, "");
  const source = path.join(workspace, "source");
  fs.cpSync(path.join(repo, "fixtures/libnode-shaped"), source, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig,
  } }).trim();
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  const previous = { ...process.env };
  Object.assign(process.env, { GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: "test/project",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "sign", RUNNER_OS: "Linux",
    GITHUB_OUTPUT: path.join(workspace, "outputs") });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const { resolveBuildConfiguration } = await import("../packages/core/build/plan/configuration.js");
  const { resolveRunnerMatrix } = await import("../packages/core/build/runner/matrix.js");
  const { buildMatrices } = await import("../packages/core/build/plan/matrices.js");
  const { rootOf } = await import("../packages/core/build/plan/values.js");
  const { createBuildArtifactServices } = await import("../packages/core/build/artifact/services.js");
  const { createBuildSigningService } = await import("../packages/core/build/signing/transaction.js");
  const { runLifecycle } = await import("../packages/core/build/lifecycle/transaction.js");
  const { createBuildFinalizationService } = await import("../packages/core/build/summary/finalization.js");
  const { createControllerPlan } = await import("../packages/core/observability/controller-evidence.js");
  const { artifactNames } = await import("../packages/core/build/artifact/contracts.js");
  const { plan } = resolveBuildConfiguration({ root: source, repository: "kungfu-systems/buildchain",
    workflowRef: "kungfu-systems/buildchain/.github/workflows/build.yml@v4-alpha", workflowSha: "a".repeat(40),
    sourceSha: git("rev-parse", "HEAD"), sourceRef: "refs/heads/dev/v4/v4.0" });
  plan.source.tree_sha = git("rev-parse", "HEAD^{tree}");
  plan.run = { repository: "test/project", id: "123", attempt: "1" };
  plan.transfer = { mode: "github-artifacts" };
  Object.assign(plan, buildMatrices(plan, resolveRunnerMatrix({ runnerPreset: "github-hosted" })));
  const platform = plan.platforms[0];
  plan.platforms = [platform];
  plan.matrix.native = [platform];
  plan.matrix.sign = plan.matrix.sign.slice(0, 1);
  plan.anchored_material = { target_channel: "none", target_ref: "" };
  plan.source.release = { ref: plan.source.ref, channel: "none", line: "", version: "1.0.0", locked: true, manifest: {} };
  plan.build.artifacts.release_candidate = false;
  const registry = JSON.parse(fs.readFileSync(path.join(repo, "dist/site/controller-registry.json")));
  plan.controller = createControllerPlan({ descriptor: registry.controllers.find((c) => c.id === "build-lifecycle"),
    source: { repository: plan.run.repository, sha: plan.source.sha },
    runtime: { ref: plan.identity.ref, sha: plan.identity.sha, contractDigest: `sha256:${"b".repeat(64)}` },
    inputs: { "configuration-root": plan.configuration_root } });
  plan.root = rootOf(plan);
  Object.assign(process.env, { BUILDCHAIN_PLAN: JSON.stringify(plan), BUILDCHAIN_PLATFORM: JSON.stringify(platform) });
  for (const stage of ["install", "build", "verify"]) {
    const run = spawnSync(process.execPath, [path.join(repo, "tests/helpers/build-stage-process.mjs")], {
      cwd: workspace, encoding: "utf8", env: { ...process.env, BUILDCHAIN_STAGE: stage },
    });
    assert.equal(run.status, 0, `${stage}\n${run.stdout}\n${run.stderr}`);
  }
  const objects = new Map();
  let providerFailure = false;
  let digestMismatch = false;
  t.mock.method(artifact, "uploadArtifact", async (name, files, root) => {
    if (providerFailure) throw new Error("provider unavailable");
    const entries = files.map((file) => ({ path: path.relative(root, file), bytes: fs.readFileSync(file) }));
    const digest = crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    const item = { id: objects.size + 1, name, digest, entries };
    objects.set(item.id, item);
    return { id: item.id, digest };
  });
  // SDK upload returns bare hex; provider listing and download comparison use sha256-prefixed digests.
  t.mock.method(artifact, "listArtifacts", async () => ({ artifacts: [...objects.values()].map(item => ({ ...item, digest: `sha256:${item.digest}` })) }));
  t.mock.method(artifact, "downloadArtifact", async (id, options) => {
    const item = objects.get(id);
    assert.ok(item, `unknown immutable artifact ${id}`);
    assert.equal(options.expectedHash, `sha256:${item.digest}`);
    for (const entry of item.entries) {
      const file = path.join(options.path, entry.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.bytes);
    }
    return { digestMismatch };
  });
  const services = createBuildArtifactServices({ plan, workspace, sourceRoot: source }, { token: "test-token" });
  const { transferBuild, downloadBuild, loadFinalArtifact } = services;
  const { controlSigning, finalizeSigning } = createBuildSigningService({ plan, platform, workspace, sourceRoot: source, services, controller: { job: "sign", runnerOs: "Linux" }, consumerEnvironment: process.env }, { executeLifecycle: runLifecycle });
  await transferBuild(platform);
  const names = artifactNames(plan, platform);
  assert.ok([...objects.values()].some((item) => item.name === names.execution));
  await controlSigning();
  // A fresh source directory models the separate finalization job: no producer
  // files may mask missing transport data.
  fs.rmSync(source, { recursive: true });
  fs.mkdirSync(source);
  await finalizeSigning();
  const final = await loadFinalArtifact(platform, path.join(workspace, "final-readback"));
  assert.equal(final.result.state, "unsigned");
  assert.equal(final.result.payload.name, names.final);
  assert.equal(final.manifest.artifactName, names.final);
  assert.ok(final.manifest.files.some((entry) => entry.path === "dist/libnode-shaped.txt"));
  assert.equal(final.result.controller.qualifying, true);
  const { finalizeBuild } = createBuildFinalizationService({ plan, workspace, services, workflow: { name: "Build", serverUrl: "https://github.com" } }, {
    readProviderArtifacts: async () => [...objects.values()].map(item => ({ ...item, digest: `sha256:${item.digest}`, expired: false, expires_at: "2099-01-01T00:00:00Z", size_in_bytes: 100 })) });
  const originalCwd = process.cwd();
  process.chdir(workspace);
  try {
    process.env.BUILDCHAIN_JOBS = JSON.stringify({ "build-native": { result: "success" }, "build-container": { result: "skipped" },
      sign: { result: "success" }, attest: { result: "skipped" } });
    await finalizeBuild(JSON.parse(process.env.BUILDCHAIN_JOBS));
    const result = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/result/record.json")));
    assert.equal(result.status, "success");
    assert.equal(result.artifacts.payloads[0].id, final.result.payload.id);
    const receipt = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/controller/receipt.json")));
    assert.equal(receipt.qualifying, true);
    const failedJobs = JSON.parse(process.env.BUILDCHAIN_JOBS);
    failedJobs.sign.result = "failure";
    process.env.BUILDCHAIN_JOBS = JSON.stringify(failedJobs);
    await assert.rejects(finalizeBuild(JSON.parse(process.env.BUILDCHAIN_JOBS)), /Build job sign/);
    const failedReceipt = JSON.parse(fs.readFileSync(path.join(workspace, ".buildchain/controller/receipt.json")));
    assert.equal(failedReceipt.qualifying, false);
    assert.equal(failedReceipt.stages.find((stage) => stage.id === "build").status, "passed");
  } finally { process.chdir(originalCwd); }
  digestMismatch = true;
  await assert.rejects(downloadBuild(platform, path.join(workspace, "corrupt")), /digest mismatch/);
  digestMismatch = false;
  providerFailure = true;
  await assert.rejects(finalizeSigning(), /provider unavailable/);
});

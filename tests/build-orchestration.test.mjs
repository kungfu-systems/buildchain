import { sealBuildCheckpoint } from "../packages/core/build/recovery/checkpoint.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { resolveBuildConfiguration } from "../packages/core/build/plan/configuration.js";
import { resolveRunnerMatrix } from "../packages/core/build/runner/matrix.js";
import { buildMatrices } from "../packages/core/build/plan/matrices.js";
import { assertPlan } from "../packages/core/build/plan/identity.js";
import { rootOf } from "../packages/core/build/plan/values.js";
import { assertStageOrder } from "../packages/core/build/plan/stage-order.js";
import { assertJobResults } from "../packages/core/build/summary/execution.js";
import { artifactNames, executionResult, verifyExecution, verifyManifest } from "../packages/core/build/artifact/contracts.js";
import { validateReference } from "../packages/core/build/artifact/contracts.js";

const repo = path.resolve(import.meta.dirname, "..");
function fixture(t, nested = false) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-backbone-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const gitConfig = path.join(workspace, "empty.gitconfig");
  fs.writeFileSync(gitConfig, "");
  const source = path.join(workspace, "source");
  fs.mkdirSync(source);
  const directory = nested ? path.join(source, "packages/library") : source;
  fs.cpSync(path.join(repo, "fixtures/libnode-shaped"), directory, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig } }).trim();
  git("init", "--quiet"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture");
  const { plan } = resolveBuildConfiguration({ root: source, locator: nested ? "packages/library/buildchain.toml" : "", repository: "kungfu-systems/buildchain",
    workflowRef: "kungfu-systems/buildchain/.github/workflows/build.yml@v4-alpha", workflowSha: "a".repeat(40), sourceSha: git("rev-parse", "HEAD"), sourceRef: "refs/heads/dev/v4/v4.0" });
  plan.source.tree_sha = git("rev-parse", "HEAD^{tree}");
  plan.run = { repository: "test/project", id: "123", attempt: "1" };
  plan.transfer = { mode: "github-artifacts" };
  Object.assign(plan, buildMatrices(plan, resolveRunnerMatrix({ runnerPreset: "github-hosted", linuxContainerPreset: "kungfu-verify" })));
  plan.root = rootOf(plan);
  return { workspace, source, directory, plan, platform: plan.platforms[0] };
}

test("rooted plans and producer references reject changed identity and content", (t) => {
  const { plan, platform } = fixture(t);
  assert.equal(assertPlan(plan), plan);
  const tampered = structuredClone(plan); tampered.build.artifacts.name = "changed";
  assert.throws(() => assertPlan(tampered), /root mismatch/);
  const names = artifactNames(plan, platform);
  assert.notEqual(names.payload, names.final);
  const ref = { schema: "buildchain.build-artifact/v1", repository: plan.run.repository, run_id: plan.run.id, plan_root: plan.root, source_sha: plan.source.sha, name: names.final, id: 7, digest: "b".repeat(64) };
  ref.root = rootOf(ref);
  assert.equal(validateReference(ref, plan, names.final), ref);
  assert.throws(() => validateReference({ ...ref, id: 8 }, plan), /Invalid producer/);
  assert.throws(() => validateReference(ref, plan, names.payload), /Invalid producer/);
  const good = executionResult(plan, platform, { install: "success", build: "success", verify: "success" });
  assert.equal(verifyExecution(good, plan, platform), good);
  assert.throws(() => verifyExecution(executionResult(plan, platform, { install: "success", build: "success", verify: "failure" }), plan, platform), /Nonqualifying/);
  assert.throws(() => verifyExecution(good, { ...plan, root: "changed" }, platform), /identity mismatch/);
});

test("placement and finalization reject incomplete or failed jobs", (t) => {
  const { plan } = fixture(t);
  assert.equal(plan.matrix.container.length, 1);
  assert.equal(plan.matrix.native.length, 2);
  assert.equal(plan.matrix.sign.length, 3);
  assert.ok(plan.matrix.sign.every((lane) => lane.runner[0] === "ubuntu-24.04"));
  assert.throws(() => assertStageOrder({}, "verify"), /Missing successful install/);
  assert.throws(() => assertStageOrder({ install: "success", build: "failure" }, "verify"), /Missing successful build/);
  assert.throws(() => assertStageOrder({ install: "success" }, "install"), /repeated/);
  const jobs = { "build-native": { result: "success" }, "build-container": { result: "success" }, sign: { result: "success" }, attest: { result: "skipped" } };
  assert.doesNotThrow(() => assertJobResults(jobs, plan));
  for (const result of ["skipped", "failure", "cancelled"]) assert.throws(() => assertJobResults({ ...jobs, sign: { result } }, plan), /Build job sign/);
});

for (const nested of [false, true]) test(`real ordered lifecycle and digest validation for ${nested ? "nested" : "root"} project`, (t) => {
  const { workspace, source, directory, plan, platform } = fixture(t, nested);
  platform.environment = { BUILDCHAIN_FIXTURE_ENV: "governed-value" };
  fs.appendFileSync(path.join(directory, "scripts/install.mjs"), '\nif (process.env.BUILDCHAIN_FIXTURE_ENV !== "governed-value") throw new Error("Governed runner environment was lost");\n');
  delete plan.root;
  plan.root = rootOf(plan);
  const run = (stage) => spawnSync(process.execPath, [path.join(repo, "tests/helpers/build-stage-process.mjs")], { cwd: workspace, encoding: "utf8",
    env: { ...process.env, GITHUB_WORKSPACE: workspace, GITHUB_REPOSITORY: plan.run.repository, GITHUB_RUN_ID: plan.run.id, GITHUB_RUN_ATTEMPT: plan.run.attempt,
      GITHUB_OUTPUT: path.join(workspace, "outputs"), BUILDCHAIN_PLAN: JSON.stringify(plan), BUILDCHAIN_PLATFORM: JSON.stringify(platform), BUILDCHAIN_STAGE: stage } });
  for (const stage of ["install", "build", "verify"]) {
    const result = run(stage);
    assert.equal(result.status, 0, `${stage}\n${result.stdout}\n${result.stderr}`);
  }
  const record = JSON.parse(fs.readFileSync(path.join(source, `.buildchain/execution/${platform.id}.json`)));
  assert.equal(verifyExecution(record, plan, platform).stages.verify, "success");
  const manifest = path.join(source, `.buildchain/artifacts/${platform.id}/manifest.json`);
  assert.ok(verifyManifest(manifest, source, plan, platform).files.length >= 2);
  fs.appendFileSync(path.join(directory, "dist/install.txt"), "tampered");
  assert.throws(() => verifyManifest(manifest, source, plan, platform), /digest mismatch/);
  assert.notEqual(run("verify").status, 0, "Repeated verify must not overwrite evidence");
});


test("runtime Y restores X build outputs in a fresh execution and runs remaining verification", t => {
  const { workspace, source, directory, plan, platform } = fixture(t);
  plan.runtime = { sha: "a".repeat(40) };
  const buildScript = path.join(directory,"scripts/build.mjs");
  fs.appendFileSync(buildScript, '\nif (process.env.BUILDCHAIN_TEST_RETAINED) throw Error("Build must not repeat");\n');
  const verifyScript = path.join(directory,"scripts/verify.mjs");
  fs.appendFileSync(verifyScript, '\nif (!process.env.BUILDCHAIN_TEST_RETAINED) throw Error("Injected runtime X verification fault");\nfs.writeFileSync("verified-by-y.txt","verified");\n');
  const run = (stage, retained = "") => spawnSync(process.execPath, [path.join(repo,"tests/helpers/build-stage-process.mjs")], {cwd:workspace,encoding:"utf8",env:{...process.env,GITHUB_WORKSPACE:workspace,GITHUB_REPOSITORY:plan.run.repository,GITHUB_RUN_ID:plan.run.id,GITHUB_RUN_ATTEMPT:plan.run.attempt,GITHUB_OUTPUT:path.join(workspace,"outputs"),BUILDCHAIN_PLAN:JSON.stringify(plan),BUILDCHAIN_PLATFORM:JSON.stringify(platform),BUILDCHAIN_STAGE:stage,BUILDCHAIN_TEST_RETAINED:retained}});
  for(const stage of ["install","build"]){const r=run(stage);assert.equal(r.status,0,r.stderr);}
  const sealed=sealBuildCheckpoint({plan,platform,sourceRoot:source});assert.ok(sealed);
  const failed=run("verify");assert.notEqual(failed.status,0);assert.match(failed.stderr,/Injected runtime X/);
  const retained=path.join(workspace,"retained");
  for(const relative of sealed.paths){const to=path.join(retained,relative);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(source,relative),to);}
  fs.rmSync(path.join(source,"dist"),{recursive:true});
  fs.rmSync(path.join(source,".buildchain"),{recursive:true});
  plan.recovery={runId:plan.run.id};plan.run={...plan.run,id:"456"};plan.runtime={sha:"b".repeat(40)};delete plan.root;plan.root=rootOf(plan);
  for(const stage of ["install","build","verify"]){const r=run(stage,retained);assert.equal(r.status,0,`${stage}\n${r.stdout}\n${r.stderr}`);}
  assert.equal(fs.readFileSync(path.join(source,"verified-by-y.txt"),"utf8"),"verified");
  const record=JSON.parse(fs.readFileSync(path.join(source,`.buildchain/execution/${platform.id}.json`)));
  assert.equal(verifyExecution(record,plan,platform).stages.verify,"success");
});

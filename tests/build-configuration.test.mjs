import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverBuildConfiguration, normalizeBuildConfiguration } from "../packages/core/build-configuration.js";
import { resolveBuildConfiguration } from "../scripts/resolve-build-configuration.mjs";
import { selectReleaseCandidateArtifacts } from "../scripts/release-candidate-resolver.mjs";
import { loadBuildchainConfig } from "../packages/core/buildchain-config.js";

function fixture(t, relative = "buildchain.toml", extra = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-config-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), `schema = 1\n[lifecycle.install]\ncommand = "install"\n[lifecycle.build]\ncommand = "build"\n[lifecycle.verify]\ncommand = "verify"\n${extra}`);
  return root;
}
function resolve(root, overrides = {}) {
  return resolveBuildConfiguration({ root, repository: "kungfu-systems/buildchain", workflowRef: "kungfu-systems/buildchain/.github/workflows/build.yml@v4-alpha", workflowSha: "a".repeat(40), sourceSha: "b".repeat(40), sourceRef: "refs/heads/dev/v4/v4.0", ...overrides });
}

test("root verification declares Go and Rust prerequisites", () => {
  const { config } = loadBuildchainConfig(process.cwd());
  assert.ok(config.build.tools.go, "workflow lint needs a configured Go toolchain");
  const commands = config.lifecycle.verify.commands;
  assert.ok(commands.includes(`rustup component add --toolchain ${config.build.tools.rust} rustfmt clippy`));
  assert.ok(commands.indexOf(`rustup component add --toolchain ${config.build.tools.rust} rustfmt clippy`) < commands.indexOf("corepack pnpm@11.7.0 run check"));
});

test("zero-input discovery binds lifecycle, configuration bytes and exact runtime", (t) => {
  const root = fixture(t, ".buildchain/buildchain.toml");
  const resolved = resolve(root);
  assert.equal(resolved.plan.project.cwd, ".");
  assert.equal(resolved.plan.identity.channel, "alpha");
  assert.equal(resolved.plan.contract.lock_path, ".buildchain/alpha-contract-lock.json");
  assert.deepEqual(Object.keys(resolved.plan.lifecycle), ["install", "build", "verify"]);
  assert.equal(resolved.root, resolve(root).root);
  assert.notEqual(resolved.root, resolve(root, { sourceSha: "c".repeat(40) }).root);
  fs.appendFileSync(path.join(root, ".buildchain/buildchain.toml"), "\n# a reviewed change\n");
  assert.notEqual(resolved.root, resolve(root).root);
});

test("optional Go setup derives from TOML and changes the toolchain root", (t) => {
  const root = fixture(t);
  const before = resolve(root).plan;
  assert.equal(before.tools.setup_go, false);
  fs.appendFileSync(path.join(root, "buildchain.toml"), '\n[build.tools]\ngo = "1.25.x"\n');
  const after = resolve(root).plan;
  assert.equal(after.tools.go, "1.25.x");
  assert.equal(after.tools.setup_go, true);
  assert.notEqual(after.cache.toolchain_root, before.cache.toolchain_root);
  fs.writeFileSync(path.join(root, "go.sum"), "example.com/library v1.0.0 h1:first\n");
  const dependencyRoot = resolve(root).plan.cache.dependency_root;
  assert.notEqual(dependencyRoot, after.cache.dependency_root);
  fs.appendFileSync(path.join(root, "go.sum"), "example.com/library v1.1.0 h1:second\n");
  assert.notEqual(resolve(root).plan.cache.dependency_root, dependencyRoot);
  assert.throws(() => normalizeBuildConfiguration({ tools: { go: true } }));
  const action = fs.readFileSync("actions/prepare-build-environment/action.yml", "utf8");
  assert.match(action, /inputs.tools == 'true' && fromJSON\(inputs.plan\).tools.setup_go/u);
  assert.match(action, /uses: actions\/setup-go@/u);
  assert.match(action, /go-version: \$\{\{ fromJSON\(inputs.plan\).tools.go \}\}/u);
  assert.match(action, /cache: false/u);
});

test("one locator selects a nested project and paths stay relative to that project", (t) => {
  const root = fixture(t, "packages/a/.buildchain/buildchain.toml", '[build.artifacts]\npaths = ["output"]\nrequired_paths = ["binary"]\n');
  assert.throws(() => resolve(root), /Expected one/);
  const { plan } = resolve(root, { locator: "packages/a/.buildchain/buildchain.toml" });
  assert.equal(plan.project.cwd, "packages/a");
  assert.equal(plan.artifacts.paths, "packages/a/output");
  assert.deepEqual(JSON.parse(plan.artifacts.expected_json).requiredPaths, ["packages/a/binary"]);
  for (const invalid of ["/tmp/output", "../output"]) {
    fs.writeFileSync(path.join(root, "packages/a/.buildchain/buildchain.toml"), `schema = 1\n[lifecycle.build]\ncommand = "build"\n[build.artifacts]\npaths = [${JSON.stringify(invalid)}]\n`);
    assert.throws(() => resolve(root, { locator: "packages/a/.buildchain/buildchain.toml" }), /repository-relative/);
  }
});

test("candidate publication derives intent from source context and preserves the publisher artifact identity", (t) => {
  const root = fixture(t, "buildchain.toml", '[build.artifacts]\nname = "libnode-shaped"\nrelease_candidate = true\n');
  const { plan } = resolve(root, { eventName: "workflow_dispatch" });
  assert.equal(plan.source.candidate_channel, "alpha");
  const stable = resolve(root, { baseRef: "release/v4/v4.0", eventName: "pull_request" }).plan;
  assert.equal(stable.source.candidate_channel, "release");
  assert.equal(stable.identity.channel, "alpha");
  const artifacts = ["release-candidate", "summary"].map((kind) => ({ name: `${plan.artifacts.name}-${kind}-${plan.source.sha}` }));
  const selected = selectReleaseCandidateArtifacts({ artifacts, artifactName: "libnode-shaped" });
  assert.equal(selected.sourceSha, plan.source.sha);
  assert.notEqual(resolve(root, { baseRef: "release/v4/v4.0" }).root, resolve(root).root);
});

test("ambiguous roots, traversal, symlink escape and malformed TOML fail before planning", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".buildchain"));
  fs.copyFileSync(path.join(root, "buildchain.toml"), path.join(root, ".buildchain/buildchain.toml"));
  assert.throws(() => discoverBuildConfiguration(root), /found 2/);
  assert.throws(() => discoverBuildConfiguration(root, "buildchain.toml"), /Ambiguous/);
  assert.throws(() => discoverBuildConfiguration(root, "../buildchain.toml"), /repository-relative/);
  fs.symlinkSync(os.tmpdir(), path.join(root, "outside"), "junction");
  assert.throws(() => discoverBuildConfiguration(root, "outside/missing/buildchain.toml"), /escapes repository/);
  fs.rmSync(path.join(root, ".buildchain/buildchain.toml"));
  fs.writeFileSync(path.join(root, "buildchain.toml"), "not TOML");
  assert.throws(() => resolve(root), /parse failed/);
});

test("removed selectors, arbitrary overrides, credentials and wrong types cannot enter project configuration", () => {
  for (const value of [
    { runtime_sha: "a".repeat(40) }, { inputs: {} }, { runners: { role_arn: "role" } },
    { environment: "unregistered" }, { artifacts: { paths: "dist" } },
    { fail_fast: "false" }, { timeout_minutes: 0 }, { artifacts: null },
    { artifacts: { compression_level: 10 } }, { tools: { node: null } },
  ]) {
    if (value.environment) continue;
    assert.throws(() => normalizeBuildConfiguration(value));
  }
});

test("governed environments are selected, never overwritten by consumer bytes", (t) => {
  const root = fixture(t, "buildchain.toml", '[build]\nenvironment = "github-hosted-container"\n');
  assert.equal(resolve(root).plan.environment.runners.container_preset, "kungfu-verify");
  fs.appendFileSync(path.join(root, "buildchain.toml"), 'runner = "privileged"\n');
  assert.throws(() => resolve(root), /Unknown build.runner/);
  const unknown = fixture(t, "buildchain.toml", '[build]\nenvironment = "unregistered"\n');
  assert.throws(() => resolve(unknown), /Unknown governed/);
});

test("stable identity derives its matching lock and opaque selectors fail closed", (t) => {
  const root = fixture(t);
  const { plan } = resolve(root, { workflowRef: "kungfu-systems/buildchain/.github/workflows/build.yml@v4" });
  assert.equal(plan.contract.lock_path, ".buildchain/contract-lock.json");
  assert.equal(plan.identity.major, "4");
  assert.throws(() => resolve(root, { workflowSha: "main" }), /exact SHA/);
  assert.throws(() => resolve(root, { workflowRef: "kungfu-systems/buildchain/.github/workflows/build.yml@train/v4/v4.0/test" }), /floating channel/);
  fs.writeFileSync(path.join(root, "buildchain.toml"), 'schema = 1\n[lifecycle.build]\ncommand = "build"\n');
  assert.equal(resolve(root).plan.lifecycle.install.required, false);
  assert.equal(resolve(root).plan.lifecycle.build.required, true);
  fs.writeFileSync(path.join(root, "buildchain.toml"), 'schema = 1\n');
  assert.throws(() => resolve(root), /lifecycle.build/);
});

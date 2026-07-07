import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeReleasePropagationGraph,
  planReleasePropagation,
  writeReleasePropagationLock,
} from "@kungfu-tech/buildchain/release-propagation";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");
const fixture = path.join(root, "fixtures", "release-propagation-shaped");
const workflowPath = path.join(root, ".github", "workflows", "release-propagation.yml");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(fixture, rel), "utf8"));
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

test("release propagation graph preserves alpha channel and exact upstream facts", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });

  assert.equal(plan.contract, "kungfu-buildchain-release-propagation-plan");
  assert.equal(plan.summary.targetCount, 1);
  assert.equal(plan.targets[0].repository, "kungfu-systems/site-libkungfu-dev");
  assert.equal(plan.targets[0].channel, "alpha");
  assert.equal(plan.targets[0].lockPath, "buildchain.upstreams/kfd.release.json");
  assert.equal(plan.targets[0].lock.upstream.package.version, "1.4.0-alpha.3");
  assert.equal(plan.targets[0].lock.upstream.package.integrity, readJson("upstream-alpha.json").package.integrity);
  assert.equal(plan.targets[0].lock.upstream.releasePassport.sha256, "2222222222222222222222222222222222222222222222222222222222222222");
  assert.equal(plan.targets[0].lock.propagation.floatingTags, false);
  assert.match(plan.targets[0].lock.lockSha256, /^[0-9a-f]{64}$/);
});

test("release propagation graph preserves stable release channel", () => {
  const release = {
    ...readJson("upstream-alpha.json"),
    channel: "release",
    tag: "v1.4.0",
    package: {
      ...readJson("upstream-alpha.json").package,
      version: "1.4.0",
    },
  };
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: release,
  });

  assert.equal(plan.targets[0].channel, "release");
  assert.equal(plan.targets[0].lock.upstream.package.version, "1.4.0");
});

test("release propagation graph rejects cycles before planning downstream PRs", () => {
  const graph = readJson("graph.json");
  graph.edges.push({
    id: "site-to-kfd",
    from: "site-libkungfu-dev",
    to: "kfd",
  });
  assert.throws(
    () => normalizeReleasePropagationGraph(graph),
    /cycle: kfd -> site-libkungfu-dev -> kfd/,
  );
});

test("release propagation write-lock writes exact downstream lock", () => {
  const cwd = tempDir("release-propagation-lock");
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const result = writeReleasePropagationLock({
    plan,
    target: "site-libkungfu-dev",
    cwd,
  });
  const lock = JSON.parse(fs.readFileSync(result.path, "utf8"));

  assert.equal(path.relative(cwd, result.path), "buildchain.upstreams/kfd.release.json");
  assert.equal(lock.contract, "kungfu-buildchain-release-propagation-lock");
  assert.equal(lock.downstream.repository, "kungfu-systems/site-libkungfu-dev");
  assert.equal(lock.upstream.tag, "v1.4.0-alpha.3");
  assert.equal(lock.lockSha256, result.lockSha256);
});

test("release propagation CLI plans and writes downstream locks", () => {
  const cwd = tempDir("release-propagation-cli");
  const planPath = path.join(cwd, "plan.json");
  const planOutput = execFileSync(process.execPath, [
    bin,
    "release-propagation",
    "plan",
    "--graph",
    path.join(fixture, "graph.json"),
    "--upstream-release",
    path.join(fixture, "upstream-alpha.json"),
    "--output",
    planPath,
    "--json",
  ], { cwd: root, encoding: "utf8" });
  const plan = JSON.parse(planOutput);

  assert.equal(plan.targets[0].target, "site-libkungfu-dev");
  assert.equal(fs.existsSync(planPath), true);

  const lockOutput = execFileSync(process.execPath, [
    bin,
    "release-propagation",
    "write-lock",
    "--plan",
    planPath,
    "--target",
    "kungfu-systems/site-libkungfu-dev",
    "--cwd",
    cwd,
    "--json",
  ], { cwd: root, encoding: "utf8" });
  const lockResult = JSON.parse(lockOutput);

  assert.equal(fs.existsSync(lockResult.path), true);
});

test("release propagation CLI fails fast when target is ambiguous", () => {
  const failure = spawnSync(process.execPath, [
    bin,
    "release-propagation",
    "write-lock",
    "--plan",
    JSON.stringify({
      contract: "kungfu-buildchain-release-propagation-plan",
      targets: [],
    }),
  ], { cwd: root, encoding: "utf8" });

  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /expected exactly one propagation target/);
});

test("release propagation reusable workflow invokes the checked out Buildchain runtime", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");

  assert.match(workflow, /buildchain-repository:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /repository: \$\{\{ inputs\.buildchain-repository \}\}/);
  assert.match(workflow, /ref: \$\{\{ inputs\.buildchain-ref \|\| 'v2' \}\}/);
  assert.match(workflow, /path: \.buildchain\/runtime/);
  assert.match(workflow, /Install Buildchain runtime dependencies/);
  assert.match(workflow, /pnpm@11\.7\.0 install --dir \.buildchain\/runtime --prod --frozen-lockfile --ignore-scripts/);
  assert.equal(workflow.includes("node bin/buildchain.mjs release-propagation"), false);
  assert.equal(
    (workflow.match(/node \.buildchain\/runtime\/bin\/buildchain\.mjs release-propagation/g) || []).length,
    2,
  );
});

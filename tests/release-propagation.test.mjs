import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createReleasePropagationReceipt,
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
  assert.match(plan.targets[0].propagationKey, /^[0-9a-f]{64}$/);
  assert.match(
    plan.targets[0].branch,
    /^buildchain\/release-propagation\/kungfu-systems-kfd\/1\.4\.0-alpha\.3-alpha-[0-9a-f]{12}$/,
  );
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

test("release propagation graph carries publication archive payload without package facts", () => {
  const graph = readJson("graph.json");
  graph.nodes.unshift({
    id: "paper",
    repository: "kungfu-systems/paper-observer-declared-timelines",
  });
  graph.edges.unshift({
    id: "paper-to-site",
    from: "paper",
    to: "site-libkungfu-dev",
    channelPolicy: "preserve",
  });

  const plan = planReleasePropagation({
    graph,
    upstreamRelease: readJson("upstream-publication.json"),
  });

  assert.equal(plan.source, "paper");
  assert.equal(plan.targets[0].lock.upstream.package, undefined);
  assert.equal(plan.targets[0].lock.upstream.publicationArtifact.version, "0.1.0-alpha.1");
  assert.equal(
    plan.targets[0].lock.upstream.publicationArtifact.immutableVersionUrl,
    "https://papers.libkungfu.dev/archive/observer-declared-timelines/v0.1.0-alpha.1/",
  );
  assert.equal(plan.targets[0].lock.upstream.publicationArtifact.registry.sha256, "6666666666666666666666666666666666666666666666666666666666666666");
  assert.equal(plan.targets[0].lock.upstream.publicationArtifact.primaryArtifact.path, "_build/main.pdf");
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
  assert.equal(result.status, "written");
  assert.equal(result.changed, true);
  const reused = writeReleasePropagationLock({
    plan,
    target: "site-libkungfu-dev",
    cwd,
  });
  assert.equal(reused.status, "reused");
  assert.equal(reused.changed, false);
});

test("release propagation receipt keeps alpha truth independent from site visibility", () => {
  const plan = planReleasePropagation({
    graph: readJson("graph.json"),
    upstreamRelease: readJson("upstream-alpha.json"),
  });
  const target = plan.targets[0];
  const receipt = createReleasePropagationReceipt({
    plan,
    target: target.target,
    lockResult: {
      lockSha256: target.lock.lockSha256,
      propagationKey: target.propagationKey,
      status: "written",
    },
    prOutcome: {
      state: "created",
      number: 235,
      url: "https://github.com/kungfu-systems/site-libkungfu-dev/pull/235",
      branch: target.branch,
    },
    stagingState: "pending",
    productionState: "not-requested",
    observedAt: "2026-07-30T00:00:00.000Z",
  });

  assert.equal(receipt.contract, "kungfu-buildchain-release-propagation-receipt");
  assert.equal(receipt.states["package-published"].state, "complete");
  assert.equal(receipt.states["alpha-complete"].state, "complete");
  assert.equal(receipt.states["staging-visible"].state, "pending");
  assert.equal(receipt.states["production-visible"].state, "not-requested");
  assert.equal(receipt.downstream.pullRequest.state, "created");
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
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

  const prOutcomePath = path.join(cwd, "pr-outcome.json");
  fs.writeFileSync(prOutcomePath, `${JSON.stringify({
    state: "planned",
    branch: plan.targets[0].branch,
  }, null, 2)}\n`);
  const lockResultPath = path.join(cwd, "lock-result.json");
  fs.writeFileSync(lockResultPath, `${JSON.stringify(lockResult, null, 2)}\n`);
  const receiptOutput = execFileSync(process.execPath, [
    bin,
    "release-propagation",
    "receipt",
    "--plan",
    planPath,
    "--lock-result",
    lockResultPath,
    "--pr-outcome",
    prOutcomePath,
    "--target",
    "site-libkungfu-dev",
    "--json",
  ], { cwd: root, encoding: "utf8" });
  const receipt = JSON.parse(receiptOutput);
  assert.equal(receipt.propagationKey, plan.targets[0].propagationKey);
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
    3,
  );
  assert.match(workflow, /concurrency:/);
  assert.match(workflow, /fromJSON\(inputs\.upstream-release-json\)\.repository/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /downstream-update-command:/);
  assert.match(workflow, /Apply consumer-owned downstream update/);
  assert.match(workflow, /BUILDCHAIN_PROPAGATION_LOCK_PATH:/);
  assert.match(workflow, /bash --noprofile --norc -e -u -o pipefail -c "\$DOWNSTREAM_UPDATE_COMMAND"/);
  assert.match(workflow, /release-propagation receipt/);
  assert.match(workflow, /gh pr list/);
  assert.match(workflow, /release propagation found duplicate matching PRs/);
  assert.equal(workflow.includes("gh pr create \\\n"), true);
});

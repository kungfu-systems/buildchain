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

test("release propagation staged change detection includes a new lock and preserves true no-op", () => {
  const cwd = tempDir("release-propagation-git-change");
  const lockPath = "buildchain.upstreams/kfd.release.json";
  const absoluteLockPath = path.join(cwd, lockPath);
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Buildchain Test"], { cwd });
  execFileSync("git", ["config", "user.email", "buildchain@example.test"], { cwd });
  fs.mkdirSync(path.dirname(absoluteLockPath), { recursive: true });
  fs.writeFileSync(absoluteLockPath, "{\"version\":1}\n");
  execFileSync("git", ["add", "--", lockPath], { cwd });
  assert.notEqual(spawnSync("git", ["diff", "--cached", "--quiet", "--", lockPath], { cwd }).status, 0);
  execFileSync("git", ["commit", "-m", "test: add release lock"], { cwd, stdio: "ignore" });
  fs.writeFileSync(absoluteLockPath, "{\"version\":1}\n");
  execFileSync("git", ["add", "--", lockPath], { cwd });
  assert.equal(spawnSync("git", ["diff", "--cached", "--quiet", "--", lockPath], { cwd }).status, 0);
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
  assert.match(workflow, /LOCK_PATH: \$\{\{ steps\.plan\.outputs\.lock_path \}\}/);
  assert.match(
    workflow,
    /git add -- "\$LOCK_PATH"[\s\S]*?if git diff --cached --quiet -- "\$LOCK_PATH"/,
  );
  assert.doesNotMatch(workflow, /if git diff --quiet/);
  assert.doesNotMatch(workflow, /git add \./);
  assert.match(workflow, /git ls-remote --heads origin "refs\/heads\/\$BRANCH"/);
  assert.match(workflow, /--force-with-lease="refs\/heads\/\$BRANCH:\$remote_sha"/);
  assert.doesNotMatch(workflow, /git push --force(?:\s|$)/);
  assert.match(workflow, /kungfu-buildchain-release-propagation-branch-reconciliation/);
  assert.match(workflow, /"kind":"propagation-branch-reconciliation"/);
  assert.match(workflow, /gh pr list[\s\S]*--state open[\s\S]*--head "\$BRANCH"/);
});

test("release propagation replaces a surviving managed branch with an exact lease and rejects stale writers", () => {
  const cwd = tempDir("release-propagation-lease");
  const remote = path.join(cwd, "remote.git");
  const seed = path.join(cwd, "seed");
  const writer = path.join(cwd, "writer");
  const stale = path.join(cwd, "stale");
  const concurrent = path.join(cwd, "concurrent");
  const branch = "buildchain/release-propagation/kfd";
  const ref = `refs/heads/${branch}`;
  const run = (args, options = {}) => execFileSync("git", args, {
    cwd: options.cwd || cwd,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  }).trim();
  const configure = (repo) => {
    run(["config", "user.name", "Buildchain Test"], { cwd: repo });
    run(["config", "user.email", "buildchain@example.test"], { cwd: repo });
  };
  const commitFile = (repo, file, content, message) => {
    fs.writeFileSync(path.join(repo, file), content);
    run(["add", "--", file], { cwd: repo });
    run(["commit", "-m", message], { cwd: repo });
  };

  run(["init", "--bare", remote]);
  run(["clone", remote, seed]);
  configure(seed);
  run(["checkout", "-b", "main"], { cwd: seed });
  commitFile(seed, "base.txt", "base\n", "test: base");
  run(["push", "-u", "origin", "main"], { cwd: seed });
  run(["checkout", "-b", branch], { cwd: seed });
  commitFile(seed, "kfd.release.json", "{\"version\":1}\n", "test: first lock");
  run(["push", "-u", "origin", branch], { cwd: seed });
  run(["checkout", "main"], { cwd: seed });
  run(["merge", "--no-ff", branch, "-m", "test: merge first propagation"], { cwd: seed });
  run(["push", "origin", "main"], { cwd: seed });

  run(["clone", "--branch", "main", remote, writer]);
  configure(writer);
  run(["checkout", "-b", branch], { cwd: writer });
  commitFile(writer, "kfd.release.json", "{\"version\":2}\n", "test: next lock");
  const observed = run(["ls-remote", "--heads", "origin", ref], { cwd: writer }).split("\t")[0];
  run([
    "push",
    `--force-with-lease=${ref}:${observed}`,
    "origin",
    `HEAD:${ref}`,
  ], { cwd: writer });
  assert.equal(
    run(["ls-remote", "--heads", "origin", ref], { cwd: writer }).split("\t")[0],
    run(["rev-parse", "HEAD"], { cwd: writer }),
  );

  run(["clone", remote, stale]);
  configure(stale);
  run(["checkout", "-b", branch, `origin/${branch}`], { cwd: stale });
  const staleLease = run(["rev-parse", "HEAD"], { cwd: stale });
  commitFile(stale, "kfd.release.json", "{\"version\":3}\n", "test: stale lock");

  run(["clone", remote, concurrent]);
  configure(concurrent);
  run(["checkout", "-b", branch, `origin/${branch}`], { cwd: concurrent });
  commitFile(concurrent, "concurrent.txt", "advanced\n", "test: concurrent advance");
  run(["push", "origin", `HEAD:${ref}`], { cwd: concurrent });

  const rejected = spawnSync("git", [
    "push",
    `--force-with-lease=${ref}:${staleLease}`,
    "origin",
    `HEAD:${ref}`,
  ], { cwd: stale, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /stale info|rejected/);
});

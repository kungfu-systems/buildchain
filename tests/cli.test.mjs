import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";
import {
  createDiagnosticsArtifact,
  collectCacheDiagnostics,
  collectCompilerCacheDiagnostics,
  collectRunnerDiagnostics,
  detectRequestedParallelism,
  startProcessSampler,
  summarizeProcessSamples,
  validateAnchoredPackageRelease,
} from "@kungfu-tech/buildchain/diagnostics";
import { resolveSpawnCommand, usesShellForSpawnCommand } from "../scripts/build-standalone-binary.mjs";
import { createReleaseEvidenceBundle } from "../scripts/create-release-bundle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "buildchain.mjs");

function runBuildchain(args, options = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

function runBuildchainFailure(args, options = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
  });
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `buildchain-${name}-`));
}

test("CLI prints help and version", () => {
  assert.match(runBuildchain(["--help"]), /buildchain init/);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(runBuildchain(["version"]).trim(), packageJson.version);
});

test("init package creates buildchain.toml and reusable workflow", () => {
  const cwd = tempDir("init-package");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  const result = JSON.parse(runBuildchain([
    "init",
    "--cwd",
    cwd,
    "--type",
    "package",
    "--package-manager",
    "npm",
    "--artifact-name",
    "fixture-{platform}",
  ]));

  assert.equal(result.type, "package");
  assert.equal(result.packageManager, "npm");
  assert.deepEqual(result.written.sort(), [".github/workflows/build.yml", "buildchain.toml"]);
  assert.match(fs.readFileSync(path.join(cwd, "buildchain.toml"), "utf8"), /npm ci/);
  assert.match(fs.readFileSync(path.join(cwd, ".github/workflows/build.yml"), "utf8"), /artifact-name-template: "fixture-\{platform\}"/);
  const failure = runBuildchainFailure(["init", "--cwd", cwd]);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /already exists/);
});

test("validate reads initialized package config", () => {
  const cwd = tempDir("validate-package");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
  runBuildchain(["init", "--cwd", cwd, "--type", "package"]);
  const validation = JSON.parse(runBuildchain([
    "validate",
    "--cwd",
    cwd,
    "--require-version-state",
    "--require-lifecycle-stages",
    "install,build,verify",
  ]));

  assert.equal(validation.project.type, "package");
  assert.equal(validation.versionFiles[0].path, "package.json");
  assert.deepEqual(validation.lifecycleStages.map((stage) => stage.name).sort(), ["build", "install", "verify"]);
});

test("doctor accepts anchored package configs without project section", () => {
  const report = JSON.parse(runBuildchain(["doctor", "--cwd", path.join(root, "fixtures/libnode-shaped"), "--json"]));

  const configCheck = report.checks.find((check) => check.id === "config.valid");
  assert.equal(configCheck.status, "pass");
  assert.equal(configCheck.details.projectType, "");
  assert.deepEqual(
    configCheck.details.lifecycleStages.sort(),
    ["build", "install", "publish", "verify"],
  );
});

test("lifecycle run writes deterministic artifact manifest", () => {
  const cwd = tempDir("lifecycle");
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[lifecycle.build]
command = "node -e \\"require('node:fs').mkdirSync('out',{recursive:true});require('node:fs').writeFileSync('out/result.txt','ok')\\""
`);
  const output = runBuildchain([
    "lifecycle",
    "run",
    "build",
    "--cwd",
    cwd,
    "--artifact-path",
    "out",
    "--artifact-name",
    "fixture",
    "--log-path",
    ".buildchain/logs/events.jsonl",
  ], { cwd });
  const manifest = JSON.parse(output.slice(output.indexOf("{")));

  assert.equal(manifest.artifactName, "fixture");
  assert.equal(manifest.lifecycle.stage, "build");
  assert.equal(manifest.files[0].path, "out/result.txt");
  assert.equal(manifest.observability.log.contract, "kungfu-buildchain-log-event");
  assert.equal(manifest.observability.log.summary.sources.buildchain.count, 4);
  assert.equal(manifest.observability.log.summary.sources.user.count, 2);
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "artifacts", "manifest.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "logs", "events.jsonl")));
});

test("CLI logging writes redacted JSONL events and summaries", () => {
  const cwd = tempDir("logging");
  const logPath = path.join(cwd, ".buildchain", "logs", "events.jsonl");
  const output = runBuildchain([
    "log",
    "info",
    "--event",
    "native.configure",
    "--phase",
    "configure",
    "--component",
    "fixture",
    "--attribute",
    "token=secret-value",
    "--attribute",
    "target=debug",
    "--path",
    logPath,
    "--json",
  ], { cwd });
  const event = JSON.parse(output);
  assert.equal(event.attributes.token, "[REDACTED]");
  assert.equal(event.attributes.target, "debug");

  const events = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].contract, "kungfu-buildchain-log-event");

  const summary = JSON.parse(runBuildchain(["log", "summary", "--path", logPath, "--json"], { cwd }));
  assert.equal(summary.contract, "kungfu-buildchain-log-summary");
  assert.equal(summary.eventCount, 1);
  assert.equal(summary.sources.user.count, 1);
  assert.equal(summary.phases.configure.count, 1);
  assert.equal(summary.components.fixture.count, 1);
});

test("logging SDK supports sync spans and spawn wrappers", () => {
  const cwd = tempDir("logging-sync");
  const logPath = path.join(cwd, ".buildchain", "logs", "events.jsonl");
  const logger = createBuildchainLogger({
    cwd,
    path: logPath,
    console: false,
    component: "sync-fixture",
  });

  const value = logger.spanSync("fixture.sync", { phase: "build" }, () => 42);
  assert.equal(value, 42);
  const result = logger.spawnSync(
    "fixture.spawn",
    process.execPath,
    ["-e", "process.exit(0)"],
    { cwd, stdio: "ignore" },
    { phase: "build" },
  );
  assert.equal(result.status, 0);

  const events = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.event),
    ["fixture.sync.start", "fixture.sync.end", "fixture.spawn.start", "fixture.spawn.end"],
  );
  assert.equal(collectRunnerDiagnostics().cpu.logicalCount > 0, true);
});

test("diagnostics SDK validates anchored package release contracts", () => {
  const report = validateAnchoredPackageRelease({
    cwd: path.join(root, "fixtures/libnode-shaped"),
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.versionStrategy.strategy, "anchored");
  assert.ok(report.checks.some((entry) => entry.id === "lifecycle.publish" && entry.status === "pass"));

  const relaxed = validateAnchoredPackageRelease({
    cwd: path.join(root, "fixtures/libnode-shaped"),
    requirePackageSetOrder: "",
    requireTrustedPublishing: false,
    requireLifecycleStages: ["install", "build", "verify"],
  });
  assert.equal(relaxed.ok, true);
});

test("diagnostics SDK summarizes process samples against requested parallelism", () => {
  const summary = summarizeProcessSamples({
    command: "make",
    args: ["-j20"],
    env: {},
    samples: [
      {
        processes: [
          { command: "make", cpu: 1.1 },
          { command: "ccache", cpu: 0.4 },
          { command: "clang++", cpu: 92.5 },
          { command: "clang++", cpu: 88.25 },
          { command: "libtool", cpu: 12.5 },
          { command: "sleep", cpu: 0 },
        ],
      },
      {
        processes: [
          { command: "make", cpu: 3 },
          { command: "libtool", cpu: 70 },
        ],
      },
    ],
  });

  assert.equal(summary.contract, "kungfu-buildchain-process-sample-summary");
  assert.equal(summary.requestedParallelism, 20);
  assert.equal(summary.requestedParallelismSource, "command");
  assert.equal(summary.observedConcurrency.max, 5);
  assert.equal(summary.observedConcurrency.ratioToRequestedMax, 0.25);
  assert.equal(summary.categories.compiler, 2);
  assert.equal(summary.categories.archive, 1);
  assert.equal(summary.topCommands[0].command, "clang++");

  const artifact = createDiagnosticsArtifact({
    cwd: path.join(root, "fixtures/libnode-shaped"),
    processSummary: summary,
  });
  assert.equal(artifact.process.requestedParallelism, 20);
  assert.equal(artifact.process.observedConcurrency.max, 5);
});

test("diagnostics SDK detects requested parallelism from commands and env", () => {
  assert.deepEqual(
    detectRequestedParallelism({ command: "make -j20" }),
    { value: 20, source: "command", token: "-j20" },
  );
  assert.deepEqual(
    detectRequestedParallelism({ command: "cmake", args: ["--build", "build", "--parallel", "8"] }),
    { value: 8, source: "command", token: "--parallel 8" },
  );
  assert.deepEqual(
    detectRequestedParallelism({ env: { MAKEFLAGS: "--jobs=12" } }),
    { value: 12, source: "env:MAKEFLAGS", token: "--jobs=12" },
  );
  assert.deepEqual(
    detectRequestedParallelism({ env: { CMAKE_BUILD_PARALLEL_LEVEL: "16" } }),
    { value: 16, source: "env:CMAKE_BUILD_PARALLEL_LEVEL", token: "CMAKE_BUILD_PARALLEL_LEVEL" },
  );
});

test("diagnostics SDK collects compiler cache stats through injectable runners", () => {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === "ccache") {
      return JSON.stringify({
        cache_hit_direct: 7,
        cache_miss: 3,
      });
    }
    if (command === "sccache") {
      return JSON.stringify({
        stats: {
          cache_hits: 4,
          compile_requests: 9,
        },
      });
    }
    const error = new Error("not found");
    error.code = "ENOENT";
    throw error;
  };

  const compilerCaches = collectCompilerCacheDiagnostics({ cwd: root, runCommand });
  assert.equal(compilerCaches.ccache.available, true);
  assert.equal(compilerCaches.ccache.format, "json");
  assert.equal(compilerCaches.ccache.stats.cache_hit_direct, 7);
  assert.equal(compilerCaches.sccache.stats.stats.cache_hits, 4);
  assert.deepEqual(calls, [
    ["ccache", "--show-stats", "--json"],
    ["sccache", "--show-stats", "--stats-format", "json"],
  ]);

  const cache = collectCacheDiagnostics({ cwd: root, runCommand });
  assert.equal(cache.compilerCaches.ccache.stats.cache_miss, 3);
  assert.equal(cache.compilerCaches.sccache.stats.stats.compile_requests, 9);

  const unavailable = collectCompilerCacheDiagnostics({
    cwd: root,
    runCommand() {
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(unavailable.ccache.available, false);
  assert.equal(unavailable.sccache.available, false);
});

test("diagnostics process sampler annotates samples with build concurrency context", () => {
  const sampler = startProcessSampler({
    label: "native-build",
    command: "make -j20",
    intervalMs: 60000,
    env: {},
  });
  const samples = sampler.stop();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].label, "native-build");
  assert.equal(samples[0].requestedParallelism, 20);
  assert.equal(samples[0].requestedParallelismSource, "command");
  assert.equal(Number.isFinite(samples[0].elapsedMs), true);
});

test("CLI verifies observability logs fail closed", () => {
  const cwd = tempDir("logging-verify");
  const logPath = path.join(cwd, ".buildchain", "logs", "events.jsonl");
  runBuildchain([
    "mark",
    "--event",
    "binary.matrix.start",
    "--phase",
    "setup",
    "--component",
    "workflow",
    "--source",
    "buildchain",
    "--path",
    logPath,
  ], { cwd });
  runBuildchain([
    "mark",
    "--event",
    "binary.matrix.complete",
    "--phase",
    "evidence",
    "--component",
    "standalone-binary",
    "--source",
    "buildchain",
    "--path",
    logPath,
  ], { cwd });

  const report = JSON.parse(runBuildchain([
    "verify",
    "observability-log",
    logPath,
    "--min-events",
    "2",
    "--require-phase",
    "setup,evidence",
    "--require-component",
    "workflow",
    "--require-component",
    "standalone-binary",
    "--require-event",
    "binary.matrix.start",
    "--json",
  ], { cwd }));
  assert.equal(report.ok, true);
  assert.equal(report.summary.eventCount, 2);

  const failure = runBuildchainFailure([
    "verify",
    "observability-log",
    logPath,
    "--min-events",
    "3",
    "--require-phase",
    "archive",
    "--json",
  ], { cwd });
  assert.equal(failure.status, 1);
  const failedReport = JSON.parse(failure.stdout);
  assert.equal(failedReport.ok, false);
  assert.ok(failedReport.issues.some((entry) => entry.code === "log.events.too_few"));
  assert.ok(failedReport.issues.some((entry) => entry.code === "log.phase.missing"));
});

test("standalone binary builder resolves Windows package manager shims", () => {
  assert.equal(resolveSpawnCommand("pnpm", "win32"), "pnpm.cmd");
  assert.equal(resolveSpawnCommand("npx", "win32"), "npx.cmd");
  assert.equal(resolveSpawnCommand("powershell", "win32"), "powershell");
  assert.equal(resolveSpawnCommand("pnpm", "linux"), "pnpm");
  assert.equal(usesShellForSpawnCommand("pnpm", "win32"), true);
  assert.equal(usesShellForSpawnCommand("npx", "win32"), true);
  assert.equal(usesShellForSpawnCommand("powershell", "win32"), false);
  assert.equal(usesShellForSpawnCommand("pnpm", "linux"), false);
});

test("CLI span wraps commands and preserves failure exit codes", () => {
  const cwd = tempDir("span");
  const logPath = path.join(cwd, "events.jsonl");
  const failure = runBuildchainFailure([
    "span",
    "--event",
    "heavy.build",
    "--phase",
    "build",
    "--path",
    logPath,
    "--",
    process.execPath,
    "-e",
    "process.exit(7)",
  ], { cwd });

  assert.equal(failure.status, 7);
  const events = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "heavy.build.start");
  assert.equal(events[1].event, "heavy.build.error");
  assert.equal(events[1].attributes.status, 7);
});

test("doctor reports repository readiness as structured JSON", () => {
  const cwd = tempDir("doctor");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "doctor-fixture",
    version: "0.1.0",
    packageManager: "npm@11.0.0",
  }, null, 2));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  runBuildchain(["init", "--cwd", cwd, "--type", "package", "--package-manager", "npm"]);
  const result = JSON.parse(runBuildchain(["doctor", "--cwd", cwd, "--json"], { cwd }));

  assert.equal(result.contract, "kungfu-buildchain-doctor");
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.id), [
    "cwd.exists",
    "config.valid",
    "package-manager.detected",
    "git.repository",
    "workflow.build",
  ]);
});

test("npm dry-run validates package publish shape without publishing", () => {
  const cwd = tempDir("npm-dry-run");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "buildchain-dry-run-fixture",
    version: "1.2.3-alpha.0",
    private: false,
    license: "Apache-2.0",
  }, null, 2));
  fs.writeFileSync(path.join(cwd, "README.md"), "# fixture\n");
  const result = JSON.parse(runBuildchain([
    "npm",
    "dry-run",
    "--cwd",
    cwd,
    "--json",
    "--skip-npm-publish-dry-run",
  ]));

  assert.equal(result.package.name, "buildchain-dry-run-fixture");
  assert.equal(result.exactTag, "v1.2.3-alpha.0");
  assert.equal(result.distTag, "alpha");
  assert.equal(result.wouldPublish, false);
  assert.ok(result.pack.entryCount >= 2);
});

test("npm dry-run fails closed when expected tag does not match package version", () => {
  const cwd = tempDir("npm-dry-run-mismatch");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "buildchain-dry-run-mismatch",
    version: "1.2.3",
    private: false,
  }, null, 2));
  const failure = runBuildchainFailure([
    "npm",
    "dry-run",
    "--cwd",
    cwd,
    "--expected-tag",
    "v1.2.4",
    "--skip-npm-publish-dry-run",
  ]);

  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /tag=v1\.2\.4 expected=v1\.2\.3/);
});

test("release dry-run explains channel promotion without moving refs", () => {
  const cwd = tempDir("release-dry-run");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "release-dry-run-fixture",
    version: "1.2.3-alpha.0",
  }, null, 2));
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[version]
required = true

[[version.files]]
path = "package.json"
type = "json"
key = "version"
`);

  const output = runBuildchain([
    "release",
    "--dry-run",
    "--cwd",
    cwd,
    "--target-ref",
    "release/v2/v2.0",
    "--sha",
    "b".repeat(40),
    "--tags",
    "v2.0.12,v2.0.13-alpha.0",
    "--json",
  ], { cwd });
  const plan = JSON.parse(output);

  assert.equal(plan.dryRun, true);
  assert.equal(plan.targetRef, "release/v2/v2.0");
  assert.equal(plan.source.expectedHeadRef, "alpha/v2/v2.0");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v2.0.12", "v2.0.13-alpha.0"]);
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "release/v2/v2.0",
    "alpha/v2/v2.0",
    "dev/v2/v2.0",
  ]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version, "1.2.3-alpha.0");
});

test("release dry-run subcommand explains major gate with source ref", () => {
  const output = runBuildchain([
    "release",
    "dry-run",
    "--target-ref",
    "publish-gate/major",
    "--source-ref",
    "release/v2/v2.0",
    "--sha",
    "c".repeat(40),
  ]);

  assert.match(output, /target ref: publish-gate\/major/);
  assert.match(output, /expected source: release\/v2\/v2\.0/);
  assert.match(output, /v3\.0\.0: would create the first production patch/);
  assert.match(output, /No refs, tags, packages, or files were modified/);
});

test("release explain aliases release dry-run", () => {
  const output = runBuildchain([
    "release",
    "explain",
    "--target-ref",
    "alpha/v2/v2.1",
    "--sha",
    "d".repeat(40),
    "--json",
  ]);
  const plan = JSON.parse(output);

  assert.equal(plan.dryRun, true);
  assert.equal(plan.targetRef, "alpha/v2/v2.1");
  assert.equal(plan.source.expectedHeadRef, "dev/v2/v2.1");
});

test("transaction inspect is available as a top-level read/recovery helper", () => {
  const cwd = tempDir("transaction-inspect");
  const statePath = path.join(cwd, ".buildchain", "release-state", "v2.1.0-alpha.0.json");
  const output = runBuildchain([
    "transaction",
    "inspect",
    "--version",
    "v2.1.0-alpha.0",
    "--state-path",
    statePath,
    "--repository",
    "kungfu-systems/buildchain",
    "--source-sha",
    "a".repeat(40),
    "--release-sha",
    "b".repeat(40),
    "--target-ref",
    "alpha/v2/v2.1",
    "--channel",
    "alpha",
  ], { cwd });
  const result = JSON.parse(output);

  assert.equal(result.command, "inspect");
  assert.equal(result.created, true);
  assert.equal(result.transaction.version, "v2.1.0-alpha.0");
  assert.match(result.durableBoundary, /remote durable refs/);
});

test("release passport collect verify and explain form an agent-readable contract", () => {
  const cwd = tempDir("release-passport");
  const assetsDir = path.join(cwd, "dist");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "buildchain-x86_64-unknown-linux-gnu.tar.gz"), "linux-binary\n");
  fs.writeFileSync(path.join(assetsDir, "checksums.txt"), "placeholder\n");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    name: "@kungfu-tech/buildchain",
    version: "2.2.0-alpha.0",
  }, null, 2));

  const collected = JSON.parse(runBuildchain([
    "collect",
    "github-release",
    "--cwd",
    cwd,
    "--tag",
    "v2.2.0-alpha.0",
    "--repository",
    "kungfu-systems/buildchain",
    "--source-sha",
    "e".repeat(40),
    "--assets-dir",
    assetsDir,
    "--output-dir",
    "release-passport",
    "--json",
  ], { cwd }));
  const passportPath = path.join(collected.outputDir, "buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(passportPath, "utf8"));

  assert.equal(passport.contract, "kungfu-buildchain-release-passport");
  assert.equal(passport.runnerPolicy.productionDefault, "github-hosted");
  assert.equal(passport.runnerPolicy.compatibilityFixture, "self-hosted");
  assert.equal(passport.artifacts.length, 2);

  const report = JSON.parse(runBuildchain(["verify", "release-passport", passportPath, "--json"], { cwd }));
  assert.equal(report.contract, "kungfu-buildchain-release-check-report");
  assert.equal(report.ok, true);
  assert.equal(report.completeness.artifactCount, 2);

  const explanation = JSON.parse(runBuildchain([
    "explain",
    "release",
    "--passport",
    passportPath,
    "--for",
    "agent",
    "--json",
  ], { cwd }));
  assert.equal(explanation.audience, "agent");
  assert.equal(explanation.trust, "pass");
  assert.equal(explanation.nextAction, "install-or-upgrade-after-policy-review");
});

test("release evidence bundle groups release assets and passport files", () => {
  const cwd = tempDir("release-bundle");
  const assetsDir = path.join(cwd, "dist", "binary");
  const passportDir = path.join(cwd, ".buildchain", "release-passport");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(passportDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "buildchain-x86_64-unknown-linux-gnu.tar.gz"), "linux-binary\n");
  fs.writeFileSync(path.join(assetsDir, "checksums.txt"), "checksum\n");
  fs.writeFileSync(path.join(passportDir, "buildchain.release.json"), "{}\n");
  fs.writeFileSync(path.join(passportDir, "artifact-evidence.json"), "{}\n");

  const result = createReleaseEvidenceBundle({
    cwd,
    assetsDir,
    passportDir,
    outputDir: passportDir,
    tag: "v2.2.1",
    sourceSha: "a".repeat(40),
  });

  assert.ok(fs.existsSync(result.archivePath));
  assert.ok(fs.existsSync(result.manifestPath));
  assert.equal(result.manifest.contract, "kungfu-buildchain-release-evidence-bundle");
  assert.equal(result.manifest.release.tag, "v2.2.1");
  assert.match(result.manifest.bundle.name, /buildchain-release-bundle\.tar\.gz/);
  assert.ok(result.manifest.files.some((file) => file.bundlePath === "release-assets/checksums.txt"));
  assert.ok(result.manifest.files.some((file) => file.bundlePath === "release-passport/buildchain.release.json"));
});

test("release passport verification fails closed on missing artifact evidence", () => {
  const cwd = tempDir("release-passport-fail");
  const passportPath = path.join(cwd, "buildchain.release.json");
  fs.writeFileSync(passportPath, JSON.stringify({
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-passport",
    product: {
      name: "Buildchain",
      repository: "kungfu-systems/buildchain",
      mechanism: "product-mechanism.json",
    },
    release: {
      tag: "v2.2.0",
      sourceSha: "f".repeat(40),
    },
    runnerPolicy: {
      productionDefault: "github-hosted",
    },
    artifacts: [
      {
        name: "buildchain-x86_64-unknown-linux-gnu.tar.gz",
        platform: "linux-x64",
        sha256: "0".repeat(64),
        evidence: "artifact-evidence.json",
      },
    ],
    evidence: {
      artifactEvidence: "artifact-evidence.json",
      impact: "impact.json",
      agentIndex: "agent-index.json",
    },
  }, null, 2));
  for (const [fileName, contract] of [
    ["artifact-evidence.json", "kungfu-buildchain-artifact-evidence"],
    ["impact.json", "kungfu-buildchain-impact"],
    ["agent-index.json", "kungfu-buildchain-agent-index"],
    ["product-mechanism.json", "kungfu-buildchain-product-mechanism"],
  ]) {
    fs.writeFileSync(path.join(cwd, fileName), JSON.stringify({
      schemaVersion: 1,
      contract,
      artifacts: [],
    }, null, 2));
  }
  const failure = runBuildchainFailure(["verify", "release-passport", passportPath, "--json"], { cwd });

  assert.equal(failure.status, 1);
  const report = JSON.parse(failure.stdout);
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /artifact\.evidence\.missing/);
});

test("release dry-run rejects unsupported tag syntax", () => {
  const failure = runBuildchainFailure([
    "release",
    "--dry-run",
    "--target-ref",
    "release/v2/v2.0",
    "--tags",
    "2.0.0",
  ]);

  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /Unsupported buildchain dry-run tag: 2\.0\.0/);
});

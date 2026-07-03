import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuildchainLogger } from "@kungfu-tech/buildchain/logging";
import {
  BUILDCHAIN_ANCHORED_PACKAGE_RELEASE_VALIDATION_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
  createDiagnosticsArtifact,
  collectCacheDiagnostics,
  collectCompilerCacheDiagnostics,
  collectNativeDiagnostics,
  collectRunnerDiagnostics,
  detectRequestedParallelism,
  detectRequestedParallelismFromProcessSamples,
  formatDiagnosticsSummaryTable,
  startProcessSampler,
  summarizeDiagnosticsArtifacts,
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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
  const workflow = fs.readFileSync(path.join(cwd, ".github/workflows/build.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /buildchain-ref:/);
  assert.match(workflow, /Temporary Buildchain runtime ref/);
  assert.match(workflow, /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| '' \}\}/);
  assert.match(workflow, /artifact-name-template: "fixture-\{platform\}"/);
  const failure = runBuildchainFailure(["init", "--cwd", cwd]);
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /already exists/);
});

test("init infra-contract creates a directly valid observed contract scaffold", () => {
  const cwd = tempDir("init-infra-contract");
  const result = JSON.parse(runBuildchain([
    "init",
    "--cwd",
    cwd,
    "--type",
    "infra-contract",
  ]));

  assert.equal(result.type, "infra-contract");
  assert.deepEqual(result.written.sort(), [
    ".github/workflows/build.yml",
    "buildchain.toml",
    "infra/desired.json",
    "infra/outputs.json",
  ]);
  assert.match(fs.readFileSync(path.join(cwd, "buildchain.toml"), "utf8"), /type = "infra-contract"/);

  const outputPath = path.join(cwd, "infra-validation.json");
  runBuildchain([
    "infra-contract",
    "--mode",
    "validate",
    "--cwd",
    cwd,
    "--output",
    outputPath,
  ]);
  const validation = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(validation.project.type, "infra-contract");
  assert.equal(validation.infra.adapter, "manual-observed");
  assert.equal(validation.consumers.length, 1);
});

test("infra-contract CLI apply consumes a saved fresh plan", () => {
  const cwd = tempDir("infra-contract-cli-apply");
  fs.cpSync(path.join(root, "fixtures/infra-contract-terraform-shaped"), cwd, { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "buildchain.toml"),
    fs.readFileSync(path.join(cwd, "buildchain.toml"), "utf8")
      .replace('adoption_mode = "observe-only"', 'adoption_mode = "managed-apply"')
      .replace('apply = "disabled"', 'apply = "manual-approval"'),
  );
  const sourceSha = "2".repeat(40);
  const planPath = path.join(cwd, ".buildchain", "infra-contract-plan.json");
  runBuildchain([
    "infra-contract",
    "--mode",
    "plan",
    "--cwd",
    cwd,
    "--source-sha",
    sourceSha,
    "--output",
    planPath,
  ]);
  const outputPath = path.join(cwd, ".buildchain", "infra-contract-apply.json");
  runBuildchain([
    "infra-contract",
    "--mode",
    "apply",
    "--cwd",
    cwd,
    "--source-sha",
    sourceSha,
    "--approval-id",
    "APPROVED-CLI-1",
    "--plan",
    planPath,
    "--dry-run",
    "true",
    "--output",
    outputPath,
  ]);
  const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(result.contract, "kungfu-buildchain-infra-contract-apply");
  assert.equal(result.status, "planned");
  assert.equal(result.sourceSha, sourceSha);
  assert.equal(result.mutationExecuted, false);
});

test("infra-contract CLI propagation-apply writes a dry-run PR plan", () => {
  const cwd = tempDir("infra-contract-cli-propagation");
  fs.cpSync(path.join(root, "fixtures/infra-contract-shaped"), cwd, { recursive: true });
  const sourceSha = "5".repeat(40);
  const planPath = path.join(cwd, ".buildchain", "infra-contract-plan.json");
  const artifactPath = path.join(cwd, ".buildchain", "buildchain.infra-contract.json");
  const propagationPath = path.join(cwd, ".buildchain", "infra-contract-propagation.json");
  const outputPath = path.join(cwd, ".buildchain", "infra-contract-propagation-apply.json");

  runBuildchain([
    "infra-contract",
    "--mode",
    "plan",
    "--cwd",
    cwd,
    "--source-sha",
    sourceSha,
    "--output",
    planPath,
  ]);
  runBuildchain([
    "infra-contract",
    "--mode",
    "contract",
    "--cwd",
    cwd,
    "--source-sha",
    sourceSha,
    "--plan",
    planPath,
    "--output",
    artifactPath,
  ]);
  runBuildchain([
    "infra-contract",
    "--mode",
    "propagation-plan",
    "--cwd",
    cwd,
    "--artifact",
    artifactPath,
    "--output",
    propagationPath,
  ]);
  runBuildchain([
    "infra-contract",
    "--mode",
    "propagation-apply",
    "--cwd",
    cwd,
    "--artifact",
    artifactPath,
    "--propagation-plan",
    propagationPath,
    "--dry-run",
    "true",
    "--output",
    outputPath,
  ]);

  const result = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(result.contract, "kungfu-buildchain-infra-contract-propagation-apply");
  assert.equal(result.status, "planned");
  assert.equal(result.mutationAllowed, false);
  assert.equal(result.operations.length, 2);
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
  const anchoredCheck = report.checks.find((check) => check.id === "anchored-package-release.valid");
  assert.equal(anchoredCheck.status, "pass");
  assert.equal(anchoredCheck.details.contract, BUILDCHAIN_ANCHORED_PACKAGE_RELEASE_VALIDATION_CONTRACT);
  assert.equal(anchoredCheck.details.summary.versionStrategy.strategy, "anchored");
  assert.equal(anchoredCheck.details.summary.publish.auth, "trusted-publishing");
  assert.equal(
    anchoredCheck.details.checks.find((check) => check.id === "publish.package_set_order").status,
    "pass",
  );
});

test("lifecycle run writes deterministic artifact manifest", () => {
  const cwd = tempDir("lifecycle");
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[lifecycle.build]
command = "node -e \\"require('node:fs').mkdirSync('out',{recursive:true});require('node:fs').writeFileSync('out/result.txt','ok')\\""
`);
  const processSummaryPath = path.join(cwd, ".buildchain", "diagnostics", "process-summary.json");
  const processSamplesPath = path.join(cwd, ".buildchain", "diagnostics", "process-samples.jsonl");
  fs.mkdirSync(path.dirname(processSummaryPath), { recursive: true });
  fs.writeFileSync(processSamplesPath, `${JSON.stringify({
    timestamp: "2026-07-02T00:00:00.000Z",
    processes: [{ command: "clang++", cpu: 10 }],
  })}\n`);
  fs.writeFileSync(processSummaryPath, `${JSON.stringify({
    schemaVersion: 1,
    contract: BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
    samplesPath: ".buildchain/diagnostics/process-samples.jsonl",
    summary: {
      schemaVersion: 1,
      contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
      requestedParallelism: 6,
      requestedParallelismSource: "explicit",
      observedConcurrency: { max: 2, ratioToRequestedMax: 0.333 },
      sampleCount: 1,
      categories: { compiler: 1 },
      topCommands: [{ command: "clang++", count: 1 }],
    },
  })}\n`);
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
    "--process-summary",
    ".buildchain/diagnostics/process-summary.json",
  ], { cwd });
  const manifest = JSON.parse(output.slice(output.indexOf("{")));

  assert.equal(manifest.artifactName, "fixture");
  assert.equal(manifest.lifecycle.stage, "build");
  assert.equal(manifest.files[0].path, "out/result.txt");
  assert.equal(manifest.observability.log.contract, "kungfu-buildchain-log-event");
  assert.equal(manifest.observability.log.summary.sources.buildchain.count, 4);
  assert.equal(manifest.observability.log.summary.sources.user.count, 2);
  assert.equal(manifest.observability.process.path, ".buildchain/diagnostics/process-summary.json");
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "artifacts", "manifest.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "logs", "events.jsonl")));
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "artifacts", "events.jsonl")));
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "artifacts", "process-summary.json")));
  assert.ok(fs.existsSync(path.join(cwd, ".buildchain", "artifacts", "process-samples.jsonl")));
  const diagnostics = JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain", "artifacts", "diagnostics.json"), "utf8"));
  assert.equal(diagnostics.process.requestedParallelism, 6);
  assert.equal(diagnostics.process.observedConcurrency.max, 2);
  assert.equal(diagnostics.links.processSummary, ".buildchain/diagnostics/process-summary.json");
  assert.equal(diagnostics.links.diagnosticsEvents, ".buildchain/artifacts/events.jsonl");
  assert.equal(diagnostics.links.diagnosticsProcessSummary, ".buildchain/artifacts/process-summary.json");
  assert.equal(diagnostics.links.diagnosticsProcessSamples, ".buildchain/artifacts/process-samples.jsonl");
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

test("logging and diagnostics SDK subpaths can be used from CommonJS scripts", () => {
  const cwd = fs.mkdtempSync(path.join(root, ".tmp-cjs-logging-"));
  const scriptPath = path.join(cwd, "fixture.cjs");
  const logPath = path.join(cwd, ".buildchain", "logs", "events.jsonl");
  fs.writeFileSync(scriptPath, `
(async () => {
  const { createBuildchainLogger } = await import("@kungfu-tech/buildchain/logging");
  const { collectRunnerDiagnostics } = await import("@kungfu-tech/buildchain/diagnostics");
  const logger = createBuildchainLogger({
    path: process.argv[2],
    console: false,
    component: "cjs-fixture",
  });
  const value = logger.spanSync("cjs.sync", { phase: "build" }, () => 7);
  const result = logger.spawnSync(
    "cjs.spawn",
    process.execPath,
    ["-e", "process.exit(0)"],
    { stdio: "ignore" },
    { phase: "build" },
  );
  const runner = collectRunnerDiagnostics();
  process.stdout.write(JSON.stringify({
    value,
    status: result.status,
    cpu: runner.cpu.logicalCount,
    events: logger.events.length,
  }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`);

  try {
    const result = spawnSync(process.execPath, [scriptPath, logPath], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.value, 7);
    assert.equal(report.status, 0);
    assert.equal(report.cpu > 0, true);
    assert.equal(report.events, 4);

    const events = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.event),
      ["cjs.sync.start", "cjs.sync.end", "cjs.spawn.start", "cjs.spawn.end"],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
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

  const gated = validateAnchoredPackageRelease({
    cwd: path.join(root, "fixtures/libnode-shaped"),
    requirePublishGateSourceLock: true,
    publishSource: {
      sourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      sourceSha: "a".repeat(40),
      sourceLocked: true,
    },
  });
  assert.equal(gated.ok, true);
  assert.equal(gated.summary.publishSource.channel, "release");
  assert.equal(gated.checks.find((entry) => entry.id === "publish.source_locked").status, "pass");
  assert.equal(gated.checks.find((entry) => entry.id === "publish.source_version").status, "pass");

  const directBranch = validateAnchoredPackageRelease({
    cwd: path.join(root, "fixtures/libnode-shaped"),
    requirePublishGateSourceLock: true,
    publishSource: {
      sourceRef: "release/v22/v22.22",
      sourceSha: "b".repeat(40),
      sourceLocked: true,
    },
  });
  assert.equal(directBranch.ok, false);
  assert.equal(directBranch.checks.find((entry) => entry.id === "publish.source_ref").status, "fail");
});

test("CLI validates anchored publish source lock before package release", () => {
  const cwd = path.join(root, "fixtures/libnode-shaped");
  const report = JSON.parse(runBuildchain([
    "publish-source",
    "validate-anchored-release",
    "--cwd",
    cwd,
    "--json",
  ], {
    env: {
      BUILDCHAIN_PUBLISH_SOURCE_REF: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      BUILDCHAIN_PUBLISH_SOURCE_SHA: "c".repeat(40),
      BUILDCHAIN_PUBLISH_SOURCE_LOCKED: "true",
    },
  }));

  assert.equal(report.ok, true);
  assert.equal(report.summary.publishSource.consumerVersion, "22.22.3-kf.0");

  const directBranch = runBuildchainFailure([
    "publish-source",
    "validate-anchored-release",
    "--cwd",
    cwd,
    "--json",
  ], {
    env: {
      BUILDCHAIN_PUBLISH_SOURCE_REF: "release/v22/v22.22",
      BUILDCHAIN_PUBLISH_SOURCE_SHA: "d".repeat(40),
      BUILDCHAIN_PUBLISH_SOURCE_LOCKED: "true",
    },
  });
  assert.notEqual(directBranch.status, 0);
  const failure = JSON.parse(directBranch.stdout);
  assert.equal(failure.checks.find((entry) => entry.id === "publish.source_ref").status, "fail");
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

  assert.equal(summary.contract, BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT);
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

test("diagnostics SDK infers requested parallelism from sampled process descendants", () => {
  const samples = [
    {
      timestamp: "2026-07-03T00:00:00.000Z",
      processes: [
        { pid: "100", command: "zsh", commandLine: "zsh -c scripts/build.sh", cpu: 0.2 },
        { pid: "101", command: "make", commandLine: "/usr/bin/make -j20 V=1", cpu: 5.3 },
        { pid: "102", command: "clang++", commandLine: "clang++ -c addon.cc", cpu: 92.5 },
      ],
    },
  ];

  const detected = detectRequestedParallelismFromProcessSamples(samples);
  assert.equal(detected.value, 20);
  assert.equal(detected.source, "process-tree");
  assert.equal(detected.evidence.command, "make");
  assert.equal(detected.evidence.token, "-j20");

  const summary = summarizeProcessSamples({
    command: "zsh",
    args: ["-c", "scripts/build.sh"],
    env: {},
    samples,
  });
  assert.equal(summary.requestedParallelism, 20);
  assert.equal(summary.requestedParallelismSource, "process-tree");
  assert.equal(summary.requestedParallelismEvidence.command, "make");
  assert.equal(summary.requestedParallelismCandidates.length, 1);
  assert.equal(summary.observedConcurrency.ratioToRequestedMax, 0.15);
});

test("diagnostics SDK keeps explicit requested parallelism authoritative over process-tree inference", () => {
  const summary = summarizeProcessSamples({
    requestedParallelism: 4,
    command: "zsh",
    args: ["-c", "scripts/build.sh"],
    env: {},
    samples: [
      {
        processes: [
          { command: "cmake", commandLine: "cmake --build build --parallel 12", cpu: 1 },
        ],
      },
    ],
  });

  assert.equal(summary.requestedParallelism, 4);
  assert.equal(summary.requestedParallelismSource, "explicit");
  assert.equal(summary.requestedParallelismEvidence.source, "explicit");
  assert.equal(summary.requestedParallelismCandidates[0].value, 12);
});

test("diagnostics SDK detects common build tool parallel flags from process samples", () => {
  const detected = detectRequestedParallelismFromProcessSamples([
    {
      processes: [
        { command: "cmake", commandLine: "cmake --build build --parallel=8", cpu: 1 },
        { command: "MSBuild.exe", commandLine: "MSBuild.exe libnode.sln /m:12", cpu: 1 },
        { command: "xcodebuild", commandLine: "xcodebuild -jobs 6", cpu: 1 },
      ],
    },
  ]);

  assert.equal(detected.value, 12);
  assert.equal(detected.candidates.map((entry) => entry.value).join(","), "12,8,6");
});

test("diagnostics SDK summarizes lifecycle timing across diagnostic artifacts", () => {
  const summary = summarizeDiagnosticsArtifacts([
    {
      runner: {
        github: { actions: true, runnerOs: "Linux", runnerArch: "X64", runnerName: "runner-linux" },
        os: { platform: "linux", release: "6.8", arch: "x64", type: "Linux" },
        cpu: { logicalCount: 16, model: "EPYC", loadAverage: [1.2, 0.8, 0.4] },
        memory: { totalBytes: 32000, freeBytes: 16000 },
        uptimeSeconds: 42,
      },
      tools: {
        node: { version: "v24.0.0" },
        pnpm: { version: "11.0.0" },
        cmake: { version: "" },
      },
      cache: {
        packageManager: { name: "pnpm", reason: "packageManager", packageManager: "pnpm@11.0.0" },
        workspace: { "@kungfu-tech/buildchain": { location: "." } },
        dirs: [{ path: ".pnpm-store", exists: true, type: "directory", bytes: 0 }],
        compilerCaches: {
          ccache: {
            available: true,
            format: "json",
            rawBytes: 64,
            stats: { cache_hit_direct: 7, cache_miss: 3 },
          },
          sccache: { available: false, error: "ENOENT" },
        },
      },
      native: {
        tools: {
          ninja: { version: "1.12.0" },
          ccache: { version: "4.10" },
        },
        cacheDirs: [{ path: ".ccache", exists: true, type: "directory", bytes: 0 }],
      },
      git: { head: "abc123" },
      lifecycleObservability: {
        stages: {
          build: { durationMs: 300, eventCount: 2 },
          install: { durationMs: 100, eventCount: 1 },
        },
        topSlowSpans: [
          { event: "native.compile", stage: "build", durationMs: 250 },
        ],
        warningCount: 1,
        errorCount: 0,
      },
      process: { observedConcurrency: { max: 4 } },
    },
    {
      runner: { os: { platform: "darwin", arch: "arm64" } },
      git: { head: "def456" },
      lifecycleObservability: {
        stages: {
          verify: { durationMs: 50, eventCount: 1 },
        },
        warningCount: 0,
        errorCount: 2,
      },
    },
  ]);

  assert.equal(summary.contract, BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalWarningCount, 1);
  assert.equal(summary.totalErrorCount, 2);
  assert.equal(summary.diagnosticsContractWarningCount, 2);
  assert.equal(summary.platforms[0].diagnosticsContract.status, "warning");
  assert.equal(summary.platforms[0].diagnosticsContract.expected, BUILDCHAIN_DIAGNOSTICS_CONTRACT);
  assert.equal(summary.platforms[0].diagnosticsContract.actual, "");
  assert.equal(summary.platforms[0].lifecycleTotalDurationMs, 400);
  assert.equal(summary.platforms[0].topSlowSpans[0].event, "native.compile");
  assert.equal(summary.platforms[0].runnerDetails.github.runnerName, "runner-linux");
  assert.equal(summary.platforms[0].runnerDetails.cpu.logicalCount, 16);
  assert.equal(summary.platforms[0].tools.checked, 5);
  assert.equal(summary.platforms[0].tools.available, 4);
  assert.deepEqual(summary.platforms[0].tools.missing, ["cmake"]);
  assert.equal(summary.platforms[0].tools.versions.ninja, "1.12.0");
  assert.equal(summary.platforms[0].cache.packageManager.name, "pnpm");
  assert.equal(summary.platforms[0].cache.workspacePackages, 1);
  assert.equal(summary.platforms[0].cache.compilerCaches.ccache.available, true);
  assert.equal(summary.platforms[0].cache.compilerCaches.ccache.stats.cache_hit_direct, 7);
  assert.equal(summary.platforms[0].cache.compilerCaches.sccache.error, "ENOENT");
  assert.equal(summary.platforms[0].cache.nativeCacheDirs[0].path, ".ccache");
  assert.equal(summary.platforms[1].lifecycleTotalDurationMs, 50);
  assert.deepEqual(summary.slowestPlatforms.map((entry) => entry.gitHead), ["abc123", "def456"]);
  assert.deepEqual(summary.slowestPlatforms[0].process, {
    requestedParallelism: 0,
    requestedParallelismSource: "",
    observedConcurrencyMax: 4,
    ratioToRequestedMax: 0,
    sampleCount: 0,
    categories: {},
    topCommands: [],
  });
});

test("CLI summarizes diagnostics artifacts into a small cross-platform report", () => {
  const cwd = tempDir("diagnostics-summary");
  const linuxArtifact = path.join(cwd, "linux-diagnostics.json");
  const linuxManifest = path.join(cwd, "linux-diagnostics-manifest.json");
  const macosArtifact = path.join(cwd, "macos-diagnostics.json");
  const outputPath = path.join(cwd, "diagnostics-summary.json");

  fs.writeFileSync(linuxArtifact, JSON.stringify({
    contract: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    runner: {
      github: { actions: true, runnerOs: "Linux", runnerArch: "X64", runnerName: "runner-linux" },
      os: { platform: "linux", release: "6.8", arch: "x64", type: "Linux" },
      cpu: { logicalCount: 8, model: "EPYC", loadAverage: [1, 0.5, 0.25] },
      memory: { totalBytes: 64000, freeBytes: 32000 },
      uptimeSeconds: 120,
    },
    tools: {
      node: { version: "v24.0.0" },
      pnpm: { version: "11.0.0" },
      ninja: { version: "" },
    },
    cache: {
      packageManager: { name: "pnpm", reason: "packageManager", packageManager: "pnpm@11.0.0" },
      workspace: { "@kungfu-tech/buildchain": { location: "." } },
      dirs: [{ path: ".pnpm-store", exists: true, type: "directory", bytes: 0 }],
      compilerCaches: {
        ccache: {
          available: true,
          format: "json",
          rawBytes: 64,
          stats: { cache_hit_direct: 5, cache_miss: 2 },
        },
      },
    },
    git: { head: "abc123def456" },
    lifecycleObservability: {
      stages: {
        build: { durationMs: 900, eventCount: 2 },
        verify: { durationMs: 100, eventCount: 1 },
      },
      artifactScan: { durationMs: 1250 },
      artifactUpload: { durationMs: 62000 },
      totalBytes: 4096,
      fileCount: 2,
      warningCount: 2,
      errorCount: 0,
    },
    process: {
      requestedParallelism: 20,
      requestedParallelismSource: "command",
      observedConcurrency: { max: 4, ratioToRequestedMax: 0.2 },
      sampleCount: 3,
      categories: { compiler: 4 },
      topCommands: [
        { command: "clang++", category: "compiler", maxConcurrent: 4, maxCpu: 95.5 },
        { command: "ninja", category: "build-tool", maxConcurrent: 1, maxCpu: 5 },
        { command: "ccache", category: "cache", maxConcurrent: 2, maxCpu: 3.5 },
        { command: "sleep", category: "other", maxConcurrent: 1, maxCpu: 0 },
      ],
    },
    links: { diagnosticsManifest: linuxManifest },
  }, null, 2));
  const linuxStat = fs.statSync(linuxArtifact);
  fs.writeFileSync(linuxManifest, JSON.stringify({
    schemaVersion: 1,
    contract: BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
    artifactName: "linux-artifact",
    platformId: "linux-x64",
    fileCount: 1,
    totalBytes: linuxStat.size,
    files: [
      {
        kind: "diagnostics",
        path: "linux-diagnostics.json",
        bytes: linuxStat.size,
        sha256: sha256File(linuxArtifact),
        required: true,
      },
    ],
  }, null, 2));
  fs.writeFileSync(macosArtifact, JSON.stringify({
    contract: "consumer-build-diagnostics",
    runner: { github: { runnerOs: "macOS", runnerArch: "ARM64" } },
    git: { head: "def456abc123" },
    lifecycleObservability: {
      stages: {
        install: { durationMs: 26000, eventCount: 1 },
        build: { durationMs: 3000, eventCount: 2 },
      },
      topSlowSpans: [
        { event: "native.archive", stage: "build", durationMs: 2500 },
      ],
      warningCount: 0,
      errorCount: 1,
    },
    process: {
      requestedParallelism: 8,
      requestedParallelismSource: "env:MAKEFLAGS",
      observedConcurrency: { max: 6, ratioToRequestedMax: 0.75 },
      sampleCount: 2,
    },
  }, null, 2));

  const summary = JSON.parse(runBuildchain([
    "diagnostics",
    "summary",
    linuxArtifact,
    "--artifact",
    macosArtifact,
    "--output",
    outputPath,
    "--json",
  ], { cwd }));

  assert.equal(summary.contract, BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalWarningCount, 2);
  assert.equal(summary.totalErrorCount, 1);
  assert.equal(summary.diagnosticsManifestWarningCount, 1);
  assert.equal(summary.diagnosticsContractWarningCount, 1);
  assert.deepEqual(summary.slowestPlatforms.map((entry) => entry.gitHead), ["abc123def456", "def456abc123"]);
  assert.equal(summary.platforms[0].artifactUploadDurationMs, 62000);
  assert.equal(summary.platforms[0].totalDurationMs, 64250);
  assert.equal(summary.platforms[0].totalBytes, 4096);
  assert.equal(summary.platforms[0].fileCount, 2);
  assert.equal(summary.platforms[0].runnerDetails.github.runnerName, "runner-linux");
  assert.equal(summary.platforms[0].tools.missing[0], "ninja");
  assert.equal(summary.platforms[0].cache.packageManager.packageManager, "pnpm@11.0.0");
  assert.equal(summary.platforms[0].cache.compilerCaches.ccache.stats.cache_miss, 2);
  assert.equal(summary.platforms[0].diagnosticsContract.status, "verified");
  assert.equal(summary.platforms[0].diagnosticsManifest.status, "verified");
  assert.equal(summary.platforms[0].diagnosticsManifest.fileCount, 1);
  assert.equal(summary.platforms[1].diagnosticsContract.status, "warning");
  assert.equal(summary.platforms[1].diagnosticsContract.actual, "consumer-build-diagnostics");
  assert.equal(summary.platforms[1].diagnosticsManifest.status, "missing");
  assert.equal(summary.platforms[1].diagnosticsManifest.warningCount, 1);
  assert.equal(summary.slowestPlatforms[0].process.requestedParallelism, 20);
  assert.equal(summary.slowestPlatforms[0].process.observedConcurrencyMax, 4);
  assert.equal(summary.slowestPlatforms[0].process.ratioToRequestedMax, 0.2);
  assert.deepEqual(
    summary.slowestPlatforms[0].process.topCommands.map((entry) => entry.command),
    ["clang++", "ninja", "ccache"],
  );
  assert.equal(summary.platforms[1].topSlowSpans[0].event, "native.archive");
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), summary);

  const table = formatDiagnosticsSummaryTable(summary);
  assert.match(table, /platform\s+head\s+install\s+build\s+verify\s+publish\s+scan\s+upload\s+total\s+jobs\s+active\s+warn\s+err/);
  assert.match(table, /Linux\/X64\s+abc123def456\s+-\s+900ms\s+100ms\s+-\s+1\.3s\s+1m2s\s+1m4s\s+20\s+4\s+2\s+0/);
  assert.match(table, /macOS\/ARM64\s+def456abc123\s+26s\s+3s\s+-\s+-\s+-\s+-\s+29s\s+8\s+6\s+0\s+1/);

  const humanOutput = runBuildchain(["diagnostics", "summary", linuxArtifact, macosArtifact], { cwd });
  assert.match(humanOutput, /buildchain diagnostics summary: 2 platforms/);
  assert.match(humanOutput, /platform\s+head\s+install\s+build\s+verify\s+publish\s+scan\s+upload\s+total\s+jobs\s+active\s+warn\s+err/);
  assert.match(humanOutput, /macOS\/ARM64\s+def456abc123\s+26s\s+3s\s+-\s+-\s+-\s+-\s+29s\s+8\s+6\s+0\s+1/);

  const missing = runBuildchainFailure(["diagnostics", "summary", linuxArtifact, path.join(cwd, "missing.json")], { cwd });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /read 1\/2 artifacts/);

  const missingArtifactValue = runBuildchainFailure(["diagnostics", "summary", linuxArtifact, "--artifact", "--json"], { cwd });
  assert.equal(missingArtifactValue.status, 1);
  assert.match(missingArtifactValue.stderr, /--artifact requires a file path/);
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

test("diagnostics SDK applies optional native diagnostics profile", () => {
  const cwd = tempDir("native-diagnostics-profile");
  fs.mkdirSync(path.join(cwd, "build"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "build", "artifact.txt"), "ok");
  fs.mkdirSync(path.join(cwd, ".ccache"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "buildchain.toml"), `schema = 1

[diagnostics.native]
enabled = true
sample_process_tree = true
compiler_cache = "ccache"
expected_tools = ["node", "ccache"]
artifact_dirs = ["build", "dist"]
cache_dirs = [".ccache"]
`);

  const runCommand = (command) => {
    if (command === "ccache") {
      return JSON.stringify({ cache_hit_direct: 2, cache_miss: 1 });
    }
    throw new Error("unexpected cache command");
  };
  const native = collectNativeDiagnostics({ cwd, runCommand });
  assert.equal(native.enabled, true);
  assert.equal(native.profile.sampleProcessTree, true);
  assert.equal(native.profile.compilerCache, "ccache");
  assert.equal(native.artifactDirs[0].path, "build");
  assert.equal(native.artifactDirs[0].exists, true);
  assert.equal(native.artifactDirs[1].exists, false);
  assert.equal(native.cacheDirs[0].path, ".ccache");
  assert.equal(native.compilerCaches.ccache.stats.cache_hit_direct, 2);
  assert.equal(native.compilerCaches.sccache, undefined);

  const artifact = createDiagnosticsArtifact({ cwd });
  assert.equal(artifact.native.enabled, true);
  assert.equal(artifact.native.profile.compilerCache, "ccache");
  assert.deepEqual(
    artifact.buildchain.config.diagnostics.native.artifactDirs,
    ["build", "dist"],
  );
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

test("CLI samples a long-running process tree and preserves concurrency context", () => {
  const cwd = tempDir("process-sample-cli");
  const samplesPath = path.join(cwd, ".buildchain", "diagnostics", "samples.jsonl");
  const summaryPath = path.join(cwd, ".buildchain", "diagnostics", "summary.json");
  const output = JSON.parse(runBuildchain([
    "sample",
    "process-tree",
    "--interval-ms",
    "60000",
    "--label",
    "native-build",
    "--output",
    samplesPath,
    "--summary-output",
    summaryPath,
    "--json",
    "--",
    process.execPath,
    "-e",
    "setTimeout(() => process.exit(0), 30)",
    "--",
    "-j3",
  ], { cwd }));

  assert.equal(output.contract, BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT);
  assert.equal(output.label, "native-build");
  assert.equal(output.command, path.basename(process.execPath));
  assert.equal(output.exit.status, 0);
  assert.equal(output.summary.contract, BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT);
  assert.equal(output.summary.requestedParallelism, 3);
  assert.equal(output.summary.requestedParallelismSource, "command");
  assert.equal(output.summary.sampleCount >= 1, true);
  assert.ok(fs.existsSync(samplesPath));
  assert.deepEqual(JSON.parse(fs.readFileSync(summaryPath, "utf8")), output);
  const samples = fs.readFileSync(samplesPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(samples.length, output.summary.sampleCount);
  assert.equal(samples[0].label, "native-build");
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
  assert.ok(result.pack.files.some((file) => file.path === "package.json"));
});

test("npm dry-run proves Buildchain toolkit subpaths are included in the package", () => {
  const result = JSON.parse(runBuildchain([
    "npm",
    "dry-run",
    "--cwd",
    root,
    "--json",
    "--skip-npm-publish-dry-run",
  ]));
  const packageFiles = new Set(result.pack.files.map((file) => file.path));

  assert.equal(result.package.name, "@kungfu-tech/buildchain");
  assert.equal(result.wouldPublish, false);
  assert.ok(packageFiles.has("packages/core/index.js"));
  assert.ok(packageFiles.has("packages/core/diagnostics.js"));
  assert.ok(packageFiles.has("packages/core/logging.js"));
  assert.ok(packageFiles.has("packages/core/release-passport.js"));
  assert.ok(packageFiles.has("bin/buildchain.mjs"));
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

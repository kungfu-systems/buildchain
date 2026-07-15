import crypto from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBuildchainConfig,
  normalizeLifecycleStage,
  runLifecycleStage,
} from "../packages/core/buildchain-config.js";
import {
  createBuildchainLogger,
  readBuildchainLogEvents,
  summarizeBuildchainLogEvents,
} from "../packages/core/logging.js";
import {
  BUILDCHAIN_DIAGNOSTICS_CONTRACT,
  BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
  createDiagnosticsArtifact,
  summarizeLifecycleObservability,
  writeDiagnosticsArtifact,
} from "../packages/core/diagnostics.js";
import {
  createArtifactSummary,
  parseExpectedArtifactsJson,
  validateExpectedArtifacts,
} from "./build-contract-core.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const buildchainCliCandidates = [
  path.resolve(moduleDir, "..", "bin", "buildchain.mjs"),
  path.resolve(moduleDir, "..", "..", "..", "bin", "buildchain.mjs"),
  path.resolve(process.cwd(), ".buildchain", "runtime", "bin", "buildchain.mjs"),
];

function resolveBuildchainCliPath() {
  return buildchainCliCandidates.find((candidate) => fs.existsSync(candidate)) || buildchainCliCandidates[0];
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function listFiles(root, rel) {
  const target = path.isAbsolute(rel) ? rel : path.join(root, rel);
  if (!fs.existsSync(target)) {
    return [];
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [target];
  }
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => listFiles(root, path.join(target, entry.name)));
}

function manifestPathFor(root, filePath) {
  const relative = path.relative(root, filePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return toPosix(relative);
  }
  return toPosix(path.resolve(filePath));
}

function lifecycleErrorAttributes(error, extra = {}) {
  const attributes = {
    ...extra,
    errorName: error.name,
    status: error.status ?? "",
    signal: error.signal || "",
  };
  if (error.stdoutTail) {
    attributes.stdoutTail = error.stdoutTail;
  }
  if (error.stderrTail) {
    attributes.stderrTail = error.stderrTail;
  }
  if (error.wrappedCommand) {
    attributes.wrappedCommand = error.wrappedCommand;
    attributes.wrappedCommandExitCode = error.wrappedCommand.exitCode ?? "";
    attributes.wrappedCommandSignal = error.wrappedCommand.signal || "";
    attributes.wrappedCommandError = error.wrappedCommand.error || "";
  }
  if (error.samplerUnavailable !== undefined) {
    attributes.samplerUnavailable = error.samplerUnavailable;
  }
  return attributes;
}

function describeLifecycleTimeout(error, {
  timeoutMinutes,
  stageName,
  platformId,
  platformName,
}) {
  if (
    !timeoutMinutes ||
    (error?.code !== "ETIMEDOUT" && error?.signal !== "SIGTERM")
  ) {
    return error;
  }
  const timeoutError = new Error(
    `lifecycle ${stageName || "command"} timed out after ${timeoutMinutes} minute(s) on ${platformName} (${platformId})`,
    { cause: error },
  );
  timeoutError.name = "LifecycleTimeoutError";
  timeoutError.code = "ETIMEDOUT";
  timeoutError.signal = error?.signal || "";
  return timeoutError;
}

function collectArtifactFiles(root, patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    const clean = pattern.replace(/\\/g, "/").replace(/\/\*\*\/?\*?$/, "");
    for (const file of listFiles(root, clean)) {
      files.add(path.resolve(file));
    }
  }
  return [...files].sort();
}

function readProcessSummaryArtifact(filePath) {
  if (!filePath) {
    return undefined;
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`process summary file not found: ${filePath}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read process summary file ${filePath}: ${error.message}`);
  }
  if (artifact?.contract === BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT && artifact.summary) {
    return {
      artifact,
      summary: artifact.summary,
      samplesPath: artifact.samplesPath || "",
    };
  }
  if (artifact?.contract === BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT) {
    return {
      artifact,
      summary: artifact,
      samplesPath: "",
    };
  }
  throw new Error(`process summary file has unsupported contract: ${artifact?.contract || "unknown"}`);
}

function readOptionalProcessSummaryArtifact(filePath) {
  try {
    return readProcessSummaryArtifact(filePath);
  } catch {
    return undefined;
  }
}

function attachProcessSampleFailureEvidence(error, processSummaryPath) {
  const artifact = readOptionalProcessSummaryArtifact(processSummaryPath)?.artifact;
  const wrappedCommand = artifact?.wrappedCommand;
  if (wrappedCommand) {
    error.wrappedCommand = wrappedCommand;
    error.stdoutTail = wrappedCommand.stdoutTail || "";
    error.stderrTail = wrappedCommand.stderrTail || "";
    error.status = wrappedCommand.exitCode ?? error.status;
    error.signal = wrappedCommand.signal || error.signal || "";
  }
  if (artifact?.summary?.sampler) {
    error.samplerUnavailable = Boolean(artifact.summary.sampler.unavailable);
  }
  return error;
}

function shellCommandArgs(command, shell) {
  if (typeof shell === "string" && shell.trim()) {
    return [shell, "-c", command];
  }
  if (process.platform === "win32") {
    return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", command];
  }
  return [process.env.SHELL || "/bin/sh", "-c", command];
}

function samplerPathForCwd(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? toPosix(relative)
    : filePath;
}

function executeSampledShellCommand({
  command,
  cwd,
  env,
  shell,
  timeout,
  label,
  processSummaryPath,
  processSamplesPath,
  processSampleIntervalMs,
  requestedParallelism,
}) {
  fs.mkdirSync(path.dirname(processSummaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(processSamplesPath), { recursive: true });
  const args = [
    resolveBuildchainCliPath(),
    "sample",
    "process-tree",
    "--label",
    label || "lifecycle",
    "--interval-ms",
    String(processSampleIntervalMs || 15000),
    "--output",
    samplerPathForCwd(processSamplesPath, cwd),
    "--summary-output",
    samplerPathForCwd(processSummaryPath, cwd),
  ];
  if (Number(requestedParallelism || 0) > 0) {
    args.push("--requested-parallelism", String(Number(requestedParallelism)));
  }
  args.push("--", ...shellCommandArgs(command, shell));
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout,
  });
  if (result.error || result.status !== 0 || result.signal) {
    const error = result.error || new Error(`sampled lifecycle command failed with status ${result.status ?? ""}`);
    error.status = result.status ?? error.status ?? 1;
    error.signal = result.signal || error.signal || "";
    attachProcessSampleFailureEvidence(error, processSummaryPath);
    throw error;
  }
}

function stageCommandText(stage) {
  if (stage.mode === "script") {
    return stage.script;
  }
  if (process.platform === "win32") {
    return stage.commands.join(" && ");
  }
  return ["set -e", ...stage.commands].join("\n");
}

function runLifecycleStageWithSampler({
  cwd,
  loadedConfig,
  name,
  env,
  sampleProcessTree,
  processSummaryPath,
  processSamplesPath,
  processSampleIntervalMs,
  requestedParallelism,
  timeoutMinutes,
}) {
  if (!sampleProcessTree) {
    return runLifecycleStage({ cwd, loadedConfig, name, env, timeoutMinutes });
  }
  const lifecycle = loadedConfig?.config?.lifecycle || {};
  const stage = lifecycle[name];
  if (!stage) {
    return false;
  }
  const stageEnv = {
    ...process.env,
    ...(lifecycle.env || {}),
    ...(stage.env || {}),
    ...(env || {}),
  };
  const effectiveTimeoutMinutes = stage.timeoutMinutes ?? timeoutMinutes;
  const timeout = effectiveTimeoutMinutes ? effectiveTimeoutMinutes * 60_000 : undefined;
  let lastError;
  for (let attempt = 1; attempt <= stage.retries; attempt += 1) {
    try {
      executeSampledShellCommand({
        command: stageCommandText(stage),
        cwd,
        env: stageEnv,
        shell: stage.shell || true,
        timeout,
        label: `lifecycle-${name}`,
        processSummaryPath,
        processSamplesPath,
        processSampleIntervalMs,
        requestedParallelism,
      });
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < stage.retries) {
        console.log(`> lifecycle ${name || "stage"} failed, retry ${attempt + 1}/${stage.retries}`);
      }
    }
  }
  throw lastError;
}

function writeJsonlEvents(filePath, events = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""));
}

function copyIfExists(sourcePath, targetPath) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function resolveLinkedFilePath({ linkedPath = "", workspace, cwd, fallbackDir }) {
  if (!linkedPath) {
    return "";
  }
  const candidates = path.isAbsolute(linkedPath)
    ? [linkedPath]
    : [
        path.resolve(workspace, linkedPath),
        path.resolve(cwd, linkedPath),
        path.resolve(fallbackDir, linkedPath),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || "";
}

function diagnosticsSidecarEntry({ kind, filePath, workspace, required = false }) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    return null;
  }
  return {
    kind,
    path: toPosix(path.relative(workspace, filePath)),
    bytes: stat.size,
    sha256: sha256File(filePath),
    required: Boolean(required),
  };
}

function writeDiagnosticsSidecarManifest(filePath, {
  workspace,
  artifactName,
  platformId,
  diagnosticsArtifactName = "",
  files = [],
}) {
  const entries = files
    .map((entry) => diagnosticsSidecarEntry({ ...entry, workspace }))
    .filter(Boolean);
  const manifest = {
    schemaVersion: 1,
    contract: BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT,
    generatedAt: new Date().toISOString(),
    artifactName,
    platformId,
    ...(diagnosticsArtifactName ? { diagnosticsArtifactName } : {}),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function runLifecycle({
  cwd = process.cwd(),
  stageName = "",
  command = "",
  required = false,
  timeoutMinutes,
  manifestPath = ".buildchain/artifacts/manifest.json",
  summaryPath = ".buildchain/artifacts/summary.json",
  diagnosticsPath = "",
  artifactName = "buildchain-artifact",
  manifestArtifactName = "",
  diagnosticsArtifactName = "",
  platformId = os.platform(),
  platformName = platformId,
  artifactPaths = [],
  expectedArtifactsJson = "",
  workspace = process.cwd(),
  logPath = process.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl",
  processSummaryPath = "",
  processSamplesPath = ".buildchain/diagnostics/process-samples.jsonl",
  sampleProcessTree = false,
  processSampleIntervalMs = 15000,
  requestedParallelism = 0,
  processSummaryRequired = true,
} = {}) {
  if (timeoutMinutes !== undefined && (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0)) {
    throw new Error("lifecycle timeoutMinutes must be a positive number");
  }
  const resolvedCwd = path.resolve(cwd);
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedManifestPath = path.resolve(resolvedWorkspace, manifestPath);
  const resolvedSummaryPath = path.resolve(resolvedWorkspace, summaryPath);
  const resolvedDiagnosticsPath = path.resolve(
    resolvedWorkspace,
    diagnosticsPath || path.join(path.dirname(manifestPath), "diagnostics.json"),
  );
  const resolvedLogPath = logPath ? path.resolve(resolvedWorkspace, logPath) : "";
  const resolvedProcessSummaryPath = processSummaryPath || sampleProcessTree
    ? path.resolve(resolvedWorkspace, processSummaryPath || ".buildchain/diagnostics/process-summary.json")
    : "";
  const resolvedProcessSamplesPath = processSamplesPath
    ? path.resolve(resolvedWorkspace, processSamplesPath)
    : path.resolve(resolvedWorkspace, ".buildchain/diagnostics/process-samples.jsonl");
  const relativeLogPath = resolvedLogPath ? toPosix(path.relative(resolvedWorkspace, resolvedLogPath)) : "";
  const relativeProcessSummaryPath = resolvedProcessSummaryPath
    ? toPosix(path.relative(resolvedWorkspace, resolvedProcessSummaryPath))
    : "";
  const relativeDiagnosticsPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsPath));
  const diagnosticsDir = path.dirname(resolvedDiagnosticsPath);
  const resolvedDiagnosticsEventsPath = path.join(diagnosticsDir, "events.jsonl");
  const resolvedDiagnosticsProcessSummaryPath = path.join(diagnosticsDir, "process-summary.json");
  const resolvedDiagnosticsProcessSamplesPath = path.join(diagnosticsDir, "process-samples.jsonl");
  const resolvedSourceCheckoutPath = path.resolve(resolvedWorkspace, ".buildchain/diagnostics/source-checkout.json");
  const resolvedDiagnosticsSourceCheckoutPath = path.join(diagnosticsDir, "source-checkout.json");
  const resolvedDiagnosticsManifestPath = path.join(diagnosticsDir, "diagnostics-manifest.json");
  const relativeDiagnosticsEventsPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsEventsPath));
  const relativeDiagnosticsProcessSummaryPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsProcessSummaryPath));
  const relativeDiagnosticsProcessSamplesPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsProcessSamplesPath));
  const relativeDiagnosticsSourceCheckoutPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsSourceCheckoutPath));
  const relativeDiagnosticsManifestPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsManifestPath));
  const logRunId = crypto.randomUUID();
  const frameworkLog = createBuildchainLogger({
    cwd: resolvedWorkspace,
    path: resolvedLogPath || false,
    console: false,
    source: "buildchain",
    component: "lifecycle",
    phase: stageName || "lifecycle",
    attributes: { buildchainLogRunId: logRunId },
  });
  const userLog = createBuildchainLogger({
    cwd: resolvedWorkspace,
    path: resolvedLogPath || false,
    console: false,
    source: "user",
    component: "lifecycle",
    phase: stageName || "lifecycle",
    attributes: { buildchainLogRunId: logRunId },
  });
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  let commandSource = "none";
  let executed = false;

  frameworkLog.info("lifecycle.start", {
    attributes: {
      stage: stageName,
      artifactName,
      platformId,
    },
  });

  if (command.trim()) {
    commandSource = "workflow-input";
    const lifecycle = loadedConfig?.config?.lifecycle || {};
    const configuredStage = stageName ? lifecycle[stageName] : undefined;
    const commandShell = configuredStage?.shell || true;
    const effectiveCommandTimeoutMinutes = configuredStage?.timeoutMinutes ?? timeoutMinutes;
    const startedAt = Date.now();
    userLog.info("lifecycle.command.start", {
      attributes: {
        commandSource,
        stage: stageName || "command",
        sampleProcessTree,
      },
    });
    try {
      const commandEnv = {
        ...process.env,
        ...(lifecycle.env || {}),
        ...(configuredStage?.env || {}),
        ...(resolvedLogPath
          ? {
              BUILDCHAIN_LOG_PATH: resolvedLogPath,
              BUILDCHAIN_LOG_RUN_ID: logRunId,
            }
          : {}),
      };
      if (sampleProcessTree) {
        executeSampledShellCommand({
          command,
          cwd: resolvedCwd,
          env: commandEnv,
          shell: commandShell,
          label: `lifecycle-${stageName || "command"}`,
          processSummaryPath: resolvedProcessSummaryPath,
          processSamplesPath: resolvedProcessSamplesPath,
          processSampleIntervalMs,
          requestedParallelism,
          timeout: effectiveCommandTimeoutMinutes ? effectiveCommandTimeoutMinutes * 60_000 : undefined,
        });
      } else {
        execSync(command, {
          cwd: resolvedCwd,
          env: commandEnv,
          shell: commandShell,
          stdio: "inherit",
          timeout: effectiveCommandTimeoutMinutes ? effectiveCommandTimeoutMinutes * 60_000 : undefined,
        });
      }
      executed = true;
      userLog.info("lifecycle.command.end", {
        durationMs: Date.now() - startedAt,
        attributes: {
          commandSource,
          stage: stageName || "command",
        },
      });
    } catch (error) {
      const lifecycleError = describeLifecycleTimeout(error, {
        timeoutMinutes: effectiveCommandTimeoutMinutes,
        stageName,
        platformId,
        platformName,
      });
      userLog.error("lifecycle.command.error", {
        durationMs: Date.now() - startedAt,
        message: "lifecycle command failed",
        attributes: lifecycleErrorAttributes(lifecycleError, {
          commandSource,
          stage: stageName || "command",
          sampleProcessTree,
        }),
      });
      throw lifecycleError;
    }
  } else if (stageName) {
    commandSource = "buildchain.toml";
    const startedAt = Date.now();
    userLog.info("lifecycle.stage.start", {
      attributes: {
        commandSource,
        stage: stageName,
        sampleProcessTree,
      },
    });
    try {
      executed = runLifecycleStageWithSampler({
        cwd: resolvedCwd,
        loadedConfig,
        name: stageName,
        env: resolvedLogPath
          ? {
              BUILDCHAIN_LOG_PATH: resolvedLogPath,
              BUILDCHAIN_LOG_RUN_ID: logRunId,
            }
          : {},
        sampleProcessTree,
        processSummaryPath: resolvedProcessSummaryPath,
        processSamplesPath: resolvedProcessSamplesPath,
        processSampleIntervalMs,
        requestedParallelism,
        timeoutMinutes,
      });
      userLog.info("lifecycle.stage.end", {
        durationMs: Date.now() - startedAt,
        attributes: {
          commandSource,
          stage: stageName,
          executed,
        },
      });
    } catch (error) {
      const lifecycleError = describeLifecycleTimeout(error, {
        timeoutMinutes: loadedConfig?.config?.lifecycle?.[stageName]?.timeoutMinutes ?? timeoutMinutes,
        stageName,
        platformId,
        platformName,
      });
      userLog.error("lifecycle.stage.error", {
        durationMs: Date.now() - startedAt,
        message: "lifecycle stage failed",
        attributes: lifecycleErrorAttributes(lifecycleError, {
          commandSource,
          stage: stageName,
          sampleProcessTree,
        }),
      });
      throw lifecycleError;
    }
  }

  if (required && !executed) {
    frameworkLog.error("lifecycle.required-missing", {
      attributes: {
        stage: stageName || "command",
        commandSource,
      },
    });
    throw new Error(`required lifecycle stage did not run: ${stageName || "command"}`);
  }

  const shouldReadProcessSummary = Boolean(
    resolvedProcessSummaryPath
      && (fs.existsSync(resolvedProcessSummaryPath) || processSummaryRequired),
  );
  const processSummaryArtifact = shouldReadProcessSummary
    ? readProcessSummaryArtifact(resolvedProcessSummaryPath)
    : undefined;
  const sourceCheckoutArtifact = fs.existsSync(resolvedSourceCheckoutPath)
    ? JSON.parse(fs.readFileSync(resolvedSourceCheckoutPath, "utf8"))
    : undefined;
  fs.mkdirSync(path.dirname(resolvedManifestPath), { recursive: true });
  const scanStartedAt = Date.now();
  const files = collectArtifactFiles(resolvedWorkspace, artifactPaths);
  const manifestFiles = files.map((file) => {
    const stat = fs.statSync(file);
    return {
      path: manifestPathFor(resolvedWorkspace, file),
      size: stat.size,
      sha256: sha256File(file),
    };
  });
  const artifactScanDurationMs = Date.now() - scanStartedAt;
  frameworkLog.info("artifact.scan", {
    durationMs: artifactScanDurationMs,
    attributes: {
      fileCount: manifestFiles.length,
    },
  });
  const platform = {
    id: platformId,
    name: platformName,
    os: process.env.RUNNER_OS || os.platform(),
    arch: process.env.RUNNER_ARCH || os.arch(),
  };
  const summary = createArtifactSummary({
    artifactName,
    platform,
    files: manifestFiles,
  });
  const expected = parseExpectedArtifactsJson(expectedArtifactsJson);
  const expectedArtifacts = validateExpectedArtifacts({
    expected,
    files: manifestFiles,
    summary,
  });
  frameworkLog.info("artifact.manifest.write", {
    attributes: {
      manifestPath: toPosix(path.relative(resolvedWorkspace, resolvedManifestPath)),
      summaryPath: toPosix(path.relative(resolvedWorkspace, resolvedSummaryPath)),
    },
  });
  frameworkLog.info("lifecycle.end", {
    attributes: {
      stage: stageName,
      executed,
      fileCount: manifestFiles.length,
    },
  });
  const observability = {
    log: {
      contract: "kungfu-buildchain-log-event",
      runId: logRunId,
      path: relativeLogPath,
      summary: resolvedLogPath
        ? summarizeBuildchainLogEvents(
            readBuildchainLogEvents(resolvedLogPath).filter(
              (event) => event.attributes?.buildchainLogRunId === logRunId,
            ),
          )
        : summarizeBuildchainLogEvents([...frameworkLog.events, ...userLog.events]),
    },
  };
  const lifecycleObservability = summarizeLifecycleObservability({
    events: resolvedLogPath ? readBuildchainLogEvents(resolvedLogPath) : [...frameworkLog.events, ...userLog.events],
    logPath: relativeLogPath,
    artifactScanDurationMs,
    totalBytes: summary.totalBytes,
    fileCount: summary.fileCount,
  });
  observability.lifecycle = lifecycleObservability;
  observability.diagnostics = {
    contract: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    path: relativeDiagnosticsPath,
    manifestPath: relativeDiagnosticsManifestPath,
    eventsPath: relativeDiagnosticsEventsPath,
  };
  if (relativeProcessSummaryPath) {
    observability.process = {
      contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
      path: relativeProcessSummaryPath,
    };
  }
  const summaryWithObservability = {
    ...summary,
    observability,
  };
  const manifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-artifact",
    artifactName,
    platform,
    git: {
      repository: process.env.GITHUB_REPOSITORY || "",
      sha: process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "",
      ref: process.env.BUILDCHAIN_SOURCE_REF || process.env.GITHUB_REF || "",
      runId: process.env.GITHUB_RUN_ID || "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
    },
    lifecycle: {
      stage: stageName,
      commandSource,
      executed,
    },
    observability,
    summary: summaryWithObservability,
    expectedArtifacts,
    files: manifestFiles,
  };

  fs.writeFileSync(resolvedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.mkdirSync(path.dirname(resolvedSummaryPath), { recursive: true });
  fs.writeFileSync(resolvedSummaryPath, `${JSON.stringify(summaryWithObservability, null, 2)}\n`);
  writeDiagnosticsArtifact(
    resolvedDiagnosticsPath,
    createDiagnosticsArtifact({
      cwd: resolvedCwd,
      logPath: resolvedLogPath,
      artifactPaths,
      lifecycleObservability,
      processSummary: processSummaryArtifact?.summary,
      sourceCheckout: sourceCheckoutArtifact,
      links: {
        artifactName,
        platformId,
        ...(manifestArtifactName ? { manifestArtifactName } : {}),
        ...(diagnosticsArtifactName ? { diagnosticsArtifactName } : {}),
        manifest: toPosix(path.relative(resolvedWorkspace, resolvedManifestPath)),
        summary: toPosix(path.relative(resolvedWorkspace, resolvedSummaryPath)),
        log: relativeLogPath,
        diagnosticsManifest: relativeDiagnosticsManifestPath,
        diagnosticsEvents: relativeDiagnosticsEventsPath,
        ...(relativeProcessSummaryPath ? { processSummary: relativeProcessSummaryPath } : {}),
        ...(processSummaryArtifact ? { diagnosticsProcessSummary: relativeDiagnosticsProcessSummaryPath } : {}),
        ...(processSummaryArtifact?.samplesPath ? { diagnosticsProcessSamples: relativeDiagnosticsProcessSamplesPath } : {}),
        ...(sourceCheckoutArtifact ? { sourceCheckout: relativeDiagnosticsSourceCheckoutPath } : {}),
      },
    }),
  );
  if (resolvedLogPath && fs.existsSync(resolvedLogPath)) {
    copyIfExists(resolvedLogPath, resolvedDiagnosticsEventsPath);
  } else {
    writeJsonlEvents(resolvedDiagnosticsEventsPath, [...frameworkLog.events, ...userLog.events]);
  }
  if (processSummaryArtifact) {
    copyIfExists(resolvedProcessSummaryPath, resolvedDiagnosticsProcessSummaryPath);
    const resolvedSamplesPath = resolveLinkedFilePath({
      linkedPath: processSummaryArtifact.samplesPath,
      workspace: resolvedWorkspace,
      cwd: resolvedCwd,
      fallbackDir: path.dirname(resolvedProcessSummaryPath),
    });
    copyIfExists(resolvedSamplesPath, resolvedDiagnosticsProcessSamplesPath);
  }
  if (sourceCheckoutArtifact) {
    copyIfExists(resolvedSourceCheckoutPath, resolvedDiagnosticsSourceCheckoutPath);
  }
  writeDiagnosticsSidecarManifest(resolvedDiagnosticsManifestPath, {
    workspace: resolvedWorkspace,
    artifactName,
    platformId,
    diagnosticsArtifactName,
    files: [
      { kind: "diagnostics", filePath: resolvedDiagnosticsPath, required: true },
      { kind: "events", filePath: resolvedDiagnosticsEventsPath, required: true },
      { kind: "process-summary", filePath: resolvedDiagnosticsProcessSummaryPath },
      { kind: "process-samples", filePath: resolvedDiagnosticsProcessSamplesPath },
      { kind: "source-checkout", filePath: resolvedDiagnosticsSourceCheckoutPath },
    ],
  });
  console.log(`buildchain_manifest=${path.relative(resolvedWorkspace, resolvedManifestPath)}`);
  return manifest;
}

export function normalizeCommandStage(commandText) {
  return normalizeLifecycleStage({ command: commandText }, "workflow command");
}

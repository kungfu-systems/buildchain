import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBuildchainConfig,
  normalizeLifecycleStage,
  runLifecycleStage,
} from "../packages/core/buildchain-config.js";
import { runProcessTreeCommandSync, runShellCommandSync } from "../packages/core/spawn-command.js";
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
import { verifyCompilerCacheActivity } from "./compiler-cache-evidence.mjs";
import { lifecycleSubstageEvidenceContext } from "./lifecycle-substage-evidence.mjs";

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

function signingArtifactPathsForPlatform({ loadedConfig, cwd, platformId }) {
  const declarations = loadedConfig?.config?.signing?.artifacts || [];
  return declarations
    .filter(
      (entry) =>
        entry.platforms.length === 0 || entry.platforms.includes(platformId),
    )
    .map((entry) => path.resolve(cwd, entry.path));
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
    return [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", `"${command}"`];
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
  try {
    runProcessTreeCommandSync(process.execPath, args, {
      cwd,
      env,
      stdio: "inherit",
      timeout,
    });
  } catch (error) {
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

export function verifyBuildLifecycleCompilerCacheActivity({
  stageName = "",
  executed = false,
  cwd = process.cwd(),
  env = process.env,
  verifier = verifyCompilerCacheActivity,
  frameworkLog,
} = {}) {
  if (stageName !== "build" || !executed) return undefined;
  const activity = verifier({ cwd, env });
  if (activity) {
    frameworkLog?.info("compiler-cache.activity", { attributes: activity });
  }
  return activity;
}

function normalizeLifecycleOptions(options) {
  const normalized = { ...options };
  const defaults = {
    cwd: process.cwd(), stageName: "", command: "", required: false,
    manifestPath: ".buildchain/artifacts/manifest.json",
    summaryPath: ".buildchain/artifacts/summary.json", diagnosticsPath: "",
    artifactName: "buildchain-artifact", manifestArtifactName: "",
    diagnosticsArtifactName: "", platformId: os.platform(), artifactPaths: [],
    expectedArtifactsJson: "", workspace: process.cwd(),
    logPath: process.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl",
    processSummaryPath: "", processSamplesPath: ".buildchain/diagnostics/process-samples.jsonl",
    sampleProcessTree: false, processSampleIntervalMs: 15000, requestedParallelism: 0,
    processSummaryRequired: true, substageEvidencePath: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (normalized[key] === undefined) normalized[key] = value;
  }
  if (normalized.platformName === undefined) normalized.platformName = normalized.platformId;
  return normalized;
}

function resolveLifecyclePaths(options) {
  if (options.timeoutMinutes !== undefined && (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0)) {
    throw new Error("lifecycle timeoutMinutes must be a positive number");
  }
  const resolvedCwd = path.resolve(options.cwd);
  const resolvedWorkspace = path.resolve(options.workspace);
  const resolvedManifestPath = path.resolve(resolvedWorkspace, options.manifestPath);
  const resolvedSummaryPath = path.resolve(resolvedWorkspace, options.summaryPath);
  const resolvedDiagnosticsPath = path.resolve(
    resolvedWorkspace,
    options.diagnosticsPath || path.join(path.dirname(options.manifestPath), "diagnostics.json"),
  );
  const resolvedLogPath = options.logPath ? path.resolve(resolvedWorkspace, options.logPath) : "";
  const resolvedProcessSummaryPath = options.processSummaryPath || options.sampleProcessTree
    ? path.resolve(resolvedWorkspace, options.processSummaryPath || ".buildchain/diagnostics/process-summary.json")
    : "";
  const resolvedProcessSamplesPath = options.processSamplesPath
    ? path.resolve(resolvedWorkspace, options.processSamplesPath)
    : path.resolve(resolvedWorkspace, ".buildchain/diagnostics/process-samples.jsonl");
  const diagnosticsDir = path.dirname(resolvedDiagnosticsPath);
  const resolvedCompilerCachePreparationPath = path.resolve(
    resolvedWorkspace,
    process.env.BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH ||
      ".buildchain/diagnostics/compiler-cache-preparation.json",
  );
  const compilerCachePreparationRelative = path.relative(resolvedWorkspace, resolvedCompilerCachePreparationPath);
  if (compilerCachePreparationRelative.startsWith("..") || path.isAbsolute(compilerCachePreparationRelative)) {
    throw new Error("BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH must remain inside the workflow workspace");
  }
  return {
    resolvedCwd, resolvedWorkspace, resolvedManifestPath, resolvedSummaryPath,
    resolvedDiagnosticsPath, resolvedLogPath, resolvedProcessSummaryPath, resolvedProcessSamplesPath,
    relativeLogPath: resolvedLogPath ? toPosix(path.relative(resolvedWorkspace, resolvedLogPath)) : "",
    relativeProcessSummaryPath: resolvedProcessSummaryPath ? toPosix(path.relative(resolvedWorkspace, resolvedProcessSummaryPath)) : "",
    relativeDiagnosticsPath: toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsPath)),
    diagnosticsDir,
    resolvedDiagnosticsEventsPath: path.join(diagnosticsDir, "events.jsonl"),
    resolvedDiagnosticsProcessSummaryPath: path.join(diagnosticsDir, "process-summary.json"),
    resolvedDiagnosticsProcessSamplesPath: path.join(diagnosticsDir, "process-samples.jsonl"),
    resolvedSourceCheckoutPath: path.resolve(resolvedWorkspace, ".buildchain/diagnostics/source-checkout.json"),
    resolvedDiagnosticsSourceCheckoutPath: path.join(diagnosticsDir, "source-checkout.json"),
    resolvedCompilerCachePreparationPath,
    resolvedDiagnosticsCompilerCachePreparationPath: path.join(diagnosticsDir, "compiler-cache-preparation.json"),
    resolvedDiagnosticsManifestPath: path.join(diagnosticsDir, "diagnostics-manifest.json"),
  };
}

function addRelativeLifecyclePaths(paths) {
  const relative = (target) => toPosix(path.relative(paths.resolvedWorkspace, target));
  return {
    ...paths,
    relativeDiagnosticsEventsPath: relative(paths.resolvedDiagnosticsEventsPath),
    relativeDiagnosticsProcessSummaryPath: relative(paths.resolvedDiagnosticsProcessSummaryPath),
    relativeDiagnosticsProcessSamplesPath: relative(paths.resolvedDiagnosticsProcessSamplesPath),
    relativeDiagnosticsSourceCheckoutPath: relative(paths.resolvedDiagnosticsSourceCheckoutPath),
    relativeDiagnosticsCompilerCachePreparationPath:
      relative(paths.resolvedDiagnosticsCompilerCachePreparationPath),
    relativeDiagnosticsManifestPath: relative(paths.resolvedDiagnosticsManifestPath),
  };
}

function createLifecycleContext(options) {
  const paths = addRelativeLifecyclePaths(resolveLifecyclePaths(options));
  const logRunId = crypto.randomUUID();
  const loggerOptions = {
    cwd: paths.resolvedWorkspace,
    path: paths.resolvedLogPath || false,
    console: false,
    component: "lifecycle",
    phase: options.stageName || "lifecycle",
    attributes: { buildchainLogRunId: logRunId },
  };
  return {
    ...options, ...paths, logRunId,
    frameworkLog: createBuildchainLogger({ ...loggerOptions, source: "buildchain" }),
    userLog: createBuildchainLogger({ ...loggerOptions, source: "user" }),
    loadedConfig: loadBuildchainConfig(paths.resolvedCwd),
    commandSource: "none",
    executed: false,
  };
}

function executeWorkflowLifecycleCommand(context) {
  const {
    command, stageName, sampleProcessTree, processSampleIntervalMs, requestedParallelism,
    timeoutMinutes, resolvedCwd, resolvedLogPath, resolvedProcessSummaryPath,
    resolvedProcessSamplesPath, logRunId, loadedConfig, userLog, platformId, platformName,
  } = context;
  context.commandSource = "workflow-input";
  const lifecycle = loadedConfig?.config?.lifecycle || {};
  const configuredStage = stageName ? lifecycle[stageName] : undefined;
  const commandShell = configuredStage?.shell || true;
  const effectiveCommandTimeoutMinutes = configuredStage?.timeoutMinutes ?? timeoutMinutes;
  const startedAt = Date.now();
  userLog.info("lifecycle.command.start", {
    attributes: { commandSource: context.commandSource, stage: stageName || "command", sampleProcessTree },
  });
  try {
    const commandEnv = {
      ...process.env, ...(lifecycle.env || {}), ...(configuredStage?.env || {}),
      ...(resolvedLogPath ? { BUILDCHAIN_LOG_PATH: resolvedLogPath, BUILDCHAIN_LOG_RUN_ID: logRunId } : {}),
    };
    const timeout = effectiveCommandTimeoutMinutes ? effectiveCommandTimeoutMinutes * 60_000 : undefined;
    if (sampleProcessTree) {
      executeSampledShellCommand({
        command, cwd: resolvedCwd, env: commandEnv, shell: commandShell,
        label: `lifecycle-${stageName || "command"}`,
        processSummaryPath: resolvedProcessSummaryPath,
        processSamplesPath: resolvedProcessSamplesPath,
        processSampleIntervalMs, requestedParallelism, timeout,
      });
    } else {
      runShellCommandSync(command, {
        cwd: resolvedCwd, env: commandEnv, shell: commandShell, stdio: "inherit", timeout,
      });
    }
    context.executed = true;
    userLog.info("lifecycle.command.end", {
      durationMs: Date.now() - startedAt,
      attributes: { commandSource: context.commandSource, stage: stageName || "command" },
    });
  } catch (error) {
    const lifecycleError = describeLifecycleTimeout(error, {
      timeoutMinutes: effectiveCommandTimeoutMinutes, stageName, platformId, platformName,
    });
    userLog.error("lifecycle.command.error", {
      durationMs: Date.now() - startedAt, message: "lifecycle command failed",
      attributes: lifecycleErrorAttributes(lifecycleError, {
        commandSource: context.commandSource, stage: stageName || "command", sampleProcessTree,
      }),
    });
    throw lifecycleError;
  }
}

function executeConfiguredLifecycleStage(context) {
  const {
    stageName, sampleProcessTree, timeoutMinutes, processSampleIntervalMs,
    requestedParallelism, resolvedCwd, resolvedLogPath, resolvedProcessSummaryPath,
    resolvedProcessSamplesPath, logRunId, loadedConfig, userLog, platformId, platformName,
  } = context;
  context.commandSource = "buildchain.toml";
  const startedAt = Date.now();
  userLog.info("lifecycle.stage.start", {
    attributes: { commandSource: context.commandSource, stage: stageName, sampleProcessTree },
  });
  try {
    context.executed = runLifecycleStageWithSampler({
      cwd: resolvedCwd, loadedConfig, name: stageName,
      env: resolvedLogPath ? { BUILDCHAIN_LOG_PATH: resolvedLogPath, BUILDCHAIN_LOG_RUN_ID: logRunId } : {},
      sampleProcessTree, processSummaryPath: resolvedProcessSummaryPath,
      processSamplesPath: resolvedProcessSamplesPath, processSampleIntervalMs,
      requestedParallelism, timeoutMinutes,
    });
    userLog.info("lifecycle.stage.end", {
      durationMs: Date.now() - startedAt,
      attributes: { commandSource: context.commandSource, stage: stageName, executed: context.executed },
    });
  } catch (error) {
    const lifecycleError = describeLifecycleTimeout(error, {
      timeoutMinutes: loadedConfig?.config?.lifecycle?.[stageName]?.timeoutMinutes ?? timeoutMinutes,
      stageName, platformId, platformName,
    });
    userLog.error("lifecycle.stage.error", {
      durationMs: Date.now() - startedAt, message: "lifecycle stage failed",
      attributes: lifecycleErrorAttributes(lifecycleError, {
        commandSource: context.commandSource, stage: stageName, sampleProcessTree,
      }),
    });
    throw lifecycleError;
  }
}

function executeLifecycle(context) {
  const { stageName, artifactName, platformId, command, required, frameworkLog } = context;
  frameworkLog.info("lifecycle.start", { attributes: { stage: stageName, artifactName, platformId } });
  if (command.trim()) executeWorkflowLifecycleCommand(context);
  else if (stageName) executeConfiguredLifecycleStage(context);
  if (required && !context.executed) {
    frameworkLog.error("lifecycle.required-missing", {
      attributes: { stage: stageName || "command", commandSource: context.commandSource },
    });
    throw new Error(`required lifecycle stage did not run: ${stageName || "command"}`);
  }
}

function readLifecycleSupportArtifacts(context) {
  const shouldReadProcessSummary = Boolean(
    context.resolvedProcessSummaryPath &&
      (fs.existsSync(context.resolvedProcessSummaryPath) || context.processSummaryRequired),
  );
  return {
    processSummaryArtifact: shouldReadProcessSummary
      ? readProcessSummaryArtifact(context.resolvedProcessSummaryPath)
      : undefined,
    sourceCheckoutArtifact: fs.existsSync(context.resolvedSourceCheckoutPath)
      ? JSON.parse(fs.readFileSync(context.resolvedSourceCheckoutPath, "utf8"))
      : undefined,
    compilerCachePreparationArtifact: fs.existsSync(context.resolvedCompilerCachePreparationPath)
      ? JSON.parse(fs.readFileSync(context.resolvedCompilerCachePreparationPath, "utf8"))
      : undefined,
  };
}

function collectLifecycleArtifacts(context) {
  const compilerCacheActivity = verifyBuildLifecycleCompilerCacheActivity({
    stageName: context.stageName, executed: context.executed,
    cwd: context.resolvedCwd, frameworkLog: context.frameworkLog,
  });
  const substages = lifecycleSubstageEvidenceContext({
    substageEvidencePath: context.substageEvidencePath, cwd: context.resolvedCwd,
    workspace: context.resolvedWorkspace, diagnosticsDir: context.diagnosticsDir,
    lifecycleStage: context.stageName, platformId: context.platformId,
  });
  const support = readLifecycleSupportArtifacts(context);
  fs.mkdirSync(path.dirname(context.resolvedManifestPath), { recursive: true });
  const scanStartedAt = Date.now();
  const signingArtifactPaths = context.stageName === "build"
    ? signingArtifactPathsForPlatform({
        loadedConfig: context.loadedConfig, cwd: context.resolvedCwd, platformId: context.platformId,
      })
    : [];
  const files = collectArtifactFiles(context.resolvedWorkspace, [
    ...context.artifactPaths, ...signingArtifactPaths,
  ]);
  const manifestFiles = files.map((file) => {
    const stat = fs.statSync(file);
    return {
      path: manifestPathFor(context.resolvedWorkspace, file),
      size: stat.size,
      sha256: sha256File(file),
    };
  });
  const artifactScanDurationMs = Date.now() - scanStartedAt;
  context.frameworkLog.info("artifact.scan", {
    durationMs: artifactScanDurationMs, attributes: { fileCount: manifestFiles.length },
  });
  const platform = {
    id: context.platformId, name: context.platformName,
    os: process.env.RUNNER_OS || os.platform(), arch: process.env.RUNNER_ARCH || os.arch(),
  };
  const summary = createArtifactSummary({
    artifactName: context.artifactName, platform, files: manifestFiles,
  });
  const expectedArtifacts = validateExpectedArtifacts({
    expected: parseExpectedArtifactsJson(context.expectedArtifactsJson),
    files: manifestFiles, summary,
  });
  return {
    compilerCacheActivity, substages, ...support, manifestFiles,
    artifactScanDurationMs, platform, summary, expectedArtifacts,
  };
}

function createLifecycleManifest(context, artifacts) {
  const { frameworkLog, userLog } = context;
  const { manifestFiles, summary, artifactScanDurationMs, compilerCacheActivity, substages } = artifacts;
  frameworkLog.info("artifact.manifest.write", {
    attributes: {
      manifestPath: toPosix(path.relative(context.resolvedWorkspace, context.resolvedManifestPath)),
      summaryPath: toPosix(path.relative(context.resolvedWorkspace, context.resolvedSummaryPath)),
    },
  });
  frameworkLog.info("lifecycle.end", {
    attributes: { stage: context.stageName, executed: context.executed, fileCount: manifestFiles.length },
  });
  const events = context.resolvedLogPath
    ? readBuildchainLogEvents(context.resolvedLogPath)
    : [...frameworkLog.events, ...userLog.events];
  const observability = {
    log: {
      contract: "kungfu-buildchain-log-event", runId: context.logRunId,
      path: context.relativeLogPath,
      summary: context.resolvedLogPath
        ? summarizeBuildchainLogEvents(events.filter((event) => event.attributes?.buildchainLogRunId === context.logRunId))
        : summarizeBuildchainLogEvents(events),
    },
  };
  const lifecycleObservability = summarizeLifecycleObservability({
    events, logPath: context.relativeLogPath, artifactScanDurationMs,
    totalBytes: summary.totalBytes, fileCount: summary.fileCount,
  });
  observability.lifecycle = lifecycleObservability;
  Object.assign(observability, { compilerCacheActivity }, substages.observability);
  observability.diagnostics = {
    contract: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    path: context.relativeDiagnosticsPath,
    manifestPath: context.relativeDiagnosticsManifestPath,
    eventsPath: context.relativeDiagnosticsEventsPath,
  };
  if (context.relativeProcessSummaryPath) {
    observability.process = {
      contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
      path: context.relativeProcessSummaryPath,
    };
  }
  const summaryWithObservability = { ...summary, observability };
  return {
    lifecycleObservability, summaryWithObservability,
    manifest: {
      schemaVersion: 1, contract: "kungfu-buildchain-artifact",
      artifactName: context.artifactName, platform: artifacts.platform,
      git: {
        repository: process.env.GITHUB_REPOSITORY || "",
        sha: process.env.BUILDCHAIN_SOURCE_SHA || process.env.GITHUB_SHA || "",
        ref: process.env.BUILDCHAIN_SOURCE_REF || process.env.GITHUB_REF || "",
        runId: process.env.GITHUB_RUN_ID || "",
        runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
      },
      lifecycle: {
        stage: context.stageName, commandSource: context.commandSource,
        executed: context.executed, ...substages.lifecycle,
      },
      observability, summary: summaryWithObservability,
      expectedArtifacts: artifacts.expectedArtifacts, files: manifestFiles,
    },
  };
}

function diagnosticsLinks(context, artifacts) {
  const { processSummaryArtifact, sourceCheckoutArtifact, compilerCachePreparationArtifact, substages } = artifacts;
  return {
    artifactName: context.artifactName, platformId: context.platformId,
    ...(context.manifestArtifactName ? { manifestArtifactName: context.manifestArtifactName } : {}),
    ...(context.diagnosticsArtifactName ? { diagnosticsArtifactName: context.diagnosticsArtifactName } : {}),
    manifest: toPosix(path.relative(context.resolvedWorkspace, context.resolvedManifestPath)),
    summary: toPosix(path.relative(context.resolvedWorkspace, context.resolvedSummaryPath)),
    log: context.relativeLogPath,
    diagnosticsManifest: context.relativeDiagnosticsManifestPath,
    diagnosticsEvents: context.relativeDiagnosticsEventsPath,
    ...(context.relativeProcessSummaryPath ? { processSummary: context.relativeProcessSummaryPath } : {}),
    ...(processSummaryArtifact ? { diagnosticsProcessSummary: context.relativeDiagnosticsProcessSummaryPath } : {}),
    ...(processSummaryArtifact?.samplesPath ? { diagnosticsProcessSamples: context.relativeDiagnosticsProcessSamplesPath } : {}),
    ...substages.links,
    ...(sourceCheckoutArtifact ? { sourceCheckout: context.relativeDiagnosticsSourceCheckoutPath } : {}),
    ...(compilerCachePreparationArtifact
      ? { compilerCachePreparation: context.relativeDiagnosticsCompilerCachePreparationPath }
      : {}),
  };
}

function persistLifecycleDiagnostics(context, artifacts, product) {
  fs.writeFileSync(context.resolvedManifestPath, `${JSON.stringify(product.manifest, null, 2)}\n`);
  fs.mkdirSync(path.dirname(context.resolvedSummaryPath), { recursive: true });
  fs.writeFileSync(
    context.resolvedSummaryPath,
    `${JSON.stringify(product.summaryWithObservability, null, 2)}\n`,
  );
  writeDiagnosticsArtifact(
    context.resolvedDiagnosticsPath,
    createDiagnosticsArtifact({
      cwd: context.resolvedCwd,
      logPath: context.resolvedLogPath,
      artifactPaths: context.artifactPaths,
      lifecycleObservability: product.lifecycleObservability,
      processSummary: artifacts.processSummaryArtifact?.summary,
      sourceCheckout: artifacts.sourceCheckoutArtifact,
      compilerCachePreparation: artifacts.compilerCachePreparationArtifact,
      links: diagnosticsLinks(context, artifacts),
    }),
  );
  if (context.resolvedLogPath && fs.existsSync(context.resolvedLogPath)) {
    copyIfExists(context.resolvedLogPath, context.resolvedDiagnosticsEventsPath);
  } else {
    writeJsonlEvents(
      context.resolvedDiagnosticsEventsPath,
      [...context.frameworkLog.events, ...context.userLog.events],
    );
  }
  if (artifacts.processSummaryArtifact) {
    copyIfExists(context.resolvedProcessSummaryPath, context.resolvedDiagnosticsProcessSummaryPath);
    const resolvedSamplesPath = resolveLinkedFilePath({
      linkedPath: artifacts.processSummaryArtifact.samplesPath,
      workspace: context.resolvedWorkspace,
      cwd: context.resolvedCwd,
      fallbackDir: path.dirname(context.resolvedProcessSummaryPath),
    });
    copyIfExists(resolvedSamplesPath, context.resolvedDiagnosticsProcessSamplesPath);
  }
  copyIfExists(artifacts.substages.sourcePath, artifacts.substages.targetPath);
  if (artifacts.sourceCheckoutArtifact) {
    copyIfExists(context.resolvedSourceCheckoutPath, context.resolvedDiagnosticsSourceCheckoutPath);
  }
  if (artifacts.compilerCachePreparationArtifact) {
    copyIfExists(
      context.resolvedCompilerCachePreparationPath,
      context.resolvedDiagnosticsCompilerCachePreparationPath,
    );
  }
  writeDiagnosticsSidecarManifest(context.resolvedDiagnosticsManifestPath, {
    workspace: context.resolvedWorkspace,
    artifactName: context.artifactName,
    platformId: context.platformId,
    diagnosticsArtifactName: context.diagnosticsArtifactName,
    files: [
      { kind: "diagnostics", filePath: context.resolvedDiagnosticsPath, required: true },
      { kind: "events", filePath: context.resolvedDiagnosticsEventsPath, required: true },
      { kind: "process-summary", filePath: context.resolvedDiagnosticsProcessSummaryPath },
      { kind: "process-samples", filePath: context.resolvedDiagnosticsProcessSamplesPath },
      artifacts.substages.sidecar,
      { kind: "source-checkout", filePath: context.resolvedDiagnosticsSourceCheckoutPath },
      { kind: "compiler-cache-preparation", filePath: context.resolvedDiagnosticsCompilerCachePreparationPath },
    ],
  });
  console.log(`buildchain_manifest=${path.relative(context.resolvedWorkspace, context.resolvedManifestPath)}`);
  return product.manifest;
}

export function runLifecycle(options = {}) {
  const context = createLifecycleContext(normalizeLifecycleOptions(options));
  executeLifecycle(context);
  const artifacts = collectLifecycleArtifacts(context);
  const product = createLifecycleManifest(context, artifacts);
  return persistLifecycleDiagnostics(context, artifacts, product);
}

export function normalizeCommandStage(commandText) {
  return normalizeLifecycleStage({ command: commandText }, "workflow command");
}

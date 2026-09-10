import { toPosix } from "./files.js";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadBuildchainConfig } from "../../consumer/buildchain-config.js";
import { normalizeLifecycleStage } from "../../consumer/buildchain-config.js";
import { createBuildchainLogger } from "../../observability/logging.js";
export function normalizeLifecycleOptions(options) {
  const normalized = { ...options, env: options.env || process.env };
  const defaults = {
    cwd: process.cwd(),
    stageName: "",
    command: "",
    required: false,
    manifestPath: ".buildchain/artifacts/manifest.json",
    summaryPath: ".buildchain/artifacts/summary.json",
    diagnosticsPath: "",
    artifactName: "buildchain-artifact",
    manifestArtifactName: "",
    diagnosticsArtifactName: "",
    platformId: os.platform(),
    artifactPaths: [],
    expectedArtifactsJson: "",
    workspace: process.cwd(),
    logPath:
      normalized.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl",
    processSummaryPath: "",
    processSamplesPath: ".buildchain/diagnostics/process-samples.jsonl",
    sampleProcessTree: false,
    processSampleIntervalMs: 15000,
    requestedParallelism: 0,
    processSummaryRequired: true,
    substageEvidencePath: "",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (normalized[key] === undefined) normalized[key] = value;
  }
  if (normalized.platformName === undefined)
    normalized.platformName = normalized.platformId;
  return normalized;
}

export function resolveLifecyclePaths(options) {
  if (
    options.timeoutMinutes !== undefined &&
    (!Number.isFinite(options.timeoutMinutes) || options.timeoutMinutes <= 0)
  ) {
    throw new Error("lifecycle timeoutMinutes must be a positive number");
  }
  const resolvedCwd = path.resolve(options.cwd);
  const resolvedWorkspace = path.resolve(options.workspace);
  const resolvedManifestPath = path.resolve(
    resolvedWorkspace,
    options.manifestPath,
  );
  const resolvedSummaryPath = path.resolve(
    resolvedWorkspace,
    options.summaryPath,
  );
  const resolvedDiagnosticsPath = path.resolve(
    resolvedWorkspace,
    options.diagnosticsPath ||
      path.join(path.dirname(options.manifestPath), "diagnostics.json"),
  );
  const resolvedLogPath = options.logPath
    ? path.resolve(resolvedWorkspace, options.logPath)
    : "";
  const resolvedProcessSummaryPath =
    options.processSummaryPath || options.sampleProcessTree
      ? path.resolve(
          resolvedWorkspace,
          options.processSummaryPath ||
            ".buildchain/diagnostics/process-summary.json",
        )
      : "";
  const resolvedProcessSamplesPath = options.processSamplesPath
    ? path.resolve(resolvedWorkspace, options.processSamplesPath)
    : path.resolve(
        resolvedWorkspace,
        ".buildchain/diagnostics/process-samples.jsonl",
      );
  const diagnosticsDir = path.dirname(resolvedDiagnosticsPath);
  const resolvedCompilerCachePreparationPath = path.resolve(
    resolvedWorkspace,
    options.env.BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH ||
      ".buildchain/diagnostics/compiler-cache-preparation.json",
  );
  const compilerCachePreparationRelative = path.relative(
    resolvedWorkspace,
    resolvedCompilerCachePreparationPath,
  );
  if (
    compilerCachePreparationRelative.startsWith("..") ||
    path.isAbsolute(compilerCachePreparationRelative)
  ) {
    throw new Error(
      "BUILDCHAIN_COMPILER_CACHE_PREPARATION_PATH must remain inside the workflow workspace",
    );
  }
  return {
    resolvedCwd,
    resolvedWorkspace,
    resolvedManifestPath,
    resolvedSummaryPath,
    resolvedDiagnosticsPath,
    resolvedLogPath,
    resolvedProcessSummaryPath,
    resolvedProcessSamplesPath,
    relativeLogPath: resolvedLogPath
      ? toPosix(path.relative(resolvedWorkspace, resolvedLogPath))
      : "",
    relativeProcessSummaryPath: resolvedProcessSummaryPath
      ? toPosix(path.relative(resolvedWorkspace, resolvedProcessSummaryPath))
      : "",
    relativeDiagnosticsPath: toPosix(
      path.relative(resolvedWorkspace, resolvedDiagnosticsPath),
    ),
    diagnosticsDir,
    resolvedDiagnosticsEventsPath: path.join(diagnosticsDir, "events.jsonl"),
    resolvedDiagnosticsProcessSummaryPath: path.join(
      diagnosticsDir,
      "process-summary.json",
    ),
    resolvedDiagnosticsProcessSamplesPath: path.join(
      diagnosticsDir,
      "process-samples.jsonl",
    ),
    resolvedSourceCheckoutPath: path.resolve(
      resolvedWorkspace,
      ".buildchain/diagnostics/source-checkout.json",
    ),
    resolvedDiagnosticsSourceCheckoutPath: path.join(
      diagnosticsDir,
      "source-checkout.json",
    ),
    resolvedCompilerCachePreparationPath,
    resolvedDiagnosticsCompilerCachePreparationPath: path.join(
      diagnosticsDir,
      "compiler-cache-preparation.json",
    ),
    resolvedDiagnosticsManifestPath: path.join(
      diagnosticsDir,
      "diagnostics-manifest.json",
    ),
  };
}

export function addRelativeLifecyclePaths(paths) {
  const relative = (target) =>
    toPosix(path.relative(paths.resolvedWorkspace, target));
  return {
    ...paths,
    relativeDiagnosticsEventsPath: relative(
      paths.resolvedDiagnosticsEventsPath,
    ),
    relativeDiagnosticsProcessSummaryPath: relative(
      paths.resolvedDiagnosticsProcessSummaryPath,
    ),
    relativeDiagnosticsProcessSamplesPath: relative(
      paths.resolvedDiagnosticsProcessSamplesPath,
    ),
    relativeDiagnosticsSourceCheckoutPath: relative(
      paths.resolvedDiagnosticsSourceCheckoutPath,
    ),
    relativeDiagnosticsCompilerCachePreparationPath: relative(
      paths.resolvedDiagnosticsCompilerCachePreparationPath,
    ),
    relativeDiagnosticsManifestPath: relative(
      paths.resolvedDiagnosticsManifestPath,
    ),
  };
}

export function createLifecycleContext(options) {
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
    ...options,
    ...paths,
    logRunId,
    frameworkLog: createBuildchainLogger({
      ...loggerOptions,
      source: "buildchain",
    }),
    userLog: createBuildchainLogger({ ...loggerOptions, source: "user" }),
    loadedConfig: loadBuildchainConfig(paths.resolvedCwd),
    commandSource: "none",
    executed: false,
  };
}

export function normalizeCommandStage(commandText) {
  return normalizeLifecycleStage({ command: commandText }, "workflow command");
}

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  createDiagnosticsArtifact,
  summarizeLifecycleObservability,
  writeDiagnosticsArtifact,
} from "../packages/core/diagnostics.js";
import {
  createArtifactSummary,
  parseExpectedArtifactsJson,
  validateExpectedArtifacts,
} from "./build-contract-core.mjs";

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
  return {
    ...extra,
    errorName: error.name,
    status: error.status ?? "",
    signal: error.signal || "",
  };
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
  if (artifact?.contract === "kungfu-buildchain-process-sample-report" && artifact.summary) {
    return {
      artifact,
      summary: artifact.summary,
      samplesPath: artifact.samplesPath || "",
    };
  }
  if (artifact?.contract === "kungfu-buildchain-process-sample-summary") {
    return {
      artifact,
      summary: artifact,
      samplesPath: "",
    };
  }
  throw new Error(`process summary file has unsupported contract: ${artifact?.contract || "unknown"}`);
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

export function runLifecycle({
  cwd = process.cwd(),
  stageName = "",
  command = "",
  required = false,
  manifestPath = ".buildchain/artifacts/manifest.json",
  summaryPath = ".buildchain/artifacts/summary.json",
  diagnosticsPath = "",
  artifactName = "buildchain-artifact",
  platformId = os.platform(),
  platformName = platformId,
  artifactPaths = [],
  expectedArtifactsJson = "",
  workspace = process.cwd(),
  logPath = process.env.BUILDCHAIN_LOG_PATH || ".buildchain/logs/events.jsonl",
  processSummaryPath = "",
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedManifestPath = path.resolve(resolvedWorkspace, manifestPath);
  const resolvedSummaryPath = path.resolve(resolvedWorkspace, summaryPath);
  const resolvedDiagnosticsPath = path.resolve(
    resolvedWorkspace,
    diagnosticsPath || path.join(path.dirname(manifestPath), "diagnostics.json"),
  );
  const resolvedLogPath = logPath ? path.resolve(resolvedWorkspace, logPath) : "";
  const resolvedProcessSummaryPath = processSummaryPath ? path.resolve(resolvedWorkspace, processSummaryPath) : "";
  const relativeLogPath = resolvedLogPath ? toPosix(path.relative(resolvedWorkspace, resolvedLogPath)) : "";
  const relativeProcessSummaryPath = resolvedProcessSummaryPath
    ? toPosix(path.relative(resolvedWorkspace, resolvedProcessSummaryPath))
    : "";
  const relativeDiagnosticsPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsPath));
  const processSummaryArtifact = readProcessSummaryArtifact(resolvedProcessSummaryPath);
  const diagnosticsDir = path.dirname(resolvedDiagnosticsPath);
  const resolvedDiagnosticsEventsPath = path.join(diagnosticsDir, "events.jsonl");
  const resolvedDiagnosticsProcessSummaryPath = path.join(diagnosticsDir, "process-summary.json");
  const resolvedDiagnosticsProcessSamplesPath = path.join(diagnosticsDir, "process-samples.jsonl");
  const relativeDiagnosticsEventsPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsEventsPath));
  const relativeDiagnosticsProcessSummaryPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsProcessSummaryPath));
  const relativeDiagnosticsProcessSamplesPath = toPosix(path.relative(resolvedWorkspace, resolvedDiagnosticsProcessSamplesPath));
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
    const startedAt = Date.now();
    userLog.info("lifecycle.command.start", {
      attributes: {
        commandSource,
        stage: stageName || "command",
      },
    });
    try {
      execSync(command, {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...(resolvedLogPath
            ? {
                BUILDCHAIN_LOG_PATH: resolvedLogPath,
                BUILDCHAIN_LOG_RUN_ID: logRunId,
              }
            : {}),
        },
        shell: true,
        stdio: "inherit",
      });
      executed = true;
      userLog.info("lifecycle.command.end", {
        durationMs: Date.now() - startedAt,
        attributes: {
          commandSource,
          stage: stageName || "command",
        },
      });
    } catch (error) {
      userLog.error("lifecycle.command.error", {
        durationMs: Date.now() - startedAt,
        message: "lifecycle command failed",
        attributes: lifecycleErrorAttributes(error, {
          commandSource,
          stage: stageName || "command",
        }),
      });
      throw error;
    }
  } else if (stageName) {
    commandSource = "buildchain.toml";
    const startedAt = Date.now();
    userLog.info("lifecycle.stage.start", {
      attributes: {
        commandSource,
        stage: stageName,
      },
    });
    try {
      executed = runLifecycleStage({
        cwd: resolvedCwd,
        loadedConfig,
        name: stageName,
        env: resolvedLogPath
          ? {
              BUILDCHAIN_LOG_PATH: resolvedLogPath,
              BUILDCHAIN_LOG_RUN_ID: logRunId,
            }
          : {},
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
      userLog.error("lifecycle.stage.error", {
        durationMs: Date.now() - startedAt,
        message: "lifecycle stage failed",
        attributes: lifecycleErrorAttributes(error, {
          commandSource,
          stage: stageName,
        }),
      });
      throw error;
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
    contract: "kungfu-buildchain-diagnostics",
    path: relativeDiagnosticsPath,
    eventsPath: relativeDiagnosticsEventsPath,
  };
  if (relativeProcessSummaryPath) {
    observability.process = {
      contract: "kungfu-buildchain-process-sample-summary",
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
      links: {
        manifest: toPosix(path.relative(resolvedWorkspace, resolvedManifestPath)),
        summary: toPosix(path.relative(resolvedWorkspace, resolvedSummaryPath)),
        log: relativeLogPath,
        diagnosticsEvents: relativeDiagnosticsEventsPath,
        ...(relativeProcessSummaryPath ? { processSummary: relativeProcessSummaryPath } : {}),
        ...(processSummaryArtifact ? { diagnosticsProcessSummary: relativeDiagnosticsProcessSummaryPath } : {}),
        ...(processSummaryArtifact?.samplesPath ? { diagnosticsProcessSamples: relativeDiagnosticsProcessSamplesPath } : {}),
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
  console.log(`buildchain_manifest=${path.relative(resolvedWorkspace, resolvedManifestPath)}`);
  return manifest;
}

export function normalizeCommandStage(commandText) {
  return normalizeLifecycleStage({ command: commandText }, "workflow command");
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverConfiguredVersionStateFiles,
  getLifecycleStage,
  getPublishContract,
  getVersionStrategy,
  loadBuildchainConfig,
  loadConfiguredAnchorManifest,
  validateBuildchainConfig,
} from "./buildchain-config.js";
import { detectPackageManager, getWorkspaceInfo } from "./package-manager.js";
import {
  BUILDCHAIN_LOG_EVENT_CONTRACT,
  readBuildchainLogEvents,
  summarizeBuildchainLogEvents,
} from "./logging.js";

export const BUILDCHAIN_DIAGNOSTICS_CONTRACT = "kungfu-buildchain-diagnostics";
export const BUILDCHAIN_LIFECYCLE_OBSERVABILITY_CONTRACT =
  "kungfu-buildchain-lifecycle-observability";

const DEFAULT_SECRET_KEY_PATTERN =
  /(authorization|cookie|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key)/i;

function posixPath(value) {
  return String(value || "").split(path.sep).join("/");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function fileStats(cwd, entries = []) {
  return entries.map((entry) => {
    const filePath = path.resolve(cwd, entry);
    if (!fs.existsSync(filePath)) {
      return { path: posixPath(entry), exists: false };
    }
    const stat = fs.statSync(filePath);
    return {
      path: posixPath(entry),
      exists: true,
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      bytes: stat.size,
    };
  });
}

function commandVersion(command, args = ["--version"], cwd = process.cwd()) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim().split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
}

function defaultDiagnosticCommandRunner(command, args = [], { cwd = process.cwd(), timeoutMs = 5000 } = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: timeoutMs,
  });
}

function gitField(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

function safeAnchorManifest(cwd, loadedConfig) {
  try {
    return loadConfiguredAnchorManifest(cwd, loadedConfig);
  } catch (error) {
    return { error: error.message };
  }
}

function check(ok, id, message, details = {}) {
  return { id, status: ok ? "pass" : "fail", message, details };
}

function lifecycleTimingFromEvents(events = []) {
  const stages = {};
  const spans = [];
  let warningCount = 0;
  let errorCount = 0;
  for (const event of events) {
    if (event.level === "warn") {
      warningCount += 1;
    }
    if (event.level === "error") {
      errorCount += 1;
    }
    const stage = event.attributes?.stage || event.phase || "unknown";
    const durationMs = Number(event.durationMs || 0);
    if (durationMs > 0) {
      stages[stage] = stages[stage] || { durationMs: 0, eventCount: 0 };
      stages[stage].durationMs += durationMs;
      spans.push({
        event: event.event,
        source: event.source || "",
        component: event.component || "",
        stage,
        phase: event.phase || "",
        durationMs,
      });
    }
    if (stage) {
      stages[stage] = stages[stage] || { durationMs: 0, eventCount: 0 };
      stages[stage].eventCount += 1;
    }
  }
  return {
    stages: Object.fromEntries(Object.entries(stages).sort(([left], [right]) => left.localeCompare(right))),
    topSlowSpans: spans.sort((left, right) => right.durationMs - left.durationMs).slice(0, 10),
    warningCount,
    errorCount,
  };
}

export function summarizeLifecycleObservability({
  events = [],
  logPath = "",
  artifactScanDurationMs = 0,
  artifactUploadDurationMs = 0,
  totalBytes = 0,
  fileCount = 0,
} = {}) {
  const resolvedEvents = events.length ? events : readBuildchainLogEvents(logPath);
  const timing = lifecycleTimingFromEvents(resolvedEvents);
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_LIFECYCLE_OBSERVABILITY_CONTRACT,
    log: {
      contract: BUILDCHAIN_LOG_EVENT_CONTRACT,
      path: logPath ? posixPath(logPath) : "",
      summary: summarizeBuildchainLogEvents(resolvedEvents),
    },
    stages: timing.stages,
    artifactScan: { durationMs: Math.round(Number(artifactScanDurationMs || 0)) },
    artifactUpload: { durationMs: Math.round(Number(artifactUploadDurationMs || 0)) },
    totalBytes: Number(totalBytes || 0),
    fileCount: Number(fileCount || 0),
    topSlowSpans: timing.topSlowSpans,
    warningCount: timing.warningCount,
    errorCount: timing.errorCount,
  };
}

export function collectBuildchainDiagnostics({ cwd = process.cwd(), artifactPaths = [] } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  let configSummary = {};
  try {
    configSummary = validateBuildchainConfig(resolvedCwd);
  } catch (error) {
    configSummary = { ok: false, error: error.message };
  }
  return {
    config: loadedConfig
      ? {
          path: loadedConfig.path,
          project: loadedConfig.config.project || {},
          versionStrategy: getVersionStrategy(loadedConfig),
          publishContract: getPublishContract(loadedConfig),
          lifecycleStages: Object.keys(loadedConfig.config.lifecycle || {}),
          anchorManifest: safeAnchorManifest(resolvedCwd, loadedConfig),
          validation: configSummary,
        }
      : { path: "", validation: configSummary },
    lifecycle: Object.fromEntries(
      ["install", "build", "verify", "publish"]
        .map((stage) => [stage, getLifecycleStage(loadedConfig, stage)])
        .filter(([, value]) => Boolean(value)),
    ),
    artifactPaths: fileStats(resolvedCwd, artifactPaths),
  };
}

export function validateAnchoredPackageRelease({
  cwd = process.cwd(),
  requireManifest = true,
  requirePackageSetOrder = "platforms-first-main-last",
  requireTrustedPublishing = true,
  requireLifecycleStages = ["install", "build", "verify", "publish"],
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const checks = [];
  let loadedConfig;
  try {
    loadedConfig = loadBuildchainConfig(resolvedCwd);
    checks.push(check(Boolean(loadedConfig), "config.load", "buildchain.toml is readable"));
  } catch (error) {
    checks.push(check(false, "config.load", error.message));
  }
  const versionStrategy = getVersionStrategy(loadedConfig);
  checks.push(check(
    versionStrategy.strategy === "anchored",
    "version.strategy",
    "version strategy is anchored",
    versionStrategy,
  ));
  checks.push(check(
    versionStrategy.next === "manual",
    "version.next",
    "next version strategy is manual",
    versionStrategy,
  ));
  const anchorManifest = safeAnchorManifest(resolvedCwd, loadedConfig);
  checks.push(check(
    !requireManifest || (anchorManifest && !anchorManifest.error),
    "version.manifest",
    anchorManifest?.error || "anchor manifest is readable",
    { path: anchorManifest?.path || versionStrategy.manifest || "" },
  ));
  try {
    const files = discoverConfiguredVersionStateFiles(resolvedCwd, loadedConfig);
    checks.push(check(files.length > 0, "version.files", "configured version files are readable", {
      files: files.map((file) => file.path),
    }));
  } catch (error) {
    checks.push(check(false, "version.files", error.message));
  }
  const publish = getPublishContract(loadedConfig) || {};
  checks.push(check(
    publish.mode === "publish-final-version",
    "publish.mode",
    "publish mode is compatible with anchored final-version release",
    { mode: publish.mode || "" },
  ));
  if (requireTrustedPublishing) {
    checks.push(check(
      publish.auth === "trusted-publishing",
      "publish.auth",
      "trusted publishing is enabled",
      { auth: publish.auth || "" },
    ));
  }
  if (requirePackageSetOrder) {
    checks.push(check(
      publish.packageSetOrder === requirePackageSetOrder,
      "publish.package_set_order",
      `package set order is ${requirePackageSetOrder}`,
      { packageSetOrder: publish.packageSetOrder || "" },
    ));
  }
  for (const stage of requireLifecycleStages || []) {
    checks.push(check(
      Boolean(getLifecycleStage(loadedConfig, stage)),
      `lifecycle.${stage}`,
      `lifecycle stage is configured: ${stage}`,
    ));
  }
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-anchored-package-release-validation",
    cwd: resolvedCwd,
    ok: checks.every((entry) => entry.status === "pass"),
    checks,
    summary: {
      versionStrategy,
      anchorManifest: anchorManifest?.path || "",
      publish,
      requiredLifecycleStages: requireLifecycleStages,
    },
  };
}

export function collectRunnerDiagnostics() {
  return {
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      type: os.type(),
    },
    cpu: {
      logicalCount: os.cpus().length,
      model: os.cpus()[0]?.model || "",
      loadAverage: os.loadavg(),
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
    },
    uptimeSeconds: Math.round(os.uptime()),
    github: {
      actions: process.env.GITHUB_ACTIONS === "true",
      runnerOs: process.env.RUNNER_OS || "",
      runnerArch: process.env.RUNNER_ARCH || "",
      runnerName: process.env.RUNNER_NAME || "",
    },
  };
}

export function collectToolDiagnostics({ cwd = process.cwd(), tools = ["node", "pnpm", "npm", "git", "cmake", "ninja", "ccache", "sccache"] } = {}) {
  return Object.fromEntries(tools.map((tool) => [tool, { version: commandVersion(tool, ["--version"], cwd) }]));
}

function parseJsonDiagnostics(value = "") {
  try {
    return JSON.parse(String(value || "").trim());
  } catch {
    return undefined;
  }
}

function collectCompilerCacheTool({ command, args, cwd, runCommand }) {
  try {
    const output = runCommand(command, args, { cwd, timeoutMs: 5000 });
    const text = String(output || "").trim();
    const stats = parseJsonDiagnostics(text);
    return {
      available: true,
      command,
      format: stats ? "json" : "text",
      stats: stats || {},
      rawBytes: Buffer.byteLength(text, "utf8"),
      parseError: stats ? "" : "stats output was not JSON",
    };
  } catch (error) {
    return {
      available: false,
      command,
      error: error?.code || error?.message || "stats command failed",
    };
  }
}

export function collectCompilerCacheDiagnostics({
  cwd = process.cwd(),
  runCommand = defaultDiagnosticCommandRunner,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  return {
    ccache: collectCompilerCacheTool({
      command: "ccache",
      args: ["--show-stats", "--json"],
      cwd: resolvedCwd,
      runCommand,
    }),
    sccache: collectCompilerCacheTool({
      command: "sccache",
      args: ["--show-stats", "--stats-format", "json"],
      cwd: resolvedCwd,
      runCommand,
    }),
  };
}

export function collectCacheDiagnostics({ cwd = process.cwd(), cacheDirs = [], runCommand = defaultDiagnosticCommandRunner } = {}) {
  const resolvedCwd = path.resolve(cwd);
  return {
    packageManager: (() => {
      try {
        return detectPackageManager(resolvedCwd);
      } catch (error) {
        return { name: "unknown", error: error.message };
      }
    })(),
    workspace: (() => {
      try {
        return getWorkspaceInfo(resolvedCwd);
      } catch (error) {
        return { error: error.message };
      }
    })(),
    dirs: fileStats(resolvedCwd, cacheDirs),
    compilerCaches: collectCompilerCacheDiagnostics({ cwd: resolvedCwd, runCommand }),
  };
}

export function collectGitDiagnostics({ cwd = process.cwd() } = {}) {
  return {
    repository: gitField(cwd, ["config", "--get", "remote.origin.url"]),
    head: gitField(cwd, ["rev-parse", "HEAD"]),
    ref: gitField(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: gitField(cwd, ["status", "--short"]) !== "",
  };
}

export function redactDiagnosticsValue(key, value, pattern = DEFAULT_SECRET_KEY_PATTERN) {
  if (pattern.test(String(key || ""))) {
    return "[REDACTED]";
  }
  return value;
}

export function collectProcessTreeSnapshot({ rootPid = process.pid, cwd = process.cwd() } = {}) {
  const pid = String(rootPid || process.pid);
  if (process.platform === "win32") {
    return { rootPid: pid, platform: process.platform, processes: [] };
  }
  let lines = [];
  try {
    lines = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,comm="], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    return { rootPid: pid, platform: process.platform, processes: [] };
  }
  const rows = lines.map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(.+)$/);
    return match
      ? { pid: match[1], ppid: match[2], cpu: Number(match[3]), command: path.basename(match[4]) }
      : undefined;
  }).filter(Boolean);
  const byParent = new Map();
  for (const row of rows) {
    byParent.set(row.ppid, [...(byParent.get(row.ppid) || []), row]);
  }
  const seen = new Set();
  const stack = [pid];
  const processes = [];
  while (stack.length) {
    const current = stack.pop();
    for (const child of byParent.get(current) || []) {
      if (seen.has(child.pid)) {
        continue;
      }
      seen.add(child.pid);
      processes.push(child);
      stack.push(child.pid);
    }
  }
  return { rootPid: pid, platform: process.platform, processes };
}

export function classifyProcessCommand(command = "") {
  const name = path.basename(String(command || "")).toLowerCase();
  if (/^(ccache|sccache)$/.test(name)) {
    return "cache";
  }
  if (/^(clang|clang\+\+|gcc|g\+\+|cc|c\+\+|cl)(\.exe)?$/.test(name)) {
    return "compiler";
  }
  if (/^(ld|lld|lld-link|link)(\.exe)?$/.test(name)) {
    return "linker";
  }
  if (/^(ar|llvm-ar|libtool|ranlib)(\.exe)?$/.test(name)) {
    return "archive";
  }
  if (/^(make|ninja|cmake|msbuild|vcbuild|gyp-mac-tool)(\.exe)?$/.test(name)) {
    return "build-tool";
  }
  if (/^(node|python|python3|bash|sh|pwsh|powershell)(\.exe)?$/.test(name)) {
    return "script";
  }
  return "other";
}

function firstPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function detectParallelismFromTokens(tokens = []) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || "");
    const inlineMatch = token.match(/^(?:-j|--jobs=|--parallel=|\/m:|-m:)(\d+)$/i);
    if (inlineMatch) {
      return { value: Number(inlineMatch[1]), source: "command", token };
    }
    if (/^(?:-j|--jobs|--parallel)$/i.test(token)) {
      const value = firstPositiveInteger(tokens[index + 1]);
      if (value) {
        return { value, source: "command", token: `${token} ${tokens[index + 1]}` };
      }
    }
  }
  return { value: 0, source: "", token: "" };
}

function shellishTokens(command = "") {
  return String(command || "").match(/"[^"]+"|'[^']+'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, "")) || [];
}

export function detectRequestedParallelism({
  command = "",
  args = [],
  env = process.env,
} = {}) {
  const commandTokens = [
    ...shellishTokens(command),
    ...(Array.isArray(args) ? args.map((entry) => String(entry)) : shellishTokens(args)),
  ];
  const commandParallelism = detectParallelismFromTokens(commandTokens);
  if (commandParallelism.value) {
    return commandParallelism;
  }

  const explicitEnvKeys = [
    "BUILDCHAIN_REQUESTED_PARALLELISM",
    "CMAKE_BUILD_PARALLEL_LEVEL",
    "NINJA_STATUS_JOBS",
    "npm_config_jobs",
  ];
  for (const key of explicitEnvKeys) {
    const value = firstPositiveInteger(env?.[key]);
    if (value) {
      return { value, source: `env:${key}`, token: key };
    }
  }

  const makeflags = detectParallelismFromTokens(shellishTokens(env?.MAKEFLAGS || ""));
  if (makeflags.value) {
    return { ...makeflags, source: "env:MAKEFLAGS" };
  }

  return { value: 0, source: "", token: "" };
}

export function summarizeProcessSamples({
  samples = [],
  requestedParallelism = 0,
  command = "",
  args = [],
  env = process.env,
  activeCpuThreshold = 0.1,
} = {}) {
  const normalizedSamples = Array.isArray(samples) ? samples : [];
  const activeCounts = [];
  const cpuTotals = [];
  const categoryMax = {};
  const commandStats = new Map();
  const threshold = Number(activeCpuThreshold || 0);

  for (const sample of normalizedSamples) {
    const processes = Array.isArray(sample?.processes) ? sample.processes : [];
    const active = processes.filter((entry) => Number(entry.cpu || 0) >= threshold);
    activeCounts.push(active.length);
    cpuTotals.push(processes.reduce((sum, entry) => sum + Number(entry.cpu || 0), 0));

    const categoryCounts = {};
    for (const entry of active) {
      const command = path.basename(String(entry.command || "unknown"));
      const category = classifyProcessCommand(command);
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      const stats = commandStats.get(command) || {
        command,
        category,
        samples: 0,
        maxConcurrent: 0,
        maxCpu: 0,
      };
      stats.samples += 1;
      stats.maxCpu = Math.max(stats.maxCpu, Number(entry.cpu || 0));
      commandStats.set(command, stats);
    }

    const commandCounts = {};
    for (const entry of active) {
      const command = path.basename(String(entry.command || "unknown"));
      commandCounts[command] = (commandCounts[command] || 0) + 1;
    }
    for (const [command, count] of Object.entries(commandCounts)) {
      const stats = commandStats.get(command);
      if (stats) {
        stats.maxConcurrent = Math.max(stats.maxConcurrent, count);
      }
    }
    for (const [category, count] of Object.entries(categoryCounts)) {
      categoryMax[category] = Math.max(categoryMax[category] || 0, count);
    }
  }

  const observedMax = activeCounts.length ? Math.max(...activeCounts) : 0;
  const observedAverage = activeCounts.length
    ? activeCounts.reduce((sum, value) => sum + value, 0) / activeCounts.length
    : 0;
  const totalCpuMax = cpuTotals.length ? Math.max(...cpuTotals) : 0;
  const totalCpuAverage = cpuTotals.length
    ? cpuTotals.reduce((sum, value) => sum + value, 0) / cpuTotals.length
    : 0;
  const explicitRequested = firstPositiveInteger(requestedParallelism);
  const detectedParallelism = detectRequestedParallelism({ command, args, env });
  const requested = explicitRequested || detectedParallelism.value;

  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-process-sample-summary",
    sampleCount: normalizedSamples.length,
    activeCpuThreshold: threshold,
    requestedParallelism: requested,
    requestedParallelismSource: explicitRequested ? "explicit" : detectedParallelism.source,
    observedConcurrency: {
      max: observedMax,
      average: Number(observedAverage.toFixed(2)),
      ratioToRequestedMax: requested > 0 ? Number((observedMax / requested).toFixed(3)) : 0,
    },
    cpu: {
      totalMax: Number(totalCpuMax.toFixed(2)),
      totalAverage: Number(totalCpuAverage.toFixed(2)),
    },
    categories: Object.fromEntries(Object.entries(categoryMax).sort(([left], [right]) => left.localeCompare(right))),
    topCommands: [...commandStats.values()]
      .sort((left, right) => right.maxConcurrent - left.maxConcurrent || right.maxCpu - left.maxCpu)
      .slice(0, 10),
  };
}

export function startProcessSampler({
  rootPid = process.pid,
  intervalMs = 15000,
  label = "",
  command = "",
  args = [],
  env = process.env,
  requestedParallelism = 0,
  onSample = () => undefined,
  cwd = process.cwd(),
} = {}) {
  const samples = [];
  const startedAt = Date.now();
  const explicitRequested = firstPositiveInteger(requestedParallelism);
  const detectedParallelism = detectRequestedParallelism({ command, args, env });
  const requested = explicitRequested || detectedParallelism.value;
  const sample = () => {
    const snapshot = {
      timestamp: new Date().toISOString(),
      label,
      elapsedMs: Date.now() - startedAt,
      requestedParallelism: requested,
      requestedParallelismSource: explicitRequested ? "explicit" : detectedParallelism.source,
      ...collectProcessTreeSnapshot({ rootPid, cwd }),
    };
    samples.push(snapshot);
    onSample(snapshot);
    return snapshot;
  };
  sample();
  const timer = setInterval(sample, Math.max(1000, Number(intervalMs || 15000)));
  return {
    samples,
    stop() {
      clearInterval(timer);
      return samples;
    },
  };
}

export function createDiagnosticsArtifact({
  cwd = process.cwd(),
  logPath = "",
  artifactPaths = [],
  cacheDirs = [],
  lifecycleObservability = undefined,
  processSamples = [],
  processSummary = undefined,
  requestedParallelism = 0,
  links = {},
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const events = logPath ? readBuildchainLogEvents(logPath) : [];
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    generatedAt: new Date().toISOString(),
    cwd: resolvedCwd,
    buildchain: collectBuildchainDiagnostics({ cwd: resolvedCwd, artifactPaths }),
    runner: collectRunnerDiagnostics(),
    tools: collectToolDiagnostics({ cwd: resolvedCwd }),
    cache: collectCacheDiagnostics({ cwd: resolvedCwd, cacheDirs }),
    git: collectGitDiagnostics({ cwd: resolvedCwd }),
    lifecycleObservability: lifecycleObservability || summarizeLifecycleObservability({ events, logPath }),
    process: processSummary || summarizeProcessSamples({ samples: processSamples, requestedParallelism }),
    links,
  };
}

export function writeDiagnosticsArtifact(filePath, diagnostics) {
  if (!filePath) {
    return "";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  return filePath;
}

export function readDiagnosticsArtifact(filePath) {
  return safeReadJson(filePath);
}

function sumLifecycleDurationMs(stages = {}) {
  return Object.values(stages).reduce((sum, entry) => sum + Number(entry?.durationMs || 0), 0);
}

export function summarizeDiagnosticsArtifacts(inputs = []) {
  const diagnostics = inputs
    .map((entry) => (typeof entry === "string" ? readDiagnosticsArtifact(entry) : entry))
    .filter(Boolean);
  const platforms = diagnostics.map((entry) => {
    const lifecycle = entry.lifecycleObservability?.stages || {};
    return {
      runner: entry.runner?.github?.runnerOs || entry.runner?.os?.platform || "unknown",
      arch: entry.runner?.github?.runnerArch || entry.runner?.os?.arch || "unknown",
      gitHead: entry.git?.head || "",
      lifecycle,
      lifecycleTotalDurationMs: sumLifecycleDurationMs(lifecycle),
      topSlowSpans: (entry.lifecycleObservability?.topSlowSpans || []).slice(0, 5),
      process: entry.process || {},
      warningCount: entry.lifecycleObservability?.warningCount || 0,
      errorCount: entry.lifecycleObservability?.errorCount || 0,
    };
  });
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-diagnostics-summary",
    generatedAt: new Date().toISOString(),
    count: diagnostics.length,
    totalWarningCount: platforms.reduce((sum, entry) => sum + entry.warningCount, 0),
    totalErrorCount: platforms.reduce((sum, entry) => sum + entry.errorCount, 0),
    slowestPlatforms: platforms
      .map(({ runner, arch, gitHead, lifecycleTotalDurationMs }) => ({
        runner,
        arch,
        gitHead,
        lifecycleTotalDurationMs,
      }))
      .sort((left, right) => right.lifecycleTotalDurationMs - left.lifecycleTotalDurationMs)
      .slice(0, 10),
    platforms,
  };
}

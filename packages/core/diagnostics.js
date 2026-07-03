import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverConfiguredVersionStateFiles,
  getNativeDiagnosticsProfile,
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
export const BUILDCHAIN_ANCHORED_PACKAGE_RELEASE_VALIDATION_CONTRACT =
  "kungfu-buildchain-anchored-package-release-validation";
export const BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT =
  "kungfu-buildchain-diagnostics-manifest";
export const BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT =
  "kungfu-buildchain-diagnostics-summary";
export const BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT =
  "kungfu-buildchain-process-sample-report";
export const BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT =
  "kungfu-buildchain-process-sample-summary";

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

function readJsonResult(filePath) {
  try {
    return { value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    return { error };
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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

function normalizePublishSourceRef(value = "") {
  return String(value || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/tags\//, "");
}

function parsePublishGateSourceRef(value = "") {
  const sourceRef = normalizePublishSourceRef(value);
  if (sourceRef === "publish-gate/major") {
    return { sourceRef, channel: "major", line: "", consumerVersion: "" };
  }
  if (sourceRef === "publish-gate/anchor") {
    return { sourceRef, channel: "anchor", line: "", consumerVersion: "" };
  }
  const match = sourceRef.match(/^publish-gate\/(alpha|release)\/(.+)\/([^/]+)$/);
  if (!match) {
    return { sourceRef, channel: "", line: "", consumerVersion: "" };
  }
  return {
    sourceRef,
    channel: match[1],
    line: match[2],
    consumerVersion: match[3],
  };
}

function versionFileValue(file) {
  if (file.type === "json" || file.type === "toml") {
    return String(file.key || "")
      .split(".")
      .reduce((current, segment) => current?.[segment], file.content);
  }
  return file.source.match(file.pattern)?.groups?.version;
}

function defaultPublishSourceFromEnv(env = process.env) {
  return {
    sourceRef: env.BUILDCHAIN_PUBLISH_SOURCE_REF || "",
    sourceSha: env.BUILDCHAIN_PUBLISH_SOURCE_SHA || "",
    sourceLocked: env.BUILDCHAIN_PUBLISH_SOURCE_LOCKED || "",
    channel: env.BUILDCHAIN_PUBLISH_SOURCE_CHANNEL || "",
    consumerVersion: env.BUILDCHAIN_PUBLISH_SOURCE_CONSUMER_VERSION || "",
  };
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
          diagnostics: {
            native: getNativeDiagnosticsProfile(loadedConfig),
          },
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

function selectedCompilerCacheDiagnostics({ cwd, compilerCache, runCommand }) {
  if (compilerCache === "none") {
    return {};
  }
  const diagnostics = collectCompilerCacheDiagnostics({ cwd, runCommand });
  if (compilerCache === "ccache") {
    return { ccache: diagnostics.ccache };
  }
  if (compilerCache === "sccache") {
    return { sccache: diagnostics.sccache };
  }
  return diagnostics;
}

export function collectNativeDiagnostics({
  cwd = process.cwd(),
  profile = undefined,
  runCommand = defaultDiagnosticCommandRunner,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const nativeProfile = profile || getNativeDiagnosticsProfile(loadBuildchainConfig(resolvedCwd));
  if (!nativeProfile.enabled) {
    return {
      enabled: false,
      profile: nativeProfile,
    };
  }
  const expectedTools = nativeProfile.expectedTools.length
    ? nativeProfile.expectedTools
    : ["node", "pnpm", "npm", "git", "cmake", "ninja", "ccache", "sccache"];
  return {
    enabled: true,
    profile: nativeProfile,
    tools: collectToolDiagnostics({ cwd: resolvedCwd, tools: expectedTools }),
    compilerCaches: selectedCompilerCacheDiagnostics({
      cwd: resolvedCwd,
      compilerCache: nativeProfile.compilerCache,
      runCommand,
    }),
    artifactDirs: fileStats(resolvedCwd, nativeProfile.artifactDirs),
    cacheDirs: fileStats(resolvedCwd, nativeProfile.cacheDirs),
  };
}

export function validateAnchoredPackageRelease({
  cwd = process.cwd(),
  requireManifest = true,
  requirePackageSetOrder = "platforms-first-main-last",
  requireTrustedPublishing = true,
  requireLifecycleStages = ["install", "build", "verify", "publish"],
  requirePublishGateSourceLock = false,
  publishSource = undefined,
  env = process.env,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const checks = [];
  let versionFiles = [];
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
    versionFiles = discoverConfiguredVersionStateFiles(resolvedCwd, loadedConfig);
    checks.push(check(versionFiles.length > 0, "version.files", "configured version files are readable", {
      files: versionFiles.map((file) => file.path),
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
  const source = publishSource || defaultPublishSourceFromEnv(env);
  const parsedSource = parsePublishGateSourceRef(source.sourceRef);
  if (requirePublishGateSourceLock) {
    const normalizedLocked = String(source.sourceLocked || "").toLowerCase();
    const lockEnabled = normalizedLocked === "true" || normalizedLocked === "1" || source.sourceLocked === true;
    checks.push(check(
      lockEnabled,
      "publish.source_locked",
      "publish source lock is required before package publication",
      { sourceLocked: source.sourceLocked || "" },
    ));
    checks.push(check(
      Boolean(parsedSource.channel) && parsedSource.channel !== "anchor",
      "publish.source_ref",
      "publish source ref uses publish-gate/{alpha,release,major}",
      { sourceRef: parsedSource.sourceRef || source.sourceRef || "", channel: parsedSource.channel || "" },
    ));
    checks.push(check(
      /^[0-9a-f]{40}$/i.test(String(source.sourceSha || "")),
      "publish.source_sha",
      "publish source SHA is a 40-character Git SHA",
      { sourceSha: source.sourceSha || "" },
    ));
    const consumerVersion = parsedSource.consumerVersion || source.consumerVersion || "";
    if (consumerVersion) {
      const mismatches = versionFiles
        .map((file) => ({ path: file.path, version: versionFileValue(file) || "" }))
        .filter((file) => file.version !== consumerVersion);
      checks.push(check(
        mismatches.length === 0,
        "publish.source_version",
        `publish source consumer version matches configured version files: ${consumerVersion}`,
        { consumerVersion, mismatches },
      ));
      checks.push(check(
        !anchorManifest?.fields?.npmVersion || anchorManifest.fields.npmVersion === consumerVersion,
        "publish.anchor_version",
        `anchor manifest npmVersion matches publish source version: ${consumerVersion}`,
        { consumerVersion, npmVersion: anchorManifest?.fields?.npmVersion || "" },
      ));
    }
  }
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_ANCHORED_PACKAGE_RELEASE_VALIDATION_CONTRACT,
    cwd: resolvedCwd,
    ok: checks.every((entry) => entry.status === "pass"),
    checks,
    summary: {
      versionStrategy,
      anchorManifest: anchorManifest?.path || "",
      publish,
      publishSource: {
        sourceRef: parsedSource.sourceRef || source.sourceRef || "",
        sourceSha: source.sourceSha || "",
        sourceLocked: source.sourceLocked || "",
        channel: parsedSource.channel || source.channel || "",
        line: parsedSource.line || "",
        consumerVersion: parsedSource.consumerVersion || source.consumerVersion || "",
      },
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
    lines = execFileSync("ps", ["-axo", "pid=,ppid=,pcpu=,comm=,args="], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    return { rootPid: pid, platform: process.platform, processes: [] };
  }
  const rows = lines.map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+(\S+)(?:\s+(.*))?$/);
    const args = match?.[5] || "";
    return match
      ? {
          pid: match[1],
          ppid: match[2],
          cpu: Number(match[3]),
          command: path.basename(match[4]),
          commandLine: redactCommandLine(args),
        }
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

function commandName(value = "") {
  return path.basename(String(value || "").replace(/[()]/g, "").replace(/\.exe$/i, "")).toLowerCase();
}

function detectParallelismFromTokens(tokens = []) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = String(tokens[index] || "");
    const inlineMatch = token.match(/^(?:-j|--jobs=|--parallel=|-jobs|\/m:|\/maxcpucount:|-m:)(\d+)$/i);
    if (inlineMatch) {
      return { value: Number(inlineMatch[1]), source: "command", token };
    }
    if (/^(?:-j|--jobs|--parallel|-jobs)$/i.test(token)) {
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

function redactCommandLine(commandLine = "", pattern = DEFAULT_SECRET_KEY_PATTERN) {
  const tokens = shellishTokens(commandLine);
  let redactNext = false;
  return tokens.map((token) => {
    const withUrlUserInfo = token.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[REDACTED]@");
    if (redactNext) {
      redactNext = false;
      return "[REDACTED]";
    }
    const assignment = withUrlUserInfo.match(/^([^=\s]+)=(.*)$/);
    if (assignment && pattern.test(assignment[1])) {
      return `${assignment[1]}=[REDACTED]`;
    }
    const inlineOption = withUrlUserInfo.match(/^(--?[^=\s]+)=(.*)$/);
    if (inlineOption && pattern.test(inlineOption[1])) {
      return `${inlineOption[1]}=[REDACTED]`;
    }
    if (/^--?/.test(withUrlUserInfo) && pattern.test(withUrlUserInfo)) {
      redactNext = true;
    }
    return withUrlUserInfo;
  }).join(" ");
}

function commandLineFromProcess(entry = {}) {
  return [
    entry.commandLine,
    Array.isArray(entry.args) ? entry.args.join(" ") : entry.args,
    Array.isArray(entry.argv) ? entry.argv.join(" ") : "",
    entry.command,
  ].find((value) => String(value || "").trim()) || "";
}

function parallelismCandidate({ value, source, token, entry, sample }) {
  return {
    value,
    source,
    token,
    pid: entry?.pid ? String(entry.pid) : "",
    command: commandName(entry?.command || shellishTokens(commandLineFromProcess(entry))[0] || ""),
    commandLine: commandLineFromProcess(entry),
    timestamp: sample?.timestamp || "",
  };
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

export function detectRequestedParallelismFromProcessSamples(samples = []) {
  const candidates = [];
  const buildToolNames = new Set(["make", "ninja", "cmake", "msbuild", "xcodebuild"]);
  for (const sample of Array.isArray(samples) ? samples : []) {
    for (const entry of Array.isArray(sample?.processes) ? sample.processes : []) {
      const command = commandName(entry.command || shellishTokens(commandLineFromProcess(entry))[0] || "");
      if (!buildToolNames.has(command)) {
        continue;
      }
      const tokens = shellishTokens(commandLineFromProcess(entry));
      const detected = detectParallelismFromTokens(tokens);
      if (detected.value) {
        candidates.push(parallelismCandidate({
          ...detected,
          source: "process-tree",
          entry,
          sample,
        }));
      }
    }
  }
  candidates.sort((left, right) => right.value - left.value || left.command.localeCompare(right.command));
  return {
    value: candidates[0]?.value || 0,
    source: candidates[0] ? "process-tree" : "",
    token: candidates[0]?.token || "",
    evidence: candidates[0] || undefined,
    candidates,
  };
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
  const commandParallelism = detectRequestedParallelism({ command, args, env });
  const sampledParallelism = detectRequestedParallelismFromProcessSamples(normalizedSamples);
  const requested = explicitRequested || sampledParallelism.value || commandParallelism.value;
  const requestedSource = explicitRequested
    ? "explicit"
    : sampledParallelism.source || commandParallelism.source;
  const requestedEvidence = explicitRequested
    ? { value: explicitRequested, source: "explicit" }
    : sampledParallelism.evidence || (commandParallelism.value ? commandParallelism : undefined);

  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT,
    sampleCount: normalizedSamples.length,
    activeCpuThreshold: threshold,
    requestedParallelism: requested,
    requestedParallelismSource: requestedSource,
    requestedParallelismEvidence: requestedEvidence || {},
    requestedParallelismCandidates: sampledParallelism.candidates.slice(0, 10),
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
  const loadedConfig = loadBuildchainConfig(resolvedCwd);
  const nativeProfile = getNativeDiagnosticsProfile(loadedConfig);
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    generatedAt: new Date().toISOString(),
    cwd: resolvedCwd,
    buildchain: collectBuildchainDiagnostics({ cwd: resolvedCwd, artifactPaths }),
    runner: collectRunnerDiagnostics(),
    tools: collectToolDiagnostics({ cwd: resolvedCwd }),
    cache: collectCacheDiagnostics({ cwd: resolvedCwd, cacheDirs }),
    native: collectNativeDiagnostics({ cwd: resolvedCwd, profile: nativeProfile }),
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

function stageDurationMs(stages = {}, stage) {
  return Math.round(Number(stages?.[stage]?.durationMs || 0));
}

function formatDiagnosticsDurationMs(value) {
  const durationMs = Math.round(Number(value || 0));
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "-";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  if (durationMs < 60000) {
    const seconds = durationMs / 1000;
    return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : Math.round(seconds)}s`;
  }
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.round((durationMs % 60000) / 1000);
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function compactProcessSummary(process = {}) {
  const observedConcurrency = process?.observedConcurrency || {};
  const topCommands = Array.isArray(process?.topCommands)
    ? process.topCommands.slice(0, 3).map((entry) => ({
        command: entry.command || "",
        category: entry.category || "",
        maxConcurrent: Number(entry.maxConcurrent || 0),
        maxCpu: Number(entry.maxCpu || 0),
      }))
    : [];
  return {
    requestedParallelism: Number(process?.requestedParallelism || 0),
    requestedParallelismSource: process?.requestedParallelismSource || "",
    observedConcurrencyMax: Number(observedConcurrency.max || 0),
    ratioToRequestedMax: Number(observedConcurrency.ratioToRequestedMax || 0),
    sampleCount: Number(process?.sampleCount || 0),
    categories: process?.categories || {},
    topCommands,
  };
}

function formatDiagnosticsProcessValue(value) {
  const number = Number(value || 0);
  return number > 0 ? String(number) : "-";
}

function compactRunnerDetails(runner = {}) {
  return {
    os: {
      platform: runner.os?.platform || "",
      release: runner.os?.release || "",
      arch: runner.os?.arch || "",
      type: runner.os?.type || "",
    },
    github: {
      actions: Boolean(runner.github?.actions),
      runnerOs: runner.github?.runnerOs || "",
      runnerArch: runner.github?.runnerArch || "",
      runnerName: runner.github?.runnerName || "",
    },
    cpu: {
      logicalCount: Number(runner.cpu?.logicalCount || 0),
      model: runner.cpu?.model || "",
      loadAverage: Array.isArray(runner.cpu?.loadAverage)
        ? runner.cpu.loadAverage.map((entry) => Number(entry || 0))
        : [],
    },
    memory: {
      totalBytes: Number(runner.memory?.totalBytes || 0),
      freeBytes: Number(runner.memory?.freeBytes || 0),
    },
    uptimeSeconds: Number(runner.uptimeSeconds || 0),
  };
}

function compactToolSummary(...toolSets) {
  const merged = {};
  for (const toolSet of toolSets) {
    for (const [name, details] of Object.entries(toolSet || {})) {
      merged[name] = details || {};
    }
  }
  const versions = {};
  const missing = [];
  for (const [name, details] of Object.entries(merged).sort(([left], [right]) => left.localeCompare(right))) {
    const version = String(details?.version || "").trim();
    if (version) {
      versions[name] = version;
    } else {
      missing.push(name);
    }
  }
  return {
    checked: Object.keys(merged).length,
    available: Object.keys(versions).length,
    missing,
    versions,
  };
}

function compactStatsObject(stats = {}, limit = 12) {
  const entries = [];
  const visit = (prefix, value) => {
    if (entries.length >= limit || value === undefined || value === null) {
      return;
    }
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      entries.push([prefix, value]);
      return;
    }
    if (Array.isArray(value) || typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
      visit(prefix ? `${prefix}.${key}` : key, nested);
      if (entries.length >= limit) {
        break;
      }
    }
  };
  visit("", stats);
  return Object.fromEntries(entries);
}

function compactCompilerCacheSummary(compilerCaches = {}) {
  return Object.fromEntries(
    Object.entries(compilerCaches || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, details]) => [name, {
        available: Boolean(details?.available),
        format: details?.format || "",
        rawBytes: Number(details?.rawBytes || 0),
        error: details?.error || "",
        stats: compactStatsObject(details?.stats || {}),
      }]),
  );
}

function compactCacheSummary(cache = {}, native = {}) {
  const workspace = cache.workspace || {};
  const workspacePackages = workspace && !workspace.error && !Array.isArray(workspace) && typeof workspace === "object"
    ? Object.keys(workspace).length
    : 0;
  return {
    packageManager: cache.packageManager || {},
    workspacePackages,
    workspaceError: workspace.error || "",
    dirs: Array.isArray(cache.dirs)
      ? cache.dirs.map((entry) => ({
          path: entry.path || "",
          exists: Boolean(entry.exists),
          type: entry.type || "",
          bytes: Number(entry.bytes || 0),
        }))
      : [],
    compilerCaches: compactCompilerCacheSummary({
      ...(cache.compilerCaches || {}),
      ...(native.compilerCaches || {}),
    }),
    nativeCacheDirs: Array.isArray(native.cacheDirs)
      ? native.cacheDirs.map((entry) => ({
          path: entry.path || "",
          exists: Boolean(entry.exists),
          type: entry.type || "",
          bytes: Number(entry.bytes || 0),
        }))
      : [],
  };
}

function resolveDiagnosticsInput(entry) {
  if (typeof entry !== "string") {
    return { diagnostics: entry, sourcePath: "" };
  }
  return {
    diagnostics: readDiagnosticsArtifact(entry),
    sourcePath: path.resolve(entry),
  };
}

function buildchainRootForPath(filePath) {
  const parts = path.resolve(filePath).split(path.sep);
  const index = parts.lastIndexOf(".buildchain");
  if (index <= 0) {
    return "";
  }
  const rootParts = parts.slice(0, index);
  return rootParts.length ? rootParts.join(path.sep) || path.sep : path.sep;
}

function diagnosticsManifestCandidates(diagnostics, sourcePath) {
  if (!sourcePath) {
    return [];
  }
  const candidates = [path.join(path.dirname(sourcePath), "diagnostics-manifest.json")];
  const linkedPath = diagnostics?.links?.diagnosticsManifest || "";
  if (linkedPath) {
    if (path.isAbsolute(linkedPath)) {
      candidates.push(linkedPath);
    } else {
      const buildchainRoot = buildchainRootForPath(sourcePath);
      if (buildchainRoot) {
        candidates.push(path.resolve(buildchainRoot, linkedPath));
      }
      candidates.push(path.resolve(process.cwd(), linkedPath));
      candidates.push(path.resolve(path.dirname(sourcePath), linkedPath));
    }
  }
  return [...new Set(candidates)];
}

function compactDiagnosticsManifestFile(entry = {}) {
  return {
    kind: entry.kind || "",
    path: entry.path || "",
    bytes: Number(entry.bytes || 0),
    sha256: entry.sha256 || "",
    required: Boolean(entry.required),
  };
}

function summarizeDiagnosticsContract(diagnostics = {}) {
  const actual = diagnostics?.contract || "";
  const warnings = [];
  if (actual !== BUILDCHAIN_DIAGNOSTICS_CONTRACT) {
    warnings.push(`unexpected diagnostics artifact contract: ${actual || "unknown"}`);
  }
  return {
    status: warnings.length ? "warning" : "verified",
    expected: BUILDCHAIN_DIAGNOSTICS_CONTRACT,
    actual,
    warningCount: warnings.length,
    warnings,
  };
}

function summarizeDiagnosticsManifest(diagnostics, sourcePath) {
  if (!sourcePath) {
    return undefined;
  }
  const candidates = diagnosticsManifestCandidates(diagnostics, sourcePath);
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || "";
  const relativePath = manifestPath
    ? posixPath(path.relative(path.dirname(sourcePath), manifestPath))
    : "";
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return {
      status: "missing",
      path: relativePath || "diagnostics-manifest.json",
      warningCount: 1,
      warnings: ["diagnostics sidecar manifest is missing"],
    };
  }

  const { value: manifest, error } = readJsonResult(manifestPath);
  if (error) {
    return {
      status: "invalid",
      path: relativePath,
      warningCount: 1,
      warnings: [`failed to read diagnostics sidecar manifest: ${error.message}`],
    };
  }

  const warnings = [];
  if (manifest?.contract !== BUILDCHAIN_DIAGNOSTICS_MANIFEST_CONTRACT) {
    warnings.push(`unexpected diagnostics sidecar manifest contract: ${manifest?.contract || "unknown"}`);
  }
  const files = Array.isArray(manifest?.files) ? manifest.files.map(compactDiagnosticsManifestFile) : [];
  if (!Array.isArray(manifest?.files)) {
    warnings.push("diagnostics sidecar manifest files must be an array");
  }
  const diagnosticsEntry = files.find((entry) => entry.kind === "diagnostics");
  if (!diagnosticsEntry) {
    warnings.push("diagnostics sidecar manifest does not list diagnostics.json");
  } else {
    const stat = fs.statSync(sourcePath);
    const digest = sha256File(sourcePath);
    if (diagnosticsEntry.bytes !== stat.size) {
      warnings.push("diagnostics sidecar manifest bytes do not match diagnostics.json");
    }
    if (diagnosticsEntry.sha256 && diagnosticsEntry.sha256 !== digest) {
      warnings.push("diagnostics sidecar manifest sha256 does not match diagnostics.json");
    }
  }

  return {
    status: warnings.length ? "warning" : "verified",
    path: relativePath,
    artifactName: manifest?.artifactName || "",
    diagnosticsArtifactName: manifest?.diagnosticsArtifactName || "",
    platformId: manifest?.platformId || "",
    fileCount: Number(manifest?.fileCount || files.length),
    totalBytes: Number(manifest?.totalBytes || files.reduce((sum, entry) => sum + entry.bytes, 0)),
    files,
    warningCount: warnings.length,
    warnings,
  };
}

function formatDiagnosticsSummaryRows(rows = []) {
  const widths = rows[0].map((_, columnIndex) => (
    Math.max(...rows.map((row) => String(row[columnIndex] ?? "").length))
  ));
  return rows
    .map((row) => row.map((cell, index) => String(cell ?? "").padEnd(widths[index], " ")).join("  ").trimEnd())
    .join("\n");
}

export function formatDiagnosticsSummaryTable(summary = {}) {
  const rows = [[
    "platform",
    "head",
    "install",
    "build",
    "verify",
    "publish",
    "scan",
    "upload",
    "total",
    "jobs",
    "active",
    "warn",
    "err",
  ]];
  for (const platform of summary.platforms || []) {
    const label = `${platform.runner || "unknown"}/${platform.arch || "unknown"}`;
    const processSummary = compactProcessSummary(platform.process);
    rows.push([
      label,
      platform.gitHead ? platform.gitHead.slice(0, 12) : "-",
      formatDiagnosticsDurationMs(stageDurationMs(platform.lifecycle, "install")),
      formatDiagnosticsDurationMs(stageDurationMs(platform.lifecycle, "build")),
      formatDiagnosticsDurationMs(stageDurationMs(platform.lifecycle, "verify")),
      formatDiagnosticsDurationMs(stageDurationMs(platform.lifecycle, "publish")),
      formatDiagnosticsDurationMs(platform.artifactScanDurationMs),
      formatDiagnosticsDurationMs(platform.artifactUploadDurationMs),
      formatDiagnosticsDurationMs(platform.totalDurationMs),
      formatDiagnosticsProcessValue(processSummary.requestedParallelism),
      formatDiagnosticsProcessValue(processSummary.observedConcurrencyMax),
      platform.warningCount || 0,
      platform.errorCount || 0,
    ]);
  }
  return formatDiagnosticsSummaryRows(rows);
}

export function summarizeDiagnosticsArtifacts(inputs = []) {
  const diagnostics = inputs
    .map(resolveDiagnosticsInput)
    .filter((entry) => entry.diagnostics);
  const platforms = diagnostics.map(({ diagnostics: entry, sourcePath }) => {
    const lifecycle = entry.lifecycleObservability?.stages || {};
    const lifecycleTotalDurationMs = sumLifecycleDurationMs(lifecycle);
    const artifactScanDurationMs = Math.round(Number(entry.lifecycleObservability?.artifactScan?.durationMs || 0));
    const artifactUploadDurationMs = Math.round(Number(entry.lifecycleObservability?.artifactUpload?.durationMs || 0));
    const diagnosticsContract = summarizeDiagnosticsContract(entry);
    const diagnosticsManifest = summarizeDiagnosticsManifest(entry, sourcePath);
    return {
      runner: entry.runner?.github?.runnerOs || entry.runner?.os?.platform || "unknown",
      arch: entry.runner?.github?.runnerArch || entry.runner?.os?.arch || "unknown",
      gitHead: entry.git?.head || "",
      lifecycle,
      lifecycleTotalDurationMs,
      artifactScanDurationMs,
      artifactUploadDurationMs,
      totalDurationMs: lifecycleTotalDurationMs + artifactScanDurationMs + artifactUploadDurationMs,
      totalBytes: Number(entry.lifecycleObservability?.totalBytes || 0),
      fileCount: Number(entry.lifecycleObservability?.fileCount || 0),
      topSlowSpans: (entry.lifecycleObservability?.topSlowSpans || []).slice(0, 5),
      runnerDetails: compactRunnerDetails(entry.runner || {}),
      tools: compactToolSummary(entry.tools || {}, entry.native?.tools || {}),
      cache: compactCacheSummary(entry.cache || {}, entry.native || {}),
      process: entry.process || {},
      diagnosticsContract,
      ...(diagnosticsManifest ? { diagnosticsManifest } : {}),
      links: entry.links || {},
      warningCount: entry.lifecycleObservability?.warningCount || 0,
      errorCount: entry.lifecycleObservability?.errorCount || 0,
    };
  });
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_DIAGNOSTICS_SUMMARY_CONTRACT,
    generatedAt: new Date().toISOString(),
    count: diagnostics.length,
    totalWarningCount: platforms.reduce((sum, entry) => sum + entry.warningCount, 0),
    totalErrorCount: platforms.reduce((sum, entry) => sum + entry.errorCount, 0),
    diagnosticsManifestWarningCount: platforms.reduce(
      (sum, entry) => sum + Number(entry.diagnosticsManifest?.warningCount || 0),
      0,
    ),
    diagnosticsContractWarningCount: platforms.reduce(
      (sum, entry) => sum + Number(entry.diagnosticsContract?.warningCount || 0),
      0,
    ),
    slowestPlatforms: platforms
      .map(({ runner, arch, gitHead, lifecycleTotalDurationMs, totalDurationMs, process }) => ({
        runner,
        arch,
        gitHead,
        lifecycleTotalDurationMs,
        totalDurationMs,
        process: compactProcessSummary(process),
      }))
      .sort((left, right) => right.totalDurationMs - left.totalDurationMs)
      .slice(0, 10),
    platforms,
  };
}

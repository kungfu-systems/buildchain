import { toPosix } from "./files.js";
import fs from "node:fs";
import path from "node:path";
import { installationRoot } from "../../runtime/installation-root.js";
import { runLifecycleStage } from "../../consumer/buildchain-config.js";
import { runProcessTreeCommandSync } from "../../runtime/spawn-command.js";
import { BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT } from "../../observability/diagnostics.js";
import { BUILDCHAIN_PROCESS_SAMPLE_SUMMARY_CONTRACT } from "../../observability/diagnostics.js";
export function resolveProcessSamplerWorker() {
  return path.join(
    installationRoot(import.meta.url),
    "packages/core/providers/process/sample-worker.mjs",
  );
}

export function readProcessSummaryArtifact(filePath) {
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
    throw new Error(
      `failed to read process summary file ${filePath}: ${error.message}`,
    );
  }
  if (
    artifact?.contract === BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT &&
    artifact.summary
  ) {
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
  throw new Error(
    `process summary file has unsupported contract: ${artifact?.contract || "unknown"}`,
  );
}

export function readOptionalProcessSummaryArtifact(filePath) {
  try {
    return readProcessSummaryArtifact(filePath);
  } catch {
    return undefined;
  }
}

export function attachProcessSampleFailureEvidence(error, processSummaryPath) {
  const artifact =
    readOptionalProcessSummaryArtifact(processSummaryPath)?.artifact;
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

export function shellCommandArgs(command, shell, env) {
  if (typeof shell === "string" && shell.trim()) {
    return [shell, "-c", command];
  }
  if (process.platform === "win32") {
    return [env.ComSpec || "cmd.exe", "/d", "/s", "/c", `"${command}"`];
  }
  return [env.SHELL || "/bin/sh", "-c", command];
}

export function samplerPathForCwd(filePath, cwd) {
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? toPosix(relative)
    : filePath;
}

export function executeSampledShellCommand({
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
  const [executable, ...commandArgs] = shellCommandArgs(command, shell, env);
  const args = [
    resolveProcessSamplerWorker(),
    JSON.stringify({
      command: executable,
      args: commandArgs,
      label: label || "lifecycle",
      intervalMs: processSampleIntervalMs || 15000,
      requestedParallelism: Number(requestedParallelism || 0),
      outputPath: samplerPathForCwd(processSamplesPath, cwd),
      summaryOutputPath: samplerPathForCwd(processSummaryPath, cwd),
    }),
  ];
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

export function stageCommandText(stage) {
  if (stage.mode === "script") {
    return stage.script;
  }
  if (process.platform === "win32") {
    return stage.commands.join(" && ");
  }
  return ["set -e", ...stage.commands].join("\n");
}

export function runLifecycleStageWithSampler({
  cwd,
  loadedConfig,
  name,
  env,
  baseEnv = process.env,
  sampleProcessTree,
  processSummaryPath,
  processSamplesPath,
  processSampleIntervalMs,
  requestedParallelism,
  timeoutMinutes,
}) {
  if (!sampleProcessTree) {
    return runLifecycleStage({
      cwd,
      loadedConfig,
      name,
      env,
      baseEnv,
      timeoutMinutes,
    });
  }
  const lifecycle = loadedConfig?.config?.lifecycle || {};
  const stage = lifecycle[name];
  if (!stage) {
    return false;
  }
  const stageEnv = {
    ...baseEnv,
    ...(lifecycle.env || {}),
    ...(stage.env || {}),
    ...(env || {}),
  };
  const effectiveTimeoutMinutes = stage.timeoutMinutes ?? timeoutMinutes;
  const timeout = effectiveTimeoutMinutes
    ? effectiveTimeoutMinutes * 60_000
    : undefined;
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
        console.log(
          `> lifecycle ${name || "stage"} failed, retry ${attempt + 1}/${stage.retries}`,
        );
      }
    }
  }
  throw lastError;
}

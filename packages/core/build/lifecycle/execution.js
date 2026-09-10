import { lifecycleErrorAttributes } from "./errors.js";
import { describeLifecycleTimeout } from "./errors.js";
import { executeSampledShellCommand } from "./sampling.js";
import { runLifecycleStageWithSampler } from "./sampling.js";
import { runShellCommandSync } from "../../runtime/spawn-command.js";
export function commandFileEnvironment(env) {
  return Object.fromEntries(
    [
      "GITHUB_ENV",
      "GITHUB_PATH",
      "GITHUB_OUTPUT",
      "GITHUB_STATE",
      "GITHUB_STEP_SUMMARY",
    ]
      .filter((key) => env[key])
      .map((key) => [key, env[key]]),
  );
}

export function executeWorkflowLifecycleCommand(context) {
  const {
    command,
    stageName,
    sampleProcessTree,
    processSampleIntervalMs,
    requestedParallelism,
    timeoutMinutes,
    resolvedCwd,
    resolvedLogPath,
    resolvedProcessSummaryPath,
    resolvedProcessSamplesPath,
    logRunId,
    loadedConfig,
    userLog,
    platformId,
    platformName,
  } = context;
  context.commandSource = "workflow-input";
  const lifecycle = loadedConfig?.config?.lifecycle || {};
  const configuredStage = stageName ? lifecycle[stageName] : undefined;
  const commandShell = configuredStage?.shell || true;
  const effectiveCommandTimeoutMinutes =
    configuredStage?.timeoutMinutes ?? timeoutMinutes;
  const startedAt = Date.now();
  userLog.info("lifecycle.command.start", {
    attributes: {
      commandSource: context.commandSource,
      stage: stageName || "command",
      sampleProcessTree,
    },
  });
  try {
    const commandEnv = {
      ...context.env,
      ...(lifecycle.env || {}),
      ...(configuredStage?.env || {}),
      ...commandFileEnvironment(context.env),
      ...(resolvedLogPath
        ? {
            BUILDCHAIN_LOG_PATH: resolvedLogPath,
            BUILDCHAIN_LOG_RUN_ID: logRunId,
          }
        : {}),
    };
    const timeout = effectiveCommandTimeoutMinutes
      ? effectiveCommandTimeoutMinutes * 60_000
      : undefined;
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
        timeout,
      });
    } else {
      runShellCommandSync(command, {
        cwd: resolvedCwd,
        env: commandEnv,
        shell: commandShell,
        stdio: "inherit",
        timeout,
      });
    }
    context.executed = true;
    userLog.info("lifecycle.command.end", {
      durationMs: Date.now() - startedAt,
      attributes: {
        commandSource: context.commandSource,
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
        commandSource: context.commandSource,
        stage: stageName || "command",
        sampleProcessTree,
      }),
    });
    throw lifecycleError;
  }
}

export function executeConfiguredLifecycleStage(context) {
  const {
    stageName,
    sampleProcessTree,
    timeoutMinutes,
    processSampleIntervalMs,
    requestedParallelism,
    resolvedCwd,
    resolvedLogPath,
    resolvedProcessSummaryPath,
    resolvedProcessSamplesPath,
    logRunId,
    loadedConfig,
    userLog,
    platformId,
    platformName,
  } = context;
  context.commandSource = "buildchain.toml";
  const startedAt = Date.now();
  userLog.info("lifecycle.stage.start", {
    attributes: {
      commandSource: context.commandSource,
      stage: stageName,
      sampleProcessTree,
    },
  });
  try {
    context.executed = runLifecycleStageWithSampler({
      cwd: resolvedCwd,
      loadedConfig,
      name: stageName,
      baseEnv: context.env,
      env: {
        ...commandFileEnvironment(context.env),
        ...(resolvedLogPath
          ? {
              BUILDCHAIN_LOG_PATH: resolvedLogPath,
              BUILDCHAIN_LOG_RUN_ID: logRunId,
            }
          : {}),
      },
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
        commandSource: context.commandSource,
        stage: stageName,
        executed: context.executed,
      },
    });
  } catch (error) {
    const lifecycleError = describeLifecycleTimeout(error, {
      timeoutMinutes:
        loadedConfig?.config?.lifecycle?.[stageName]?.timeoutMinutes ??
        timeoutMinutes,
      stageName,
      platformId,
      platformName,
    });
    userLog.error("lifecycle.stage.error", {
      durationMs: Date.now() - startedAt,
      message: "lifecycle stage failed",
      attributes: lifecycleErrorAttributes(lifecycleError, {
        commandSource: context.commandSource,
        stage: stageName,
        sampleProcessTree,
      }),
    });
    throw lifecycleError;
  }
}

export function executeLifecycle(context) {
  const {
    stageName,
    artifactName,
    platformId,
    command,
    required,
    frameworkLog,
  } = context;
  frameworkLog.info("lifecycle.start", {
    attributes: { stage: stageName, artifactName, platformId },
  });
  if (command.trim()) executeWorkflowLifecycleCommand(context);
  else if (stageName) executeConfiguredLifecycleStage(context);
  if (required && !context.executed) {
    frameworkLog.error("lifecycle.required-missing", {
      attributes: {
        stage: stageName || "command",
        commandSource: context.commandSource,
      },
    });
    throw new Error(
      `required lifecycle stage did not run: ${stageName || "command"}`,
    );
  }
}

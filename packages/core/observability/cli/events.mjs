import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  createBuildchainLogger,
  defaultBuildchainLogPath,
  summarizeBuildchainLogEvents,
} from "../logging.js";
import {
  printJson,
  readBooleanFlag,
  readFlag,
  readJsonInput,
  readRepeatedFlag,
  readRepeatedJsonInputs,
  writeJsonFile,
} from "../../contracts/cli/options.mjs";
import { cliLogger, defaultCliLogPath, readAttributes } from "./context.mjs";

export async function handleLogCommand(args) {
  const [levelOrSubcommand = "info", ...logArgs] = args;
  if (levelOrSubcommand === "summary") {
    const logPath = defaultCliLogPath(logArgs);
    const summary = summarizeBuildchainLogEvents({ path: logPath });
    if (readBooleanFlag(logArgs, "json")) {
      printJson(summary);
    } else {
      process.stdout.write(
        `buildchain log summary: ${summary.eventCount} events\n`,
      );
      process.stdout.write(
        `sources: ${Object.keys(summary.sources).join(", ") || "none"}\n`,
      );
      process.stdout.write(
        `phases: ${Object.keys(summary.phases).join(", ") || "none"}\n`,
      );
      if (summary.controlPlane.eventCount > 0) {
        process.stdout.write(
          `control plane: ${summary.controlPlane.eventCount} events, ` +
            `incident reuse ${summary.controlPlane.workflowFriction.incidentReuseRate ?? "n/a"}, ` +
            `release-intent suppression ${summary.controlPlane.releaseIntent.suppressionRate ?? "n/a"}\n`,
        );
      }
    }
    return;
  }
  if (!["info", "warn", "error"].includes(levelOrSubcommand)) {
    throw new Error("usage: buildchain log <info|warn|error> --event <name>");
  }
  const eventName = readFlag(logArgs, "event", "");
  if (!eventName) {
    throw new Error("buildchain log requires --event <name>");
  }
  const logger = cliLogger(logArgs);
  const event = logger.emit(levelOrSubcommand, eventName, {
    message: readFlag(logArgs, "message", ""),
    attributes: readAttributes(logArgs),
  });
  if (readBooleanFlag(logArgs, "json")) {
    printJson(event);
  }
  return;
}

export async function handleMarkCommand(args) {
  const eventName = readFlag(args, "event", "");
  if (!eventName) {
    throw new Error("buildchain mark requires --event <name>");
  }
  const logger = cliLogger(args);
  const event = logger.mark(eventName, {
    message: readFlag(args, "message", ""),
    attributes: readAttributes(args),
  });
  if (readBooleanFlag(args, "json")) {
    printJson(event);
  }
  return;
}

export async function handleSpanCommand(args) {
  const separator = args.indexOf("--");
  const spanArgs = separator === -1 ? args : args.slice(0, separator);
  const commandArgs = separator === -1 ? [] : args.slice(separator + 1);
  const eventName = readFlag(spanArgs, "event", "");
  if (!eventName || commandArgs.length === 0) {
    throw new Error(
      "usage: buildchain span --event <name> -- <command> [args...]",
    );
  }
  const logger = cliLogger(spanArgs);
  const spanId = crypto.randomUUID();
  const startedAt = Date.now();
  logger.info(`${eventName}.start`, {
    spanId,
    message: readFlag(spanArgs, "message", ""),
    attributes: readAttributes(spanArgs),
  });
  const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const durationMs = Date.now() - startedAt;
  if (result.error || result.status !== 0) {
    logger.error(`${eventName}.error`, {
      spanId,
      durationMs,
      message:
        result.error?.message ||
        `command exited with ${result.status ?? "signal"}`,
      attributes: {
        ...readAttributes(spanArgs),
        status: result.status ?? "",
        signal: result.signal || "",
      },
    });
    process.exitCode = result.status ?? 1;
    return;
  }
  logger.info(`${eventName}.end`, {
    spanId,
    durationMs,
    attributes: readAttributes(spanArgs),
  });
  return;
}

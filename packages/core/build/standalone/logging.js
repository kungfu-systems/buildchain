import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export function timed(logger, eventName, details, callback) {
  const spanId = crypto.randomUUID();
  const startedAt = Date.now();
  logger.info(`${eventName}.start`, { ...details, spanId });
  try {
    const result = callback();
    logger.info(`${eventName}.end`, {
      ...details,
      spanId,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logger.error(`${eventName}.error`, {
      ...details,
      spanId,
      durationMs: Date.now() - startedAt,
      message: error.message,
      attributes: {
        ...(details.attributes || {}),
        errorName: error.name,
      },
    });
    throw error;
  }
}

export function relativePath(cwd, targetPath) {
  return path.relative(cwd, targetPath).split(path.sep).join("/");
}

export function writeLogSummary(logger, cwd, outputDir, archiveBase) {
  if (!logger.path) {
    return "";
  }
  const summaryPath = path.join(outputDir, `${archiveBase}.log-summary.json`);
  const summary = logger.summary();
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return relativePath(cwd, summaryPath);
}

export function readLogPath(value) {
  if (value === false || value === "false") {
    return false;
  }
  if (typeof value === "string" && value) {
    return value;
  }
  return undefined;
}

export function noopLogger() {
  return {
    path: "",
    info: () => undefined,
    error: () => undefined,
    summary: () => ({
      schemaVersion: 1,
      contract: "kungfu-buildchain-log-summary",
      eventCount: 0,
      warningCount: 0,
      errorCount: 0,
      durationMs: 0,
      sources: {},
      phases: {},
      components: {},
    }),
  };
}

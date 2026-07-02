import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILDCHAIN_LOG_EVENT_CONTRACT = "kungfu-buildchain-log-event";
export const BUILDCHAIN_LOG_SUMMARY_CONTRACT = "kungfu-buildchain-log-summary";

const SECRET_KEY_PATTERN =
  /(authorization|cookie|credential|password|passwd|private[_-]?key|secret|token|api[_-]?key)/i;

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

function scalarValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

export function redactBuildchainLogAttributes(attributes = {}) {
  const redacted = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    redacted[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : scalarValue(value);
  }
  return redacted;
}

export function defaultBuildchainLogPath({ cwd = process.cwd() } = {}) {
  return path.join(cwd, ".buildchain", "logs", "events.jsonl");
}

export function normalizeBuildchainLogEvent(input = {}, defaults = {}) {
  const timestamp = input.timestamp || new Date().toISOString();
  return compactObject({
    schemaVersion: 1,
    contract: BUILDCHAIN_LOG_EVENT_CONTRACT,
    timestamp,
    level: input.level || defaults.level || "info",
    source: input.source || defaults.source || "buildchain",
    component: input.component || defaults.component || "cli",
    event: input.event || defaults.event || "event",
    phase: input.phase || defaults.phase,
    spanId: input.spanId || defaults.spanId,
    parentSpanId: input.parentSpanId || defaults.parentSpanId,
    durationMs: Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : undefined,
    message: input.message || defaults.message,
    attributes: redactBuildchainLogAttributes({
      ...(defaults.attributes || {}),
      ...(input.attributes || {}),
    }),
  });
}

export function appendBuildchainLogEvent(filePath, event) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

export function readBuildchainLogEvents(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function groupSummary(events, field) {
  const groups = {};
  for (const event of events) {
    const key = event[field] || "unknown";
    const current = groups[key] || { count: 0, durationMs: 0 };
    current.count += 1;
    current.durationMs += Number(event.durationMs || 0);
    groups[key] = current;
  }
  return Object.fromEntries(
    Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function summarizeBuildchainLogEvents(input = {}) {
  const events = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? readBuildchainLogEvents(input)
      : readBuildchainLogEvents(input.path);
  const errorCount = events.filter((event) => event.level === "error").length;
  const warningCount = events.filter((event) => event.level === "warn").length;
  return {
    schemaVersion: 1,
    contract: BUILDCHAIN_LOG_SUMMARY_CONTRACT,
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    warningCount,
    errorCount,
    durationMs: events.reduce((sum, event) => sum + Number(event.durationMs || 0), 0),
    sources: groupSummary(events, "source"),
    phases: groupSummary(events, "phase"),
    components: groupSummary(events, "component"),
  };
}

export function createBuildchainLogger(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const runningInActions = process.env.GITHUB_ACTIONS === "true";
  const resolvedPath =
    options.path === false
      ? ""
      : options.path || process.env.BUILDCHAIN_LOG_PATH || (runningInActions ? defaultBuildchainLogPath({ cwd }) : "");
  const consoleEnabled = options.console ?? !resolvedPath;
  const defaults = {
    source: options.source || "buildchain",
    component: options.component || "cli",
    phase: options.phase || "",
    attributes: {
      ...(process.env.BUILDCHAIN_LOG_RUN_ID
        ? { buildchainLogRunId: process.env.BUILDCHAIN_LOG_RUN_ID }
        : {}),
      ...(options.attributes || {}),
    },
  };
  const inMemoryEvents = [];

  function emit(level, eventName, details = {}) {
    const event = normalizeBuildchainLogEvent(
      {
        ...details,
        level,
        event: eventName,
      },
      defaults,
    );
    try {
      appendBuildchainLogEvent(resolvedPath, event);
    } catch (error) {
      if (options.strict) {
        throw error;
      }
    }
    inMemoryEvents.push(event);
    if (consoleEnabled) {
      const message = event.message ? ` ${event.message}` : "";
      process.stderr.write(`[buildchain] ${event.level} ${event.event}${message}\n`);
    }
    return event;
  }

  async function span(eventName, details = {}, callback = async () => undefined) {
    const spanId = details.spanId || crypto.randomUUID();
    const startedAt = Date.now();
    emit("info", `${eventName}.start`, { ...details, spanId });
    try {
      const result = await callback({ spanId });
      emit("info", `${eventName}.end`, {
        ...details,
        spanId,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      emit("error", `${eventName}.error`, {
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

  return {
    path: resolvedPath,
    events: inMemoryEvents,
    emit,
    info: (eventName, details) => emit("info", eventName, details),
    warn: (eventName, details) => emit("warn", eventName, details),
    error: (eventName, details) => emit("error", eventName, details),
    mark: (eventName, details) => emit("info", eventName, details),
    span,
    summary: () => summarizeBuildchainLogEvents(resolvedPath ? { path: resolvedPath } : inMemoryEvents),
  };
}

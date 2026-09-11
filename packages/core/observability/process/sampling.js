import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
  startProcessSampler,
  summarizeProcessSamples,
} from "../diagnostics.js";
export function appendJsonLine(filePath, value) {
  if (!filePath) {
    return "";
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
  return filePath;
}

export function createTailBuffer(limit = 64 * 1024) {
  let value = "";
  return {
    append(chunk) {
      value += Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : String(chunk || "");
      if (value.length > limit) {
        value = value.slice(value.length - limit);
      }
    },
    text() {
      return value;
    },
  };
}

export async function sampleProcessTree(
  {
    command,
    args = [],
    cwd,
    environment,
    label = "process-tree",
    intervalMs = 15000,
    requestedParallelism = 0,
    outputPath,
    summaryOutputPath,
  },
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (!command || !Array.isArray(args))
    throw new Error("Process sampling requires a command and argument vector");
  const startedAt = Date.now();
  const stdoutTail = createTailBuffer();
  const stderrTail = createTailBuffer();
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments:
      process.platform === "win32" &&
      path.basename(command).toLowerCase() === "cmd.exe" &&
      args[0] === "/d" &&
      args[1] === "/s" &&
      args[2] === "/c",
  });
  child.stdout?.on("data", (chunk) => {
    stdoutTail.append(chunk);
    stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderrTail.append(chunk);
    stderr.write(chunk);
  });
  const sampler = startProcessSampler({
    rootPid: child.pid || process.pid,
    intervalMs,
    label,
    command,
    args,
    env: environment,
    requestedParallelism,
    onSample(sample) {
      appendJsonLine(outputPath, sample);
    },
  });
  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error, status: 1, signal: "" }));
    child.on("close", (status, signal) =>
      resolve({ status: status ?? 0, signal: signal || "" }),
    );
  });
  const samples = sampler.stop();
  const summary = summarizeProcessSamples({
    samples,
    command,
    args,
    env: environment,
    requestedParallelism,
  });
  const report = {
    schemaVersion: 1,
    contract: BUILDCHAIN_PROCESS_SAMPLE_REPORT_CONTRACT,
    label,
    command: path.basename(command),
    argsCount: args.length,
    exit: {
      status: result.status ?? 0,
      signal: result.signal || "",
      error: result.error?.message || "",
    },
    wrappedCommand: {
      command,
      args,
      rootPid: child.pid || 0,
      exitCode: result.status ?? 0,
      signal: result.signal || "",
      error: result.error?.message || "",
      stdoutTail: stdoutTail.text(),
      stderrTail: stderrTail.text(),
    },
    durationMs: Date.now() - startedAt,
    samplesPath: outputPath,
    summaryPath: summaryOutputPath,
    summary,
  };
  fs.mkdirSync(path.dirname(summaryOutputPath), { recursive: true });
  fs.writeFileSync(summaryOutputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

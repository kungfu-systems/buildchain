import { sampleProcessTree } from "../process/sampling.js";
import { printJson, readBooleanFlag, readFlag } from "../../contracts/cli/options.mjs";
export function readIntegerFlag(args, name, fallback = 0) {
  const value = readFlag(args, name, "");
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

export async function runProcessTreeSample(sampleArgs = []) {
  const separator = sampleArgs.indexOf("--");
  const optionArgs =
    separator === -1 ? sampleArgs : sampleArgs.slice(0, separator);
  const commandArgs = separator === -1 ? [] : sampleArgs.slice(separator + 1);
  if (commandArgs.length === 0) {
    throw new Error(
      "usage: buildchain sample process-tree -- <command> [args...]",
    );
  }
  const command = commandArgs[0];
  const args = commandArgs.slice(1);
  const label = readFlag(optionArgs, "label", "process-tree");
  const intervalMs = readIntegerFlag(optionArgs, "interval-ms", 15000);
  const requestedParallelism = readIntegerFlag(
    optionArgs,
    "requested-parallelism",
    0,
  );
  const outputPath = readFlag(
    optionArgs,
    "output",
    ".buildchain/diagnostics/process-samples.jsonl",
  );
  const summaryOutputPath = readFlag(
    optionArgs,
    "summary-output",
    ".buildchain/diagnostics/process-summary.json",
  );
  const report = await sampleProcessTree({ command, args, label, intervalMs, requestedParallelism, outputPath, summaryOutputPath, cwd: process.cwd(), environment: process.env });
  const { summary } = report;
  if (readBooleanFlag(optionArgs, "json")) {
    printJson(report);
  } else {
    process.stdout.write(
      `buildchain process sample: ${summary.sampleCount} samples\n`,
    );
    process.stdout.write(
      `observed concurrency max: ${summary.observedConcurrency.max}\n`,
    );
    process.stdout.write(`wrote: ${outputPath}\n`);
    process.stdout.write(`wrote: ${summaryOutputPath}\n`);
  }
  if (report.exit.error || report.exit.signal || report.exit.status !== 0) process.exitCode = report.exit.status || 1;
  return report;
}

export async function handleSampleCommand(args) {
  const [subcommand = "", ...sampleArgs] = args;
  if (subcommand !== "process-tree") {
    throw new Error(
      "usage: buildchain sample process-tree -- <command> [args...]",
    );
  }
  await runProcessTreeSample(sampleArgs);
  return;
}

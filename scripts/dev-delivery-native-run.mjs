#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { devDeliveryContentRoot } from "../packages/core/dev-delivery-warrant.js";
import { runDevDeliveryCommand } from "./dev-delivery-warrant.mjs";

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

function positiveInteger(value, label, fallback) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function exactRoot(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(`${label} must be a sha256 content root`);
  }
  return normalized;
}

export async function runNativeWithHeartbeat({
  command,
  cwd = process.cwd(),
  heartbeat,
  executionBinding = {},
  intervalMs = 30_000,
  spawnImpl = spawn,
  now = () => new Date().toISOString(),
} = {}) {
  if (!String(command || "").trim()) {
    throw new Error("native command is required");
  }
  if (typeof heartbeat !== "function") {
    throw new Error("heartbeat callback is required");
  }
  const startedAt = now();
  try {
    await heartbeat();
  } catch (error) {
    throw new Error(`native heartbeat failed: ${error.message}`);
  }
  let heartbeatCount = 1;
  let heartbeatError = null;
  let heartbeatRunning = false;
  const child = spawnImpl("bash", ["-lc", command], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  const beat = async () => {
    if (heartbeatRunning || heartbeatError) return;
    heartbeatRunning = true;
    try {
      await heartbeat();
      heartbeatCount += 1;
    } catch (error) {
      heartbeatError = error;
      child.kill("SIGTERM");
    } finally {
      heartbeatRunning = false;
    }
  };
  const timer = setInterval(beat, intervalMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearInterval(timer));
  while (heartbeatRunning) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (heartbeatError) {
    throw new Error(`native heartbeat failed: ${heartbeatError.message}`);
  }
  if (exit.code !== 0) {
    throw new Error(
      `native command failed with ${exit.signal || `exit ${exit.code}`}`,
    );
  }
  await beat();
  const completedAt = now();
  const receipt = {
    schema: "kungfu.buildchain.native-heartbeat-run-receipt/v1",
    outcome: "succeeded",
    commandRoot: devDeliveryContentRoot({ command }),
    executionBindingRoot: devDeliveryContentRoot(executionBinding),
    startedAt,
    completedAt,
    heartbeatCount,
  };
  return { ...receipt, receiptRoot: devDeliveryContentRoot(receipt) };
}

async function main() {
  const args = process.argv.slice(2);
  const repository = flag(args, "repository", process.env.GITHUB_REPOSITORY);
  const branch = flag(
    args,
    "branch",
    process.env.BUILDCHAIN_DEV_DELIVERY_BRANCH || process.env.GITHUB_BASE_REF,
  );
  const command = flag(
    args,
    "command",
    process.env.BUILDCHAIN_DEV_DELIVERY_NATIVE_COMMAND,
  );
  const cwd = path.resolve(
    flag(args, "working-directory", process.env.GITHUB_WORKSPACE),
  );
  const fencingToken = exactRoot(
    flag(
      args,
      "fencing-token",
      process.env.BUILDCHAIN_DEV_DELIVERY_FENCING_TOKEN,
    ),
    "fencingToken",
  );
  const leaseGeneration = positiveInteger(
    flag(
      args,
      "lease-generation",
      process.env.BUILDCHAIN_DEV_DELIVERY_LEASE_GENERATION,
    ),
    "leaseGeneration",
  );
  const leaseSeconds = positiveInteger(
    flag(
      args,
      "lease-seconds",
      process.env.BUILDCHAIN_DEV_DELIVERY_LEASE_SECONDS,
    ),
    "leaseSeconds",
    3600,
  );
  const heartbeatSeconds = positiveInteger(
    flag(
      args,
      "heartbeat-seconds",
      process.env.BUILDCHAIN_DEV_DELIVERY_HEARTBEAT_SECONDS,
    ),
    "heartbeatSeconds",
    Math.max(15, Math.floor(leaseSeconds / 3)),
  );
  if (heartbeatSeconds >= leaseSeconds) {
    throw new Error("heartbeatSeconds must be less than leaseSeconds");
  }
  const output = path.resolve(
    flag(args, "output", ".buildchain/dev-delivery/native-heartbeat-run.json"),
  );
  const result = await runNativeWithHeartbeat({
    command,
    cwd,
    intervalMs: heartbeatSeconds * 1000,
    heartbeat: async () => {
      await runDevDeliveryCommand({
        command: "heartbeat",
        repository,
        branch,
        fencingToken,
        leaseGeneration,
        leaseSeconds,
        execute: true,
      });
    },
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Native heartbeat run: ${result.receiptRoot}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`buildchain dev native: ${error.message}`);
    process.exit(1);
  });
}

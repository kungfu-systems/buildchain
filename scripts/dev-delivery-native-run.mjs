#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createNativeExecutionBinding, createNativeExecutionReceipt, devDeliveryContentRoot } from "../packages/core/dev-delivery-warrant.js";
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
  terminationGraceMs = 10_000,
  terminationKillMs = 5_000,
  spawnImpl = spawn,
  now = () => new Date().toISOString(),
} = {}) {
  if (!String(command || "").trim()) {
    throw new Error("native command is required");
  }
  if (typeof heartbeat !== "function") {
    throw new Error("heartbeat callback is required");
  }
  const boundExecution = createNativeExecutionBinding(executionBinding);
  const startedAt = now();
  try {
    await heartbeat();
  } catch (error) {
    throw new Error(`native heartbeat failed: ${error.message}`);
  }
  let heartbeatCount = 1;
  let heartbeatError = null;
  let heartbeatRunning = false;
  let childExited = false;
  let forceKillTimer = null;
  let terminationTimer = null;
  let rejectTermination;
  const terminationFailure = new Promise((_, reject) => {
    rejectTermination = reject;
  });
  const child = spawnImpl("bash", ["-lc", command], {
    cwd,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });

  const signalChild = (signal) => {
    if (childExited) return;
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall through to the direct child handle for mocked or already-exiting processes.
      }
    }
    child.kill(signal);
  };

  const terminateForFenceLoss = () => {
    signalChild("SIGTERM");
    forceKillTimer = setTimeout(() => {
      signalChild("SIGKILL");
      terminationTimer = setTimeout(() => {
        if (!childExited)
          rejectTermination(
            new Error("native worker did not stop after fencing loss"),
          );
      }, terminationKillMs);
      terminationTimer.unref?.();
    }, terminationGraceMs);
    forceKillTimer.unref?.();
  };

  const beat = async () => {
    if (heartbeatRunning || heartbeatError) return;
    heartbeatRunning = true;
    try {
      await heartbeat();
      heartbeatCount += 1;
    } catch (error) {
      heartbeatError = error;
      terminateForFenceLoss();
    } finally {
      heartbeatRunning = false;
    }
  };
  const timer = setInterval(beat, intervalMs);
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      childExited = true;
      resolve({ code, signal });
    });
  });
  const exit = await Promise.race([exitPromise, terminationFailure]).finally(
    () => {
      clearInterval(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
    },
  );
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
  return createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: devDeliveryContentRoot({ command }),
    executionBinding: boundExecution,
    startedAt,
    completedAt,
    heartbeatCount,
  });
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
  const sourceHead = flag(
    args,
    "source-head",
    process.env.BUILDCHAIN_DEV_DELIVERY_SOURCE_HEAD,
  );
  const qualifiedBase = flag(
    args,
    "qualified-base",
    process.env.BUILDCHAIN_DEV_DELIVERY_QUALIFIED_BASE,
  );
  const toolchainRoot = flag(
    args,
    "toolchain-root",
    process.env.BUILDCHAIN_DEV_DELIVERY_TOOLCHAIN_ROOT,
  );
  const environmentRoot = flag(
    args,
    "environment-root",
    process.env.BUILDCHAIN_DEV_DELIVERY_ENVIRONMENT_ROOT,
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
    executionBinding: {
      repository,
      protectedBase: branch,
      sourceHead,
      qualifiedBase,
      toolchainRoot,
      environmentRoot,
    },
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

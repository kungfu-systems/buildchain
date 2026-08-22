#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  createNativeCommandContract,
  createNativeExecutionBinding,
  createNativeExecutionReceipt,
} from "../packages/core/dev-delivery-warrant.js";
import { assertCredentiallessProcessAncestry } from "../packages/core/dev-delivery-process-boundary.js";

const NATIVE_CHILD_ENVIRONMENT_ALLOWLIST = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

export function createNativeChildEnvironment(controllerEnvironment = {}) {
  return Object.fromEntries(
    Object.entries(controllerEnvironment).filter(
      ([name, value]) =>
        NATIVE_CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase()) &&
        typeof value === "string",
    ),
  );
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
  controllerEnvironment = process.env,
  ancestryCheck = assertCredentiallessProcessAncestry,
  now = () => new Date().toISOString(),
} = {}) {
  if (!String(command || "").trim()) {
    throw new Error("native command is required");
  }
  if (typeof heartbeat !== "function") {
    throw new Error("heartbeat callback is required");
  }
  const commandContract = createNativeCommandContract(command);
  if (
    executionBinding.nativeCommandRoot &&
    executionBinding.nativeCommandRoot !== commandContract.commandRoot
  ) {
    throw new Error(
      "native command does not match the authorized command root",
    );
  }
  const boundExecution = createNativeExecutionBinding({
    ...executionBinding,
    nativeCommandRoot: commandContract.commandRoot,
  });
  ancestryCheck();
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
    env: createNativeChildEnvironment(controllerEnvironment),
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
        if (!childExited) {
          const error = new Error(
            "native worker did not stop after fencing loss",
          );
          error.code = "native-worker-termination-unproven";
          error.workerTerminationProven = false;
          rejectTermination(error);
        }
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
  if (heartbeatError) {
    throw new Error(`native heartbeat failed: ${heartbeatError.message}`);
  }
  const completedAt = now();
  return createNativeExecutionReceipt({
    outcome: "succeeded",
    commandRoot: commandContract.commandRoot,
    executionBinding: boundExecution,
    startedAt,
    completedAt,
    heartbeatCount,
  });
}

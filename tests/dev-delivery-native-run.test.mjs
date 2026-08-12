import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runNativeWithHeartbeat } from "../scripts/dev-delivery-native-run.mjs";

function childThatCompletes(delayMs = 20, code = 0) {
  const child = new EventEmitter();
  child.kill = () => {
    queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
  };
  setTimeout(() => child.emit("exit", code, null), delayMs);
  return child;
}

function childThatStopsOnSignal(signals) {
  const child = new EventEmitter();
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
  };
  return child;
}

test("slow native work heartbeats and seals a rooted success receipt", async () => {
  let heartbeats = 0;
  let clock = 0;
  const result = await runNativeWithHeartbeat({
    command: "native-shards",
    executionBinding: { sourceHead: "a".repeat(40) },
    intervalMs: 5,
    heartbeat: async () => {
      heartbeats += 1;
    },
    spawnImpl: () => childThatCompletes(24),
    now: () => `2026-08-11T00:00:${String(clock++).padStart(2, "0")}Z`,
  });
  assert.ok(heartbeats >= 2);
  assert.equal(result.heartbeatCount, heartbeats);
  assert.match(result.commandRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.executionBindingRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("heartbeat failure terminates native work and fails closed", async () => {
  let spawned = false;
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      intervalMs: 5,
      heartbeat: async () => {
        throw new Error("stale fencing token");
      },
      spawnImpl: () => {
        spawned = true;
        return childThatCompletes(100);
      },
    }),
    /native heartbeat failed: stale fencing token/u,
  );
  assert.equal(spawned, false);
});

test("fencing loss during native work terminates the worker before returning failure", async () => {
  let heartbeats = 0;
  const signals = [];
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      intervalMs: 5,
      terminationGraceMs: 5,
      terminationKillMs: 5,
      heartbeat: async () => {
        heartbeats += 1;
        if (heartbeats > 1) throw new Error("stale fencing token");
      },
      spawnImpl: () => childThatStopsOnSignal(signals),
    }),
    /native heartbeat failed: stale fencing token/u,
  );
  assert.ok(heartbeats > 1);
  assert.deepEqual(signals, ["SIGTERM"]);
});

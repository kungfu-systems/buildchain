import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createNativeCommandContract } from "../packages/core/dev-delivery-warrant.js";
import {
  createNativeChildEnvironment,
  runNativeWithHeartbeat as runNativeWithHeartbeatCore,
} from "../scripts/dev-delivery-native-run.mjs";
import {
  inspectCredentiallessProcessAncestry,
  isCredentialVariableName,
} from "../packages/core/dev-delivery-process-boundary.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const HOSTED_ENVIRONMENT = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  RUNNER_OS: "Linux",
  RUNNER_NAME: "GitHub Actions 7",
  BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY: "github-actions-runner-worker/v1",
};
const RUNNER_WORKER = "/home/runner/runners/2.999.0/bin/Runner.Worker";

function hostedAncestryFiles(overrides = {}) {
  return new Map([
    [
      "/proc/40/environ",
      "PATH=/bin\0BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY=github-actions-runner-worker/v1\0",
    ],
    ["/proc/40/cmdline", "/usr/bin/node\0controller.mjs\0"],
    ["/proc/40/status", "Name:\tnode\nPPid:\t30\n"],
    ["/proc/30/environ", "LANG=C\0"],
    ["/proc/30/cmdline", "/usr/bin/bash\0-e\0"],
    ["/proc/30/status", "Name:\tbash\nPPid:\t20\n"],
    ["/proc/20/environ", "RUNNER_TEMP=/tmp\0"],
    [
      "/proc/20/cmdline",
      `${RUNNER_WORKER}\u0000spawnclient\u000010\u000011\u0000`,
    ],
    ...Object.entries(overrides),
  ]);
}

function ancestryOptions(files = hostedAncestryFiles(), overrides = {}) {
  return {
    pid: 40,
    platform: "linux",
    environment: HOSTED_ENVIRONMENT,
    readFileSync(file) {
      if (files.has(file)) return files.get(file);
      const error = new Error("unreadable");
      error.code = "EACCES";
      throw error;
    },
    readlinkSync(file) {
      if (file === "/proc/20/exe") return RUNNER_WORKER;
      const error = new Error("unreadable");
      error.code = "EACCES";
      throw error;
    },
    ...overrides,
  };
}

function executionBinding() {
  return {
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    sourceHead: "a".repeat(40),
    qualifiedBase: "b".repeat(40),
    toolchainRoot: ROOT("1"),
    environmentRoot: ROOT("2"),
  };
}

const COMMAND_ROOT = createNativeCommandContract("native-shards").commandRoot;

function runNativeWithHeartbeat(options) {
  return runNativeWithHeartbeatCore({
    ancestryCheck: () => {},
    ...options,
  });
}

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
    executionBinding: executionBinding(),
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
  assert.deepEqual(result.executionBinding, {
    schema: "kungfu.buildchain.native-execution-binding/v2",
    ...executionBinding(),
    nativeCommandRoot: COMMAND_ROOT,
  });
  assert.equal(
    result.schema,
    "kungfu.buildchain.native-heartbeat-run-receipt/v3",
  );
  assert.match(result.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("native child environment is an explicit safe runtime allowlist", () => {
  const environment = createNativeChildEnvironment({
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "C.UTF-8",
    CI: "true",
    GITHUB_TOKEN: "sentinel-github",
    GH_TOKEN: "sentinel-gh",
    BUILDCHAIN_PROMOTION_TOKEN: "sentinel-promotion",
    SOME_SECRET: "sentinel-secret",
    DATABASE_CREDENTIAL: "sentinel-credential",
    INTERNAL_API_TOKEN_VALUE: "sentinel-token-like",
    AWS_ACCESS_KEY_ID: "sentinel-aws",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
    AWS_SESSION_TOKEN: "sentinel-aws-session",
    AZURE_CLIENT_SECRET: "sentinel-azure",
    GOOGLE_APPLICATION_CREDENTIALS: "/sentinel/google.json",
    NPM_TOKEN: "sentinel-npm",
    SSH_AUTH_SOCK: "/sentinel/agent.sock",
    HTTPS_PROXY: "https://sentinel:secret@example.invalid",
    NODE_OPTIONS: "--require=/sentinel/credential-reader.cjs",
  });

  assert.deepEqual(environment, {
    PATH: "/safe/bin",
    HOME: "/safe/home",
    LANG: "C.UTF-8",
    CI: "true",
  });
  assert.equal(
    Object.values(environment).some((value) => value.includes("sentinel")),
    false,
  );
});

test("mock native spawn cannot receive controller credentials", async () => {
  let spawnedEnvironment;
  await runNativeWithHeartbeat({
    command: "native-shards",
    executionBinding: executionBinding(),
    heartbeat: async () => {},
    controllerEnvironment: {
      PATH: "/safe/bin",
      HOME: "/safe/home",
      GITHUB_TOKEN: "sentinel-github",
      GH_TOKEN: "sentinel-gh",
      BUILDCHAIN_PROMOTION_TOKEN: "sentinel-promotion",
      PROVIDER_CREDENTIAL: "sentinel-provider",
      OPENAI_API_KEY: "sentinel-provider-key",
    },
    spawnImpl: (_file, _args, options) => {
      spawnedEnvironment = options.env;
      return childThatCompletes();
    },
  });

  assert.deepEqual(spawnedEnvironment, {
    PATH: "/safe/bin",
    HOME: "/safe/home",
  });
  assert.equal(JSON.stringify(spawnedEnvironment).includes("sentinel"), false);
});

test("hosted Linux ancestry accepts only non-credential runtime variables through the trusted worker boundary", () => {
  assert.equal(isCredentialVariableName("ACTIONS_RUNTIME_TOKEN"), true);
  assert.equal(
    isCredentialVariableName("ACTIONS_ID_TOKEN_REQUEST_TOKEN"),
    true,
  );
  const result = inspectCredentiallessProcessAncestry(ancestryOptions());
  assert.equal(result.ok, true);
  assert.deepEqual(result.traversed, [40, 30, 20]);
  assert.deepEqual(result.exposed, []);
  assert.deepEqual(result.boundary, {
    pid: 20,
    kind: "github-actions-runner-worker/v1",
    executable: RUNNER_WORKER,
  });
});

test("hosted Linux ancestry rejects a forged credential boundary marker", () => {
  const files = hostedAncestryFiles({
    "/proc/30/environ":
      "BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY=provider-secret\0",
  });
  const result = inspectCredentiallessProcessAncestry(ancestryOptions(files));
  assert.equal(result.ok, false);
  assert.deepEqual(result.exposed, [
    { pid: 30, names: ["BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY"] },
  ]);
});

test("hosted Linux ancestry accepts the kernel-resolved worker with basename argv zero", () => {
  const files = hostedAncestryFiles({
    "/proc/20/cmdline": "Runner.Worker\u0000spawnclient\u000010\u000011\u0000",
  });
  const result = inspectCredentiallessProcessAncestry(ancestryOptions(files));
  assert.equal(result.ok, true);
  assert.equal(result.boundary.executable, RUNNER_WORKER);
});

test("hosted Linux ancestry accepts an equivalent relative worker argv zero", () => {
  const files = hostedAncestryFiles({
    "/proc/20/cmdline":
      "./Runner.Worker\u0000spawnclient\u000010\u000011\u0000",
  });
  const result = inspectCredentiallessProcessAncestry(ancestryOptions(files));
  assert.equal(result.ok, true);
  assert.equal(result.boundary.executable, RUNNER_WORKER);
});

test("hosted Linux ancestry accepts the GitHub-hosted cached versioned worker path", () => {
  const cachedWorker =
    "/home/runner/actions-runner/cached/2.336.0/bin/Runner.Worker";
  const files = hostedAncestryFiles({
    "/proc/20/cmdline": `${cachedWorker}\u0000spawnclient\u000010\u000011\u0000`,
  });
  const result = inspectCredentiallessProcessAncestry(
    ancestryOptions(files, {
      readlinkSync(file) {
        if (file === "/proc/20/exe") return cachedWorker;
        const error = new Error("unreadable");
        error.code = "EACCES";
        throw error;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.boundary.executable, cachedWorker);
});

test("hosted Linux ancestry requires the exact versioned Runner.Worker spawnclient argv", () => {
  for (const [label, worker, command] of [
    [
      "unversioned runner directory",
      "/home/runner/runners/bin/Runner.Worker",
      "/home/runner/runners/bin/Runner.Worker\u0000spawnclient\u000010\u000011\u0000",
    ],
    [
      "lookalike version directory",
      "/home/runner/runners/current/2.999.0/bin/Runner.Worker",
      "/home/runner/runners/current/2.999.0/bin/Runner.Worker\u0000spawnclient\u000010\u000011\u0000",
    ],
    [
      "lookalike cached version directory",
      "/home/runner/actions-runner/cached/current/bin/Runner.Worker",
      "/home/runner/actions-runner/cached/current/bin/Runner.Worker\u0000spawnclient\u000010\u000011\u0000",
    ],
    [
      "lookalike worker name",
      "/home/runner/runners/2.999.0/bin/Runner.Worker.backup",
      "/home/runner/runners/2.999.0/bin/Runner.Worker.backup\u0000spawnclient\u000010\u000011\u0000",
    ],
    [
      "lookalike basename",
      RUNNER_WORKER,
      "Worker\u0000spawnclient\u000010\u000011\u0000",
    ],
    [
      "extra worker argv",
      RUNNER_WORKER,
      `${RUNNER_WORKER}\u0000spawnclient\u000010\u000011\u0000extra\u0000`,
    ],
  ]) {
    const files = hostedAncestryFiles({ "/proc/20/cmdline": command });
    assert.throws(
      () =>
        inspectCredentiallessProcessAncestry(
          ancestryOptions(files, {
            readlinkSync(file) {
              if (file === "/proc/20/exe") return worker;
              const error = new Error("unreadable");
              error.code = "EACCES";
              throw error;
            },
          }),
        ),
      /credential ancestry (?:escaped before trusted boundary|found an untrusted Runner\.Worker|is unreadable)/u,
      label,
    );
  }
});

test("hosted Linux ancestry rejects GitHub and provider write credentials", () => {
  for (const [pid, credential] of [
    [40, "GITHUB_TOKEN"],
    [30, "GH_TOKEN"],
    [30, "ACTIONS_RUNTIME_TOKEN"],
    [20, "OPENAI_API_KEY"],
    [20, "AWS_SECRET_ACCESS_KEY"],
  ]) {
    const files = hostedAncestryFiles({
      [`/proc/${pid}/environ`]: `${credential}=sentinel\0`,
    });
    const result = inspectCredentiallessProcessAncestry(ancestryOptions(files));
    assert.equal(result.ok, false, credential);
    assert.deepEqual(result.exposed, [{ pid, names: [credential] }]);
  }
});

test("hosted Linux ancestry fails closed on unreadable in-bound processes", () => {
  for (const file of ["/proc/30/environ", "/proc/30/cmdline"]) {
    const files = hostedAncestryFiles();
    files.delete(file);
    assert.throws(
      () => inspectCredentiallessProcessAncestry(ancestryOptions(files)),
      new RegExp(`credential ancestry is unreadable at ${file}.*EACCES`, "u"),
      file,
    );
  }
});

test("escaped descendants cannot substitute PID 1 for the hosted runner boundary", () => {
  const files = hostedAncestryFiles({
    "/proc/40/status": "Name:\tnode\nPPid:\t1\n",
  });
  const reads = [];
  const options = ancestryOptions(files);
  const readFileSync = options.readFileSync;
  options.readFileSync = (file) => {
    reads.push(file);
    return readFileSync(file);
  };
  assert.throws(
    () => inspectCredentiallessProcessAncestry(options),
    /escaped before trusted boundary/u,
  );
  assert.equal(
    reads.some((file) => file.startsWith("/proc/1/")),
    false,
  );
});

test("a weaker command is rejected against the pre-spawn authorized root", async () => {
  let heartbeats = 0;
  let spawned = false;
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "node --test tests/unit-only.test.mjs",
      executionBinding: {
        ...executionBinding(),
        nativeCommandRoot: COMMAND_ROOT,
      },
      heartbeat: async () => {
        heartbeats += 1;
      },
      spawnImpl: () => {
        spawned = true;
        return childThatCompletes();
      },
    }),
    /does not match the authorized command root/u,
  );
  assert.equal(heartbeats, 0);
  assert.equal(spawned, false);
});

test("heartbeat failure terminates native work and fails closed", async () => {
  let spawned = false;
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      executionBinding: executionBinding(),
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

test("invalid environment binding fails before heartbeat or native spawn", async () => {
  let heartbeats = 0;
  let spawned = false;
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      executionBinding: { ...executionBinding(), environmentRoot: "" },
      heartbeat: async () => {
        heartbeats += 1;
      },
      spawnImpl: () => {
        spawned = true;
        return childThatCompletes();
      },
    }),
    /environmentRoot must be a sha256 content root/u,
  );
  assert.equal(heartbeats, 0);
  assert.equal(spawned, false);
});

test("fencing loss during native work terminates the worker before returning failure", async () => {
  let heartbeats = 0;
  const signals = [];
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      executionBinding: executionBinding(),
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

test("a failed final heartbeat cannot seal native success", async () => {
  let heartbeats = 0;
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      executionBinding: executionBinding(),
      intervalMs: 1_000,
      heartbeat: async () => {
        heartbeats += 1;
        if (heartbeats === 2) throw new Error("final fence readback failed");
      },
      spawnImpl: () => childThatCompletes(5),
    }),
    /native heartbeat failed: final fence readback failed/u,
  );
  assert.equal(heartbeats, 2);
});

test("unproven worker termination carries an explicit fail-closed marker", async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  let heartbeats = 0;
  await assert.rejects(
    runNativeWithHeartbeat({
      command: "native-shards",
      executionBinding: executionBinding(),
      intervalMs: 2,
      terminationGraceMs: 2,
      terminationKillMs: 2,
      heartbeat: async () => {
        heartbeats += 1;
        if (heartbeats > 1) throw new Error("fence lost");
      },
      spawnImpl: () => child,
    }),
    (error) =>
      error.code === "native-worker-termination-unproven" &&
      error.workerTerminationProven === false,
  );
});

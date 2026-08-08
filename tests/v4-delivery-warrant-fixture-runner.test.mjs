import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import {
  V4_DELIVERY_WARRANT_PROJECTION_CONTRACT,
  runV4DeliveryWarrantTraceFixture,
} from "../packages/core/v4-delivery-warrant-fixture-runner.js";
import {
  V4_DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT,
  runV4DeliveryWarrantShadow,
} from "../packages/core/v4-delivery-warrant-shadow-adapter.js";

const root = new URL("..", import.meta.url).pathname;
const fixtureRoot = new URL(
  "../contracts/fixtures/v4-delivery-warrant-trace-v1/",
  import.meta.url,
);

function readFixture(name) {
  return fs.readFileSync(new URL(name, fixtureRoot));
}

function rustRunner(bytes) {
  return spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "trace",
      "-",
    ],
    { cwd: root, input: bytes, encoding: "utf8" },
  );
}

const sources = Object.freeze({
  typescriptRevision: "a".repeat(40),
  rustRevision: "b".repeat(40),
  validatorVersion: "fixture-runner-v1",
});

function hostResponse(request, structuredResult, overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-host-response",
    protocolVersion: "1.0",
    requestId: request.requestId,
    status: "ok",
    host: {
      kind: "rust-subprocess",
      implementation: "fixture",
      capabilities: [
        "canonical-input-v1",
        "delivery-warrant-trace-projection-v1",
        "diagnostics-v1",
        "effects-disabled-v1",
        "structured-result-v1",
      ],
    },
    command: request.command,
    output: {
      stdout: { encoding: "base64", bytes: "" },
      stderr: { encoding: "base64", bytes: "" },
    },
    structuredResult,
    diagnostics: [],
    exit: { code: 0, signal: null },
    ...overrides,
  };
}

test("JavaScript and Rust adapters emit one semantic projection for retained traces", () => {
  for (const name of ["golden.json", "replay.json"]) {
    const bytes = readFixture(name);
    const javascript = runV4DeliveryWarrantTraceFixture(bytes);
    const rust = rustRunner(bytes);
    assert.equal(rust.status, 0, rust.stderr || rust.stdout);
    assert.deepEqual(JSON.parse(rust.stdout), javascript, name);
    assert.equal(
      javascript.projection.schema,
      V4_DELIVERY_WARRANT_PROJECTION_CONTRACT,
      name,
    );
    assert.match(javascript.projectionRoot, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(
      javascript.projection.steps.every(
        (step) =>
          step.successorCanonicalUtf8.endsWith("\n") &&
          step.receiptCanonicalUtf8.endsWith("\n"),
      ),
      name,
    );
  }
});

test("semantic projection retains faults, ordered effects, observations, and receipts", () => {
  const golden = runV4DeliveryWarrantTraceFixture(readFixture("golden.json"));
  assert.deepEqual(
    golden.projection.steps.map((step) => ({
      action: step.decision.action,
      generation: step.generation,
      fencingCounter: step.fencingCounter,
      effects: step.effects.map((effect) => effect.type),
    })),
    [
      {
        action: "candidate-submitted",
        generation: 1,
        fencingCounter: 0,
        effects: ["persist-successor"],
      },
      {
        action: "warrant-selected",
        generation: 2,
        fencingCounter: 1,
        effects: ["persist-successor", "request-admission"],
      },
    ],
  );
  const replay = runV4DeliveryWarrantTraceFixture(readFixture("replay.json"));
  assert.equal(
    replay.projection.steps[0].decision.fault.code,
    "stale-fencing-token",
  );
  assert.deepEqual(replay.projection.steps[0].effects, []);
  assert.equal(replay.projection.steps[0].observations[0].type, "fence-check");
  assert.match(
    replay.projection.steps[0].receiptRoot,
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("both adapters fail closed on malformed, incomplete, reordered, stale-root, and unsupported traces", () => {
  const golden = JSON.parse(readFixture("golden.json").toString("utf8"));
  const cases = [
    ["invalid-trace-json", Buffer.from("{not-json}\n")],
    [
      "invalid-trace-bytes",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        readFixture("golden.json"),
      ]),
    ],
    ["invalid-trace-bytes", readFixture("golden.json").subarray(0, -1)],
    [
      "invalid-trace-shape",
      Buffer.from(
        `${JSON.stringify({ schemaVersion: 1, contract: golden.contract })}\n`,
      ),
    ],
    [
      "reordered-trace",
      Buffer.from(
        `${JSON.stringify({
          ...structuredClone(golden),
          trace: {
            ...structuredClone(golden.trace),
            steps: [...structuredClone(golden.trace.steps)].reverse(),
          },
        })}\n`,
      ),
    ],
    [
      "stale-projection-root",
      Buffer.from(
        `${JSON.stringify({
          ...structuredClone(golden),
          expectedProjectionRoot: `sha256:${"f".repeat(64)}`,
        })}\n`,
      ),
    ],
    [
      "unsupported-trace-version",
      Buffer.from(
        `${JSON.stringify({ ...structuredClone(golden), schemaVersion: 2 })}\n`,
      ),
    ],
  ];
  for (const [code, bytes] of cases) {
    assert.throws(
      () => runV4DeliveryWarrantTraceFixture(bytes),
      (error) => error.code === code,
      code,
    );
    const rust = rustRunner(bytes);
    assert.notEqual(rust.status, 0, code);
    assert.match(rust.stderr, new RegExp(code, "u"), code);
  }
});

test("the trace schema and pure runners remain closed and provider-free", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-delivery-warrant-trace-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.trace.additionalProperties, false);
  assert.equal(schema.$defs.step.additionalProperties, false);
  assert.equal(schema.$defs.decision.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(
    schema.properties.runner.const,
    "buildchain-v4-delivery-warrant-fixture-runner/v1",
  );

  const javascript = fs.readFileSync(
    new URL(
      "../packages/core/v4-delivery-warrant-fixture-runner.js",
      import.meta.url,
    ),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL("../crates/buildchain-v4-contracts/src/trace.rs", import.meta.url),
    "utf8",
  );
  for (const forbidden of [
    "Date.now(",
    "new Date()",
    "node:fs",
    "node:https",
    "Octokit",
  ])
    assert.equal(javascript.includes(forbidden), false, forbidden);
  for (const forbidden of [
    "std::fs",
    "std::net",
    "SystemTime",
    "reqwest",
    "octocrab",
  ])
    assert.equal(rust.includes(forbidden), false, forbidden);
});

test("TypeScript shadow passes identical bytes to legacy and Rust while retaining no second authority", async () => {
  const bytes = readFixture("golden.json");
  const seen = [];
  const retained = [];
  const result = await runV4DeliveryWarrantShadow(bytes, {
    enabled: true,
    requestId: "paired-fixture",
    recordedAt: "2026-08-08T00:00:00.000Z",
    sources,
    invokeLegacy(input) {
      seen.push(Buffer.from(input));
      return runV4DeliveryWarrantTraceFixture(input);
    },
    invokeRust(request) {
      const input = Buffer.from(request.input.bytes, "base64");
      seen.push(input);
      return hostResponse(request, runV4DeliveryWarrantTraceFixture(input));
    },
    retain(observation) {
      retained.push(observation);
    },
  });
  assert.deepEqual(seen, [bytes, bytes]);
  assert.equal(result.shadow.status, "observed");
  assert.equal(result.shadow.authority, "typescript-v3");
  assert.equal(result.shadow.rustAuthority, "none");
  assert.equal(result.shadow.rustEffects, "disabled");
  assert.equal(result.shadow.retention.status, "retained");
  assert.equal(
    retained[0].schema,
    V4_DELIVERY_WARRANT_SHADOW_OBSERVATION_CONTRACT,
  );
  assert.equal(retained[0].retention.classification, "public-safe-fixture");
  assert.equal(retained[0].retainUntil, "2026-11-06T00:00:00.000Z");
  assert.equal(
    retained[0].legacy.projection.projectionRoot,
    retained[0].rust.projection.projectionRoot,
  );
  assert.equal("verdict" in retained[0], false);
});

test("the default Rust shadow host emits an effect-disabled projection", async () => {
  const result = await runV4DeliveryWarrantShadow(readFixture("replay.json"), {
    enabled: true,
    recordedAt: "2026-08-08T00:00:00.000Z",
    sources,
  });
  assert.equal(result.shadow.status, "observed");
  assert.equal(result.shadow.diagnostics.length, 0);
  assert.equal(
    result.authoritativeResult.projectionRoot,
    result.shadow.observation.rust.projection.projectionRoot,
  );
});

test("disabled, unsafe, and invalid shadow configuration never changes the legacy result", async () => {
  const bytes = Buffer.from("public-safe-authoritative-result\n");
  const authoritative = { writer: "typescript-v3", committed: true };
  let rustCalls = 0;
  const invokeLegacy = () => authoritative;
  const invokeRust = () => {
    rustCalls += 1;
    throw new Error("must not run");
  };
  for (const options of [
    { enabled: false, sources },
    {
      enabled: true,
      sources,
      retention: { kind: "captured-replay", publicSafe: false },
    },
    { enabled: true, sources: { ...sources, rustRevision: "floating" } },
  ]) {
    const result = await runV4DeliveryWarrantShadow(bytes, {
      ...options,
      invokeLegacy,
      invokeRust,
    });
    assert.strictEqual(result.authoritativeResult, authoritative);
    assert.equal(result.shadow.status, "skipped");
  }
  assert.equal(rustCalls, 0);
  const unsafe = await runV4DeliveryWarrantShadow(
    Buffer.from("private-token-value"),
    {
      enabled: true,
      sources,
      retention: { kind: "captured-replay", publicSafe: false },
      invokeLegacy,
    },
  );
  assert.doesNotMatch(JSON.stringify(unsafe.shadow), /private-token-value/u);
});

test("timeout, crash, cancellation, malformed response, unsupported host, and retention failure are bounded observations", async () => {
  const bytes = readFixture("golden.json");
  const cases = [
    {
      code: "host-timeout",
      host: {
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
      },
      timeoutMs: 25,
    },
    {
      code: "host-crashed",
      host: { command: process.execPath, arguments: ["-e", "process.exit(7)"] },
    },
    {
      code: "host-response-invalid",
      host: {
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('not-json')"],
      },
    },
  ];
  for (const entry of cases) {
    const result = await runV4DeliveryWarrantShadow(bytes, {
      enabled: true,
      recordedAt: "2026-08-08T00:00:00.000Z",
      sources,
      host: entry.host,
      timeoutMs: entry.timeoutMs || 1_000,
    });
    assert.equal(result.shadow.status, "unavailable", entry.code);
    assert.equal(result.shadow.diagnostics[0].code, entry.code);
    assert.match(result.authoritativeResult.projectionRoot, /^sha256:/u);
  }

  const unsupported = await runV4DeliveryWarrantShadow(bytes, {
    enabled: true,
    recordedAt: "2026-08-08T00:00:00.000Z",
    sources,
    invokeRust(request) {
      return hostResponse(request, null, {
        status: "unsupported",
        host: {
          kind: "rust-subprocess",
          implementation: "old",
          capabilities: [],
        },
        exit: { code: 64, signal: null },
      });
    },
  });
  assert.equal(
    unsupported.shadow.diagnostics[0].code,
    "unsupported-capability",
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 25);
  const cancelled = await runV4DeliveryWarrantShadow(bytes, {
    enabled: true,
    recordedAt: "2026-08-08T00:00:00.000Z",
    sources,
    signal: controller.signal,
    timeoutMs: 1_000,
    host: {
      command: process.execPath,
      arguments: ["-e", "setInterval(() => {}, 1000)"],
    },
  });
  assert.equal(cancelled.shadow.status, "cancelled");
  assert.equal(cancelled.shadow.diagnostics[0].code, "host-cancelled");

  const retentionFailure = await runV4DeliveryWarrantShadow(bytes, {
    enabled: true,
    recordedAt: "2026-08-08T00:00:00.000Z",
    sources,
    invokeRust(request) {
      return hostResponse(request, runV4DeliveryWarrantTraceFixture(bytes));
    },
    retain() {
      throw new Error("private sink detail must not escape");
    },
  });
  assert.equal(retentionFailure.shadow.retention.status, "failed");
  assert.equal(
    retentionFailure.shadow.diagnostics.at(-1).code,
    "retention-failed",
  );
  assert.doesNotMatch(
    JSON.stringify(retentionFailure.shadow),
    /private sink detail/u,
  );
});

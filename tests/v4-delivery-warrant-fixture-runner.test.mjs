import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import {
  V4_DELIVERY_WARRANT_PROJECTION_CONTRACT,
  runV4DeliveryWarrantTraceFixture,
} from "../packages/core/v4-delivery-warrant-fixture-runner.js";

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

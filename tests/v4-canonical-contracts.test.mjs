import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import {
  V4ContractFault,
  v4CanonicalBytes,
  v4ContentRoot,
  validateV4Clock,
  validateV4EventEnvelope,
  validateV4ReceiptEnvelope,
} from "../packages/core/v4-canonical-contracts.js";

const root = new URL("..", import.meta.url).pathname;
const fixturePath = new URL(
  "../architecture/v4-canonical-contract-fixtures.json",
  import.meta.url,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const sha = (digit) => `sha256:${digit.repeat(64)}`;

test("JavaScript freezes canonical bytes, domain-separated roots, and explicit clocks", () => {
  for (const fixture of fixtures.validCases) {
    assert.equal(
      v4CanonicalBytes(fixture.value).toString("utf8"),
      fixture.expectedCanonicalUtf8,
      fixture.id,
    );
    assert.equal(
      v4ContentRoot(fixture.domain, fixture.value),
      fixture.expectedRoot,
      fixture.id,
    );
    assert.equal(validateV4Clock(fixture.clock), fixture.clock, fixture.id);
  }
});

test("JavaScript rejects unsupported numbers, keys, clocks, and root domains", () => {
  const invalid = new Map(
    fixtures.invalidCases.map((entry) => [entry.id, entry]),
  );
  const cases = [
    ["fractional-number", () => v4CanonicalBytes(1.5)],
    ["unsafe-integer", () => v4CanonicalBytes(9_007_199_254_740_992)],
    ["non-ascii-key", () => v4CanonicalBytes({ 键: 1 })],
    [
      "bad-clock-offset",
      () => validateV4Clock("2026-08-07T23:00:00.000+08:00"),
    ],
    ["bad-clock-date", () => validateV4Clock("2026-02-30T00:00:00.000Z")],
    ["bad-clock-year-zero", () => validateV4Clock("0000-01-01T00:00:00.000Z")],
    ["unknown-domain", () => v4ContentRoot("provider-state", {})],
  ];
  for (const [id, operation] of cases) {
    assert.throws(
      operation,
      (error) =>
        error instanceof V4ContractFault &&
        error.code === invalid.get(id).fault,
      id,
    );
  }
  assert.throws(
    () => v4CanonicalBytes("\ud800"),
    (error) =>
      error instanceof V4ContractFault && error.code === "unsupported-string",
  );
  assert.throws(() => v4CanonicalBytes(Array(1)), V4ContractFault);
  assert.equal(
    v4CanonicalBytes(JSON.parse('{"__proto__":1}')).toString("utf8"),
    '{"__proto__":1}\n',
  );
});

test("closed event, receipt, and typed-fault envelopes reject shape drift", () => {
  const event = {
    schema: "buildchain-v4-event-envelope/v1",
    eventId: sha("1"),
    eventType: "candidate-submitted",
    occurredAt: "2026-08-07T15:00:00.000Z",
    subjectRoot: sha("2"),
    payload: { candidateId: "candidate-1", generation: 1 },
  };
  const receipt = {
    schema: "buildchain-v4-receipt-envelope/v1",
    receiptType: "candidate-submitted",
    recordedAt: "2026-08-07T15:00:00.000Z",
    eventRoot: sha("3"),
    priorStateRoot: sha("4"),
    nextStateRoot: sha("5"),
    outcome: "accepted",
    fault: null,
  };
  assert.equal(validateV4EventEnvelope(event), event);
  assert.equal(validateV4ReceiptEnvelope(receipt), receipt);
  assert.throws(
    () => validateV4EventEnvelope({ ...event, sampledNow: event.occurredAt }),
    (error) => error.code === "invalid-envelope-shape",
  );
  assert.throws(
    () =>
      validateV4ReceiptEnvelope({
        ...receipt,
        outcome: "rejected",
        fault: null,
      }),
    (error) => error.code === "invalid-receipt",
  );
});

test("the checked-in schema suite is closed and freezes every v1 byte rule", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-canonical-contracts-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.canonicalization.additionalProperties, false);
  assert.equal(
    schema.properties.canonicalization.properties.keyPattern.const,
    "^[ -~]+$",
  );
  assert.equal(
    schema.properties.canonicalization.properties.terminator.const,
    "LF",
  );
  assert.equal(
    schema.properties.canonicalization.properties.minimumInteger.const,
    -9_007_199_254_740_991,
  );
  assert.equal(
    schema.properties.canonicalization.properties.maximumInteger.const,
    9_007_199_254_740_991,
  );
  assert.equal(
    schema.$defs.root.properties.domainSeparator.const,
    "domain + NUL + canonical-bytes",
  );
  for (const name of ["event", "receipt", "fault"])
    assert.equal(schema.$defs[name].additionalProperties, false, name);
});

test("Rust and JavaScript produce byte-identical fixture projections", () => {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "architecture/v4-canonical-contract-fixtures.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rust = JSON.parse(result.stdout);
  assert.deepEqual(
    rust.validCases,
    fixtures.validCases.map((fixture) => ({
      id: fixture.id,
      canonicalUtf8: fixture.expectedCanonicalUtf8,
      root: fixture.expectedRoot,
      clockValid: true,
    })),
  );
  assert.deepEqual(
    rust.invalidCases,
    fixtures.invalidCases.map(({ id, fault }) => ({ id, fault })),
  );
});

test("contract libraries contain no ambient clock or provider effects", () => {
  const javascript = fs.readFileSync(
    new URL("../packages/core/v4-canonical-contracts.js", import.meta.url),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL("../crates/buildchain-v4-contracts/src/lib.rs", import.meta.url),
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

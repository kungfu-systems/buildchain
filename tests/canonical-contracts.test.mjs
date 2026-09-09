import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ContractFault,
  domainCanonicalBytes,
  domainContentRoot,
  validateClock,
  validateEventEnvelope,
  validateReceiptEnvelope,
} from "../packages/core/contracts/canonical-contracts.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = new URL(
  "../architecture/canonical-contract-fixtures.json",
  import.meta.url,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const sha = (digit) => `sha256:${digit.repeat(64)}`;

test("JavaScript freezes canonical bytes, domain-separated roots, and explicit clocks", () => {
  for (const fixture of fixtures.validCases) {
    assert.equal(
      domainCanonicalBytes(fixture.value).toString("utf8"),
      fixture.expectedCanonicalUtf8,
      fixture.id,
    );
    assert.equal(
      domainContentRoot(fixture.domain, fixture.value),
      fixture.expectedRoot,
      fixture.id,
    );
    assert.equal(validateClock(fixture.clock), fixture.clock, fixture.id);
  }
});

test("JavaScript rejects unsupported numbers, keys, clocks, and root domains", () => {
  const invalid = new Map(
    fixtures.invalidCases.map((entry) => [entry.id, entry]),
  );
  const cases = [
    ["fractional-number", () => domainCanonicalBytes(1.5)],
    ["unsafe-integer", () => domainCanonicalBytes(9_007_199_254_740_992)],
    ["non-ascii-key", () => domainCanonicalBytes({ 键: 1 })],
    ["bad-clock-offset", () => validateClock("2026-08-07T23:00:00.000+08:00")],
    ["bad-clock-date", () => validateClock("2026-02-30T00:00:00.000Z")],
    ["bad-clock-year-zero", () => validateClock("0000-01-01T00:00:00.000Z")],
    ["unknown-domain", () => domainContentRoot("provider-state", {})],
  ];
  for (const [id, operation] of cases) {
    assert.throws(
      operation,
      (error) =>
        error instanceof ContractFault && error.code === invalid.get(id).fault,
      id,
    );
  }
  assert.throws(
    () => domainCanonicalBytes("\ud800"),
    (error) =>
      error instanceof ContractFault && error.code === "unsupported-string",
  );
  assert.throws(() => domainCanonicalBytes(Array(1)), ContractFault);
  assert.equal(
    domainCanonicalBytes(JSON.parse('{"__proto__":1}')).toString("utf8"),
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
  assert.equal(validateEventEnvelope(event), event);
  assert.equal(validateReceiptEnvelope(receipt), receipt);
  assert.throws(
    () => validateEventEnvelope({ ...event, sampledNow: event.occurredAt }),
    (error) => error.code === "invalid-envelope-shape",
  );
  assert.throws(
    () =>
      validateReceiptEnvelope({
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
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-domain-contracts/Cargo.toml",
      "--",
      "architecture/canonical-contract-fixtures.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack || result.stderr || result.stdout,
  );
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
    new URL(
      "../packages/core/contracts/canonical-contracts.js",
      import.meta.url,
    ),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL(
      "../crates/buildchain-domain-contracts/src/lib.rs",
      import.meta.url,
    ),
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

test("Rust Delivery Warrant domain freezes the protected manifest surface", () => {
  const plan = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/delivery-warrant-shadow-bootstrap-plan.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/capability-state-machine-manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const domain = ["warrant.rs", "warrant/decision.rs", "warrant/transition.rs"]
    .map((file) =>
      fs.readFileSync(
        new URL(
          `../crates/buildchain-domain-contracts/src/${file}`,
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .join("\n");
  const warrant = manifest.stateMachines.find(
    (machine) => machine.id === "dev-delivery-warrant",
  );
  assert.equal(warrant.states.length, 9);
  assert.equal(warrant.events.length, 7);
  assert.equal(plan.primitives.length, 9);
  assert.equal(plan.legacyDisagreements.length, 7);
  for (const value of [
    ...warrant.states,
    ...warrant.events,
    ...plan.primitives.map(({ id }) => id),
    ...plan.legacyDisagreements.map(({ id }) => id),
  ])
    assert.equal(domain.includes(`"${value}"`), true, value);
  assert.deepEqual(warrant.writer, {
    runtime: "typescript-v4",
    authoritative: true,
    secondWriterBudget: 0,
  });
  assert.equal(warrant.migrationPhase, "legacy-retired");
});

test("Rust pure domain cannot hide a provider, writer, ambient clock, or unbounded retry", () => {
  const domain = ["warrant.rs", "warrant/decision.rs", "warrant/transition.rs"]
    .map((file) =>
      fs.readFileSync(
        new URL(
          `../crates/buildchain-domain-contracts/src/${file}`,
          import.meta.url,
        ),
        "utf8",
      ),
    )
    .join("\n");
  for (const forbidden of [
    "std::fs",
    "std::net",
    "std::process",
    "std::env",
    "SystemTime",
    "Instant::now",
    "thread::sleep",
    "reqwest",
    "octocrab",
    "git2",
    "File::create",
    "OpenOptions",
    "loop {",
    "while true",
  ])
    assert.equal(domain.includes(forbidden), false, forbidden);
  assert.match(
    domain,
    /maximum_conflict_retries > 1[\s\S]+unbounded-retry-policy/u,
  );
  assert.match(domain, /effect_type: "persist-successor"/u);
  assert.match(domain, /effect_type: "request-admission"/u);
});

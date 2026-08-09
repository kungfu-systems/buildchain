import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import {
  evaluateV4StageCapsuleReuse,
  v4StageCapsuleAvailabilityRoot,
  v4StageCapsuleIdentityRoot,
  v4StageCapsuleRoot,
  validateV4StageCapsule,
  validateV4StageCapsuleAvailability,
  validateV4StageCapsuleIdentity,
} from "../packages/core/v4-stage-capsule.js";

const root = new URL("..", import.meta.url).pathname;
const fixturePath = new URL(
  "../contracts/fixtures/v4-stage-capsule-v1/shared.json",
  import.meta.url,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const clone = (value) => structuredClone(value);

function requestFor(entry, overrides = {}) {
  return {
    schema: "buildchain-v4-stage-capsule-reuse/v1",
    capsule: clone(entry.capsule),
    availability: clone(entry.availability),
    ...clone(entry.reuse),
    ...overrides,
  };
}

test("Stage Capsule freezes byte-identical identity, capsule, and availability roots", () => {
  const entry = fixtures.validCases[0];
  assert.equal(
    v4StageCapsuleIdentityRoot(entry.capsule.identity),
    entry.capsule.identityRoot,
  );
  assert.equal(v4StageCapsuleRoot(entry.capsule), entry.capsule.capsuleRoot);
  assert.equal(validateV4StageCapsule(entry.capsule), entry.capsule);
  const availabilityRoot = v4StageCapsuleAvailabilityRoot(entry.availability);
  assert.equal(
    availabilityRoot,
    "sha256:a9656d2944a4f98b474b0fecc339f6116d6b7f966cf3186dca906ea9e64168bd",
  );
  assert.deepEqual(evaluateV4StageCapsuleReuse(requestFor(entry)), {
    schema: "buildchain-v4-stage-capsule-reuse/v1",
    eligible: true,
    capsuleRoot: entry.capsule.capsuleRoot,
    availabilityRoot,
    reason: "eligible",
  });
});

test("semantic identity invalidates exactly on platform, stage, policy, transformation, and inputs", () => {
  const entry = fixtures.validCases[0];
  const original = v4StageCapsuleIdentityRoot(entry.capsule.identity);
  const mutations = [
    ["platform", (value) => (value.platform = "darwin-arm64")],
    ["stage", (value) => (value.stage = "package")],
    [
      "policy",
      (value) =>
        (value.policyRoot =
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"),
    ],
    [
      "transformation",
      (value) =>
        (value.transformationRoot =
          "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
    ],
    [
      "input",
      (value) =>
        (value.declaredInputs[0].root =
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
    ],
  ];
  const roots = new Set([original]);
  for (const [name, mutate] of mutations) {
    const identity = clone(entry.capsule.identity);
    mutate(identity);
    const changed = v4StageCapsuleIdentityRoot(identity);
    assert.notEqual(changed, original, name);
    roots.add(changed);
  }
  assert.equal(roots.size, mutations.length + 1);

  const transportObservation = clone(entry.availability);
  transportObservation.observedAt = "2026-08-10T00:00:00.000Z";
  transportObservation.transports[0].root =
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  assert.notEqual(
    v4StageCapsuleAvailabilityRoot(transportObservation),
    v4StageCapsuleAvailabilityRoot(entry.availability),
  );
  assert.equal(
    v4StageCapsuleIdentityRoot(entry.capsule.identity),
    original,
    "transport and current availability do not participate in identity",
  );
});

test("reuse fails closed for missing, expired, corrupt, and root-mismatched content", () => {
  const entry = fixtures.validCases[0];
  const unavailable = (status) => {
    const availability = clone(entry.availability);
    availability.status = status;
    availability.contentRoot = null;
    availability.qualificationRoot = null;
    availability.faultCode = `capsule-${status}`;
    return evaluateV4StageCapsuleReuse(requestFor(entry, { availability }));
  };
  for (const status of [
    "missing",
    "partial",
    "corrupt",
    "quarantined",
    "root-mismatch",
  ])
    assert.deepEqual(
      [unavailable(status).eligible, unavailable(status).reason],
      [false, status],
    );
  const expired = evaluateV4StageCapsuleReuse(
    requestFor(entry, { evaluatedAt: "2026-11-08T00:00:00.000Z" }),
  );
  assert.deepEqual([expired.eligible, expired.reason], [false, "expired"]);

  const mismatched = evaluateV4StageCapsuleReuse(
    requestFor(entry, {
      expectedOutputManifestRoot:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    }),
  );
  assert.deepEqual(
    [mismatched.eligible, mismatched.reason],
    [false, "root-mismatch"],
  );
});

test("closed contracts exclude provider ids, artifact ids, paths, credentials, and ambient time", () => {
  const entry = fixtures.validCases[0];
  const cases = [
    () =>
      validateV4StageCapsuleIdentity({
        ...entry.capsule.identity,
        providerRunId: "run-42",
      }),
    () =>
      validateV4StageCapsule({ ...entry.capsule, artifactId: "artifact-7" }),
    () =>
      validateV4StageCapsuleAvailability({
        ...entry.availability,
        runnerPath: "/runner/work",
      }),
    () =>
      evaluateV4StageCapsuleReuse({
        ...requestFor(entry),
        ambientNow: "2026-08-09T00:00:00.000Z",
      }),
    () =>
      validateV4StageCapsuleIdentity({
        ...entry.capsule.identity,
        credential: "secret",
      }),
  ];
  for (const operation of cases)
    assert.throws(
      operation,
      (error) =>
        error instanceof V4ContractFault &&
        error.code === "invalid-stage-capsule-shape",
    );
});

test("Rust and JavaScript accept the shared roots and reject typed invalid fixtures", () => {
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "stage-capsule",
      "contracts/fixtures/v4-stage-capsule-v1/shared.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rust = JSON.parse(result.stdout);
  const entry = fixtures.validCases[0];
  assert.deepEqual(rust.validCases, [
    {
      id: entry.id,
      identityRoot: entry.capsule.identityRoot,
      capsuleRoot: entry.capsule.capsuleRoot,
      availabilityRoot: v4StageCapsuleAvailabilityRoot(entry.availability),
      reuse: evaluateV4StageCapsuleReuse(requestFor(entry)),
    },
  ]);
  assert.deepEqual(rust.invalidCases, [
    {
      id: "provider-run-id-is-not-identity",
      fault: "invalid-stage-capsule-shape",
    },
    {
      id: "missing-requires-fault",
      fault: "invalid-stage-capsule-availability",
    },
    {
      id: "reuse-shape-is-closed",
      fault: "invalid-stage-capsule-shape",
    },
  ]);
});

test("architecture manifest budgets one schema, one writer, and zero provider or v3 authority drift", () => {
  const contract = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-stage-capsule-contract.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    contract.schemaAuthority,
    "contracts/v4-stage-capsule-v1.schema.json",
  );
  assert.deepEqual(contract.authority, {
    writer: "typescript-v3",
    writerCount: 1,
    rust: "validation-only",
    productionWriteChange: false,
  });
  assert.deepEqual(contract.budgets, {
    schemaAuthorities: 1,
    writers: 1,
    secondWriters: 0,
    providerSdkImportsInContracts: 0,
    providerSdkImportsInRustDomain: 0,
    productionWriteAuthorityChanges: 0,
    v3ConsumerBehaviorChanges: 0,
  });
  for (const excluded of [
    "providerRunId",
    "providerArtifactId",
    "runnerPath",
    "credential",
    "ambientClock",
    "networkObservation",
    "transportLocation",
    "currentAvailability",
  ])
    assert.equal(contract.identityExcludes.includes(excluded), true, excluded);
});

test("Stage Capsule implementations contain no provider, filesystem, network, or ambient-clock authority", () => {
  const javascript = fs.readFileSync(
    new URL("../packages/core/v4-stage-capsule.js", import.meta.url),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL(
      "../crates/buildchain-v4-contracts/src/stage_capsule.rs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    "Date.now(",
    "new Date(",
    "node:fs",
    "node:https",
    "Octokit",
    "process.env",
  ])
    assert.equal(javascript.includes(forbidden), false, forbidden);
  for (const forbidden of [
    "std::fs",
    "std::net",
    "std::process",
    "std::env",
    "SystemTime",
    "Instant::now",
    "reqwest",
    "octocrab",
    "git2",
  ])
    assert.equal(rust.includes(forbidden), false, forbidden);
});

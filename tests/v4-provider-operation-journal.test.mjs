import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import {
  foldV4ProviderOperationJournal,
  projectV4ProviderOperationFixtures,
  v4ProviderOperationJournalRoot,
  v4ProviderOperationJournalStateRoot,
  validateV4ProviderOperationIdentity,
} from "../packages/core/v4-provider-operation-journal.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = new URL(
  "../contracts/fixtures/v4-provider-operation-journal-v1/shared.json",
  import.meta.url,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("provider operation retries preserve logical identity and append distinct attempts", () => {
  const entries = fixtures.validCases[0].entries;
  const attempts = entries.filter((entry) => entry.kind === "attempt");
  assert.equal(new Set(entries.map((entry) => entry.operationRoot)).size, 1);
  assert.deepEqual(
    attempts.map((entry) => entry.attemptOrdinal),
    [1, 2],
  );
  assert.notEqual(attempts[0].entryRoot, attempts[1].entryRoot);
  const state = foldV4ProviderOperationJournal(entries);
  assert.deepEqual(
    [state.phase, state.entryCount, state.attemptCount],
    ["confirmed", 7, 2],
  );
  assert.equal(
    v4ProviderOperationJournalRoot(entries),
    "sha256:0dc6c3b2f43d98c6f191876391a732dd7ba9583e7a78c03aa196f76606cb4cdc",
  );
  assert.equal(
    v4ProviderOperationJournalStateRoot(entries),
    "sha256:270293ad0bf6a75dcd7c82ae933053e43e07dbc680e0b88a21978251709dbc20",
  );
});

test("Rust and TypeScript produce byte-equivalent roots and typed failures", () => {
  const typescript = projectV4ProviderOperationFixtures(fixtures);
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "provider-operation-journal",
      "contracts/fixtures/v4-provider-operation-journal-v1/shared.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack || result.stderr || result.stdout,
  );
  assert.deepEqual(JSON.parse(result.stdout), typescript);
  assert.deepEqual(
    typescript.invalidCases,
    [
      [
        "attempt-before-reconciliation",
        "impossible-provider-operation-transition",
      ],
      [
        "confirmation-without-rooted-observation",
        "confirmation-without-rooted-observation",
      ],
      [
        "conflicting-confirmations",
        "conflicting-provider-operation-confirmation",
      ],
      ["authority-escalation", "provider-operation-authority-escalation"],
      ["retry-operation-identity-drift", "provider-operation-identity-drift"],
      ["provider-run-id-is-not-identity", "invalid-provider-operation-shape"],
      ["unsafe-sequence-is-rejected", "invalid-provider-operation-counter"],
    ].map(([id, fault]) => ({ id, fault })),
  );
});

test("the sole schema authority is closed over all five journal record kinds", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-provider-operation-journal-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    schema.$defs.entry.oneOf.map((entry) => entry.$ref),
    ["intent", "attempt", "observation", "confirmation", "reconciliation"].map(
      (kind) => `#/$defs/${kind}`,
    ),
  );
  for (const kind of [
    "intent",
    "attempt",
    "observation",
    "confirmation",
    "reconciliation",
  ])
    assert.equal(schema.$defs[kind].allOf[1].additionalProperties, false, kind);
});

test("closed identity excludes provider, credential, response, clock, and runner-local data", () => {
  const identity = fixtures.validCases[0].entries[0].operation;
  for (const field of [
    "providerRunId",
    "providerRequestId",
    "providerResourceId",
    "credential",
    "signedUrl",
    "ambientClock",
    "networkResponseBody",
    "runnerPath",
    "transportLocalId",
  ])
    assert.throws(
      () =>
        validateV4ProviderOperationIdentity({
          ...identity,
          [field]: "forbidden",
        }),
      (error) =>
        error instanceof V4ContractFault &&
        error.code === "invalid-provider-operation-shape",
      field,
    );
});

test("architecture freezes one schema authority, one fold writer, and shadow-only effects", () => {
  const contract = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-provider-operation-journal-contract.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    contract.schemaAuthority,
    "contracts/v4-provider-operation-journal-v1.schema.json",
  );
  assert.equal(contract.mode, "shadow-fixture-only");
  assert.deepEqual(contract.authority, {
    productionWriter: "typescript-v3",
    productionWriterCount: 1,
    stateFoldAuthority: "rust-shadow-core",
    stateFoldWriterCount: 1,
    typescript: "contract-and-conformance-plane",
    productionWriteChange: false,
  });
  assert.deepEqual(contract.budgets, {
    schemaAuthorities: 1,
    stateFoldWriters: 1,
    secondStateFoldWriters: 0,
    providerSdkImportsInContracts: 0,
    providerSdkImportsInRustDomain: 0,
    liveProviderMutations: 0,
    productionWriteAuthorityChanges: 0,
    v3ConsumerBehaviorChanges: 0,
  });
});

test("journal implementations contain no provider, network, filesystem, or ambient authority", () => {
  const javascript = fs.readFileSync(
    new URL(
      "../packages/core/v4-provider-operation-journal.js",
      import.meta.url,
    ),
    "utf8",
  );
  const rust = [
    "../crates/buildchain-v4-contracts/src/provider_operation_journal.rs",
    "../crates/buildchain-v4-contracts/src/provider_operation_journal/fold.rs",
  ]
    .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  for (const forbidden of [
    "Date.now(",
    "new Date(",
    "node:fs",
    "node:https",
    "Octokit",
    "process.env",
    "providerRunId",
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

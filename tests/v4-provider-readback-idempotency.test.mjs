import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import { foldV4ProviderOperationJournal } from "../packages/core/v4-provider-operation-journal.js";
import {
  adaptV4GitHubReleaseReadback,
  adaptV4NpmPublicationReadback,
  adaptV4OciManifestReadback,
  foldV4ProviderReadbackSamples,
  projectV4ProviderReadbackFixtures,
} from "../packages/core/v4-provider-readback-idempotency.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixturePath = new URL(
  "../contracts/fixtures/v4-provider-readback-idempotency-v1/shared.json",
  import.meta.url,
);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("GitHub, npm, and OCI adapters erase provider shape into rooted neutral samples", () => {
  const adapters = {
    github: adaptV4GitHubReleaseReadback,
    npm: adaptV4NpmPublicationReadback,
    oci: adaptV4OciManifestReadback,
  };
  for (const fixture of fixtures.validCases.slice(0, 9)) {
    const [{ provider, response }] = fixture.readbacks;
    const sample = adapters[provider](response, fixtures.context);
    assert.deepEqual(sample, fixture.neutralSamples[0], fixture.id);
    for (const field of [
      "provider",
      "status",
      "assetSubjectRoot",
      "packageSubjectRoot",
      "repositorySubjectRoot",
      "networkResponseBody",
      "credential",
    ])
      assert.equal(field in sample, false, `${fixture.id}:${field}`);
  }
  const github = fixtures.validCases[0];
  const response = github.readbacks[0].response;
  assert.deepEqual(
    adaptV4GitHubReleaseReadback(
      {
        evidenceRoot: response.evidenceRoot,
        assetTargetRoot: response.assetTargetRoot,
        status: response.status,
        assetSubjectRoot: response.assetSubjectRoot,
        schema: response.schema,
      },
      fixtures.context,
    ),
    github.neutralSamples[0],
  );
});

test("duplicate and reordered readbacks fold idempotently", () => {
  const single = fixtures.validCases.find(
    (fixture) => fixture.id === "github-already-applied",
  );
  const duplicate = fixtures.validCases.find(
    (fixture) => fixture.id === "duplicate-readback-is-idempotent",
  );
  assert.deepEqual(
    foldV4ProviderReadbackSamples(
      duplicate.neutralSamples,
      fixtures.coordinates,
    ),
    foldV4ProviderReadbackSamples(single.neutralSamples, fixtures.coordinates),
  );
  const reordered = fixtures.validCases.find(
    (fixture) => fixture.id === "reordered-readbacks-are-idempotent",
  );
  assert.deepEqual(
    foldV4ProviderReadbackSamples(
      reordered.neutralSamples,
      fixtures.coordinates,
    ),
    foldV4ProviderReadbackSamples(
      [...reordered.neutralSamples].reverse(),
      fixtures.coordinates,
    ),
  );
});

test("all provider conflict, malformed, and root mismatch fixtures fail closed", () => {
  const projection = projectV4ProviderReadbackFixtures(fixtures);
  assert.deepEqual(
    projection.invalidCases,
    ["github", "npm", "oci"].flatMap((provider) => [
      {
        id: `${provider}-conflicting-target`,
        fault: "conflicting-provider-readback",
      },
      { id: `${provider}-malformed`, fault: "malformed-provider-readback" },
      {
        id: `${provider}-root-mismatch`,
        fault: "provider-readback-root-mismatch",
      },
    ]),
  );
});

test("Rust and TypeScript produce byte-equivalent readback folds and typed failures", () => {
  const typescript = projectV4ProviderReadbackFixtures(fixtures);
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "provider-readback",
      "contracts/fixtures/v4-provider-readback-idempotency-v1/shared.json",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack || result.stderr || result.stdout,
  );
  assert.deepEqual(JSON.parse(result.stdout), typescript);
});

test("readback output is consumed by the journal but cannot confirm release state", () => {
  const projection = projectV4ProviderReadbackFixtures(fixtures);
  const successful = projection.validCases.find(
    (fixture) => fixture.id === "github-already-applied",
  );
  const state = foldV4ProviderOperationJournal([
    ...fixtures.journalPrefix,
    successful.observation,
  ]);
  assert.equal(state.phase, "observed");
  assert.equal(state.confirmationRoot, null);
  assert.equal(typeof successful.journalStateRoot, "string");
  assert.equal(successful.observation.kind, "observation");
  assert.equal("authorityRoot" in successful.observation, false);
  assert.throws(
    () =>
      foldV4ProviderReadbackSamples(
        [
          fixtures.validCases[0].neutralSamples[0],
          fixtures.validCases[2].neutralSamples[0],
        ],
        fixtures.coordinates,
      ),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "conflicting-provider-readback",
  );
});

test("one closed schema and architecture retain bounded v4 production authority", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-provider-operation-journal-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.$defs.readbackSample.additionalProperties, false);
  assert.equal(schema.$defs.readbackFold.additionalProperties, false);
  assert.equal(
    schema.$defs.readbackFold.properties.observation.$ref,
    "#/$defs/observation",
  );

  const architecture = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-provider-operation-journal-contract.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    architecture.schemaAuthority,
    "contracts/v4-provider-operation-journal-v1.schema.json",
  );
  assert.equal(architecture.readbackAdapters.releaseStateAuthority, false);
  assert.equal(
    architecture.readbackAdapters.emits,
    "provider-operation-observation-only",
  );
  assert.equal(architecture.budgets.providerSdkImportsInRustDomain, 0);
  assert.equal(architecture.budgets.liveProviderMutations, 0);
  assert.equal(architecture.budgets.productionWriteAuthorityChanges, 1);
});

test("readback implementations contain no live provider, network, filesystem, or ambient authority", () => {
  const javascript = fs.readFileSync(
    new URL(
      "../packages/core/v4-provider-readback-idempotency.js",
      import.meta.url,
    ),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL(
      "../crates/buildchain-v4-contracts/src/provider_readback_idempotency.rs",
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
    "fetch(",
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
  ])
    assert.equal(rust.includes(forbidden), false, forbidden);
});

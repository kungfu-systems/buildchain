import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ContractFault } from "../packages/core/canonical-contracts.js";
import {
  planStablePublication,
  projectStablePublication,
} from "../packages/core/stable-publication-fence.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "../contracts/fixtures/v4-stable-publication-fence-v1/shared.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const clone = (value) => structuredClone(value);
const root = (digit) => `sha256:${digit.repeat(64)}`;

function expectFault(request, code) {
  assert.throws(
    () => projectStablePublication(request),
    (error) => error instanceof ContractFault && error.code === code,
    code,
  );
}

function rustProjection(request) {
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-domain-contracts/Cargo.toml",
      "--",
      "stable-publication",
      "-",
    ],
    {
      cwd: repositoryRoot,
      input: JSON.stringify(request),
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    result.error?.stack || result.stderr || result.stdout,
  );
  return JSON.parse(result.stdout);
}

test("stable publication planning is invariant to target and evidence ordering", () => {
  const reordered = clone(fixture);
  reordered.targets.reverse();
  reordered.qualification.providerConfirmationRoots.reverse();
  assert.deepEqual(
    projectStablePublication(reordered),
    projectStablePublication(fixture),
  );
});

test("N-1 and independently sealed evidence are explicit and never self-authorized", () => {
  const nMinusOne = projectStablePublication(fixture);
  assert.equal(nMinusOne.plan.qualification.mode, "n-minus-one");
  assert.equal(
    nMinusOne.plan.qualification.authorityGeneration + 1,
    nMinusOne.plan.candidate.generation,
  );

  const independentlySealed = clone(fixture);
  independentlySealed.qualification.mode = "independent-seal";
  independentlySealed.qualification.authorityGeneration =
    independentlySealed.candidate.generation;
  assert.equal(
    projectStablePublication(independentlySealed).fence.decision,
    "allow-publication",
  );

  const selfQualified = clone(fixture);
  selfQualified.qualification.authorityGeneration =
    selfQualified.candidate.generation;
  expectFault(selfQualified, "stable-publication-self-qualification");

  const sameAuthority = clone(independentlySealed);
  sameAuthority.qualification.qualifierAuthorityRoot =
    sameAuthority.publisherAuthorityRoot;
  expectFault(sameAuthority, "stable-publication-authority-mismatch");
});

test("publication fencing fails closed on every exact evidence coordinate", () => {
  const candidate = clone(fixture);
  candidate.qualification.qualifiedCandidateRoot = root("8");
  expectFault(candidate, "stable-publication-candidate-root-mismatch");

  for (const [field, code] of [
    ["sourceRoot", "stable-publication-source-mismatch"],
    ["metadataRoot", "stable-publication-metadata-mismatch"],
    ["journalRoot", "stable-publication-journal-mismatch"],
    ["protectedAncestryRoot", "stable-publication-ancestry-mismatch"],
  ]) {
    const request = clone(fixture);
    request.qualification[field] = root("8");
    expectFault(request, code);
  }

  const provider = clone(fixture);
  provider.qualification.providerConfirmationRoots.pop();
  expectFault(provider, "stable-publication-provider-confirmation-mismatch");

  const conflicting = clone(fixture);
  conflicting.targets[1].kind = conflicting.targets[0].kind;
  expectFault(conflicting, "conflicting-stable-publication-target");
});

test("Rust and TypeScript produce byte-equivalent shadow plans and fence roots", () => {
  assert.deepEqual(rustProjection(fixture), projectStablePublication(fixture));

  const independentlySealed = clone(fixture);
  independentlySealed.qualification.mode = "independent-seal";
  independentlySealed.qualification.authorityGeneration = 21;
  independentlySealed.targets.reverse();
  independentlySealed.qualification.providerConfirmationRoots.reverse();
  assert.deepEqual(
    rustProjection(independentlySealed),
    projectStablePublication(independentlySealed),
  );
});

test("the fence authorizes the exact target set under v4 production authority", () => {
  const projection = projectStablePublication(fixture);
  assert.equal(projection.plan.mode, "production");
  assert.equal(projection.plan.productionAuthority, "v4");
  assert.equal(projection.fence.effectCount, 4);
  assert.equal(projection.fence.decision, "allow-publication");
  assert.deepEqual(projection.plan.targets.map(({ kind }) => kind).sort(), [
    "github-release",
    "npm-tag",
    "oci-tag",
    "stable-ref",
  ]);
});

test("the schema and architecture are closed, single-writer, and production-v4", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-stable-publication-fence-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const architecture = JSON.parse(
    fs.readFileSync(
      new URL("../architecture/stable-publication-fence.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.candidate.additionalProperties, false);
  assert.equal(schema.$defs.qualification.additionalProperties, false);
  assert.equal(schema.$defs.target.additionalProperties, false);
  assert.equal(architecture.mode, "production");
  assert.equal(architecture.authority.productionWriter, "v4-domain");
  assert.equal(architecture.authority.productionWriteChange, true);
  assert.equal(architecture.authority.candidateSelfQualification, false);
  assert.deepEqual(architecture.budgets, {
    schemaAuthorities: 1,
    fenceWriters: 1,
    secondStateFoldWriters: 0,
    providerSdkImportsInContracts: 0,
    providerSdkImportsInRustDomain: 0,
    liveProviderMutations: 0,
    networkWrites: 0,
    credentialReads: 0,
    publicOrProtectedRefChanges: 0,
    productionWriteAuthorityChanges: 1,
    v3ConsumerBehaviorChanges: 0,
  });
});

test("production fence implementations contain no provider, network, filesystem, process, or ambient authority", () => {
  const javascript = fs.readFileSync(
    new URL("../packages/core/stable-publication-fence.js", import.meta.url),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL(
      "../crates/buildchain-domain-contracts/src/stable_publication_fence.rs",
      import.meta.url,
    ),
    "utf8",
  );
  for (const forbidden of [
    "Date.now(",
    "new Date(",
    "node:fs",
    "node:https",
    "process.env",
    "Octokit",
    "fetch(",
    "child_process",
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

test("plan roots remain stable under explicit ASCII target ordering", () => {
  const request = clone(fixture);
  request.targets[0].id = "a-z";
  request.targets[1].id = "aa";
  const plan = planStablePublication(request);
  assert.deepEqual(
    plan.targets.slice(0, 2).map(({ id }) => id),
    ["a-z", "aa"],
  );
  assert.deepEqual(rustProjection(request).plan, plan);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import {
  planV4StablePublication,
  projectV4StablePublication,
} from "../packages/core/v4-stable-publication-fence.js";

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
    () => projectV4StablePublication(request),
    (error) => error instanceof V4ContractFault && error.code === code,
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
      "crates/buildchain-v4-contracts/Cargo.toml",
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
    projectV4StablePublication(reordered),
    projectV4StablePublication(fixture),
  );
});

test("N-1 and independently sealed evidence are explicit and never self-authorized", () => {
  const nMinusOne = projectV4StablePublication(fixture);
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
    projectV4StablePublication(independentlySealed).fence.decision,
    "allow-shadow-plan",
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
  assert.deepEqual(
    rustProjection(fixture),
    projectV4StablePublication(fixture),
  );

  const independentlySealed = clone(fixture);
  independentlySealed.qualification.mode = "independent-seal";
  independentlySealed.qualification.authorityGeneration = 21;
  independentlySealed.targets.reverse();
  independentlySealed.qualification.providerConfirmationRoots.reverse();
  assert.deepEqual(
    rustProjection(independentlySealed),
    projectV4StablePublication(independentlySealed),
  );
});

test("the fence creates no effects and preserves v3 production authority", () => {
  const projection = projectV4StablePublication(fixture);
  assert.equal(projection.plan.mode, "shadow-only");
  assert.equal(projection.plan.productionAuthority, "v3");
  assert.equal(projection.fence.effectCount, 0);
  assert.equal(projection.fence.decision, "allow-shadow-plan");
  assert.deepEqual(projection.plan.targets.map(({ kind }) => kind).sort(), [
    "github-release",
    "npm-tag",
    "oci-tag",
    "stable-ref",
  ]);
});

test("the schema and architecture are closed, single-writer, and shadow-only", () => {
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
      new URL(
        "../architecture/v4-stable-publication-fence.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.candidate.additionalProperties, false);
  assert.equal(schema.$defs.qualification.additionalProperties, false);
  assert.equal(schema.$defs.target.additionalProperties, false);
  assert.equal(architecture.mode, "shadow-only");
  assert.equal(architecture.authority.productionWriter, "typescript-v3");
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
    productionWriteAuthorityChanges: 0,
    v3ConsumerBehaviorChanges: 0,
  });
});

test("shadow fence implementations contain no provider, network, filesystem, process, or ambient authority", () => {
  const javascript = fs.readFileSync(
    new URL("../packages/core/v4-stable-publication-fence.js", import.meta.url),
    "utf8",
  );
  const rust = fs.readFileSync(
    new URL(
      "../crates/buildchain-v4-contracts/src/stable_publication_fence.rs",
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
  const plan = planV4StablePublication(request);
  assert.deepEqual(
    plan.targets.slice(0, 2).map(({ id }) => id),
    ["a-z", "aa"],
  );
  assert.deepEqual(rustProjection(request).plan, plan);
});

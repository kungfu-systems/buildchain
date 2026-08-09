import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";

import { V4ContractFault } from "../packages/core/v4-canonical-contracts.js";
import {
  foldV4ReleaseActivation,
  planV4ReleaseActivation,
  projectV4ReleaseActivation,
} from "../packages/core/v4-release-activation-shadow.js";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "../contracts/fixtures/v4-release-activation-shadow-v1/shared.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const authorityRoot = fixture.authorityRoot;
const clone = (value) => structuredClone(value);
const root = (digit) => `sha256:${digit.repeat(64)}`;

function successfulEvents(stepId, offset = 0) {
  return [
    {
      kind: "attempt",
      stepId,
      ordinal: 1,
      attemptedAt: `2026-08-09T06:00:${String(offset + 1).padStart(2, "0")}.000Z`,
      effectRoot: root("d"),
    },
    {
      kind: "observation",
      stepId,
      ordinal: 2,
      observedAt: `2026-08-09T06:00:${String(offset + 2).padStart(2, "0")}.000Z`,
      status: "succeeded",
      evidenceRoots: [root("f"), root("e")],
    },
    {
      kind: "confirmation",
      stepId,
      ordinal: 3,
      confirmedAt: `2026-08-09T06:00:${String(offset + 3).padStart(2, "0")}.000Z`,
      outcome: "confirmed",
      authorityRoot,
    },
  ];
}

function expectFault(request, code) {
  assert.throws(
    () => projectV4ReleaseActivation(request),
    (error) => error instanceof V4ContractFault && error.code === code,
    code,
  );
}

test("activation planning is invariant to step, dependency, event, and exact duplicate ordering", () => {
  const left = clone(fixture);
  left.steps[2].dependencies.push("npm-package");
  left.events = successfulEvents("github-release");
  const right = clone(left);
  right.steps.reverse();
  right.steps.find(({ id }) => id === "oci-image").dependencies.reverse();
  right.events = [
    clone(left.events[2]),
    clone(left.events[0]),
    clone(left.events[1]),
    clone(left.events[1]),
  ];
  right.events[0].authorityRoot = authorityRoot;
  assert.deepEqual(
    projectV4ReleaseActivation(right),
    projectV4ReleaseActivation(left),
  );
});

test("qualified resume never replays confirmed work and requires readback for uncertain work", () => {
  const request = clone(fixture);
  request.events = [
    ...successfulEvents("github-release"),
    {
      kind: "attempt",
      stepId: "oci-image",
      ordinal: 1,
      attemptedAt: "2026-08-09T06:00:10.000Z",
      effectRoot: root("d"),
    },
  ];
  const state = foldV4ReleaseActivation(request);
  assert.equal(state.phase, "active");
  assert.deepEqual(state.confirmedSteps, ["github-release"]);
  assert.deepEqual(state.readbackSteps, ["oci-image"]);
  assert.deepEqual(state.eligibleSteps, ["npm-package"]);
  assert.equal(state.eligibleSteps.includes("github-release"), false);
  assert.equal(state.eligibleSteps.includes("oci-image"), false);
});

test("all rooted confirmations close the shadow plan without granting production authority", () => {
  const request = clone(fixture);
  request.events = [
    ...successfulEvents("github-release"),
    ...successfulEvents("npm-package", 10),
    ...successfulEvents("oci-image", 20),
  ];
  const projection = projectV4ReleaseActivation(request);
  assert.equal(projection.state.phase, "complete");
  assert.deepEqual(projection.state.eligibleSteps, []);
  assert.equal(projection.plan.mode, "shadow-only");
  assert.equal(projection.plan.productionAuthority, "v3");
});

test("activation validation fails closed on qualification, graph, identity, authority, and evidence drift", () => {
  const missingQualification = clone(fixture);
  missingQualification.qualificationRoot = null;
  expectFault(missingQualification, "missing-release-activation-qualification");

  const cyclic = clone(fixture);
  cyclic.steps[0].dependencies = ["npm-package"];
  expectFault(cyclic, "release-activation-dependency-cycle");

  const mismatchedAuthority = clone(fixture);
  mismatchedAuthority.steps[0].operation.authorityRoot = root("a");
  expectFault(mismatchedAuthority, "release-activation-authority-mismatch");

  const duplicateOperation = clone(fixture);
  duplicateOperation.steps[1].operation = clone(
    duplicateOperation.steps[0].operation,
  );
  expectFault(duplicateOperation, "conflicting-release-activation-operation");

  const unrooted = clone(fixture);
  unrooted.events = successfulEvents("github-release");
  unrooted.events[1].evidenceRoots = [];
  expectFault(unrooted, "unrooted-release-activation-observation");

  const conflictingOrdinal = clone(fixture);
  conflictingOrdinal.events = successfulEvents("github-release");
  conflictingOrdinal.events.push({
    ...conflictingOrdinal.events[0],
    effectRoot: root("c"),
  });
  expectFault(conflictingOrdinal, "conflicting-release-activation-event");
});

test("Rust and TypeScript produce byte-equivalent plans, folds, and roots", () => {
  const request = clone(fixture);
  request.events = [
    ...successfulEvents("github-release"),
    {
      kind: "attempt",
      stepId: "oci-image",
      ordinal: 1,
      attemptedAt: "2026-08-09T06:00:10.000Z",
      effectRoot: root("d"),
    },
  ];
  const typescript = projectV4ReleaseActivation(request);
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "release-activation",
      "-",
    ],
    {
      cwd: repositoryRoot,
      input: JSON.stringify(request),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), typescript);
});

test("ASCII step ordering is byte-stable across the Rust and TypeScript boundary", () => {
  const request = clone(fixture);
  request.steps = request.steps.slice(0, 2);
  request.steps[0].id = "a-z";
  request.steps[1].id = "aa";
  request.steps[1].dependencies = ["a-z"];
  const typescript = planV4ReleaseActivation(request);
  assert.deepEqual(
    typescript.steps.map(({ id }) => id),
    ["a-z", "aa"],
  );
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "release-activation",
      "-",
    ],
    {
      cwd: repositoryRoot,
      input: JSON.stringify(request),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).plan, typescript);
});

test("the sole schema and architecture authorities remain closed and shadow-only", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-release-activation-shadow-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const architecture = JSON.parse(
    fs.readFileSync(
      new URL(
        "../architecture/v4-release-activation-shadow-domain.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.step.additionalProperties, false);
  assert.deepEqual(
    schema.$defs.event.oneOf.map(({ $ref }) => $ref),
    ["attempt", "observation", "reconciliation", "confirmation"].map(
      (kind) => `#/$defs/${kind}`,
    ),
  );
  assert.equal(architecture.mode, "shadow-only");
  assert.equal(architecture.authority.productionWriter, "typescript-v3");
  assert.deepEqual(architecture.budgets, {
    schemaAuthorities: 1,
    planAndFoldWriters: 1,
    secondStateFoldWriters: 0,
    providerSdkImportsInContracts: 0,
    providerSdkImportsInRustDomain: 0,
    liveProviderMutations: 0,
    productionWriteAuthorityChanges: 0,
    v3ConsumerBehaviorChanges: 0,
  });
});

test("activation implementations contain no provider, network, filesystem, process, or ambient authority", () => {
  const javascript = fs.readFileSync(
    new URL(
      "../packages/core/v4-release-activation-shadow.js",
      import.meta.url,
    ),
    "utf8",
  );
  const rust = [
    "../crates/buildchain-v4-contracts/src/release_activation_shadow.rs",
    "../crates/buildchain-v4-contracts/src/release_activation_shadow/model.rs",
    "../crates/buildchain-v4-contracts/src/release_activation_shadow/journal.rs",
  ]
    .map((path) => fs.readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
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

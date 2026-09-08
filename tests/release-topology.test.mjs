import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  RELEASE_INVOCATION_ADAPTER_CONTRACT,
  RELEASE_RECEIPT_CONTRACT,
  adaptReleaseInvocation,
  createReleaseInvocation,
  createReleaseReceipt,
  createDomainReleaseTransaction,
  planReleaseRoute,
} from "../packages/core/release-invocation.js";
import {
  ContractFault,
  domainCanonicalBytes,
  domainContentRoot,
} from "../packages/core/canonical-contracts.js";
import {
  checkReleaseTopology,
  discoverReleaseTopology,
  findUnknownReleaseTopology,
} from "../scripts/check-release-topology.mjs";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "../architecture/release-invocation-fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const topologyLedger = JSON.parse(
  fs.readFileSync(
    new URL("../architecture/release-topology.json", import.meta.url),
    "utf8",
  ),
);
const root = path.resolve(import.meta.dirname, "..");

function project(entry) {
  return adaptReleaseInvocation({
    schema: RELEASE_INVOCATION_ADAPTER_CONTRACT,
    route: entry.route,
    invocation: structuredClone(fixture.invocations[entry.invocation]),
  });
}

function transactionFor(invocation) {
  const projected = createReleaseInvocation(invocation);
  return createDomainReleaseTransaction({
    invocationRoot: projected.roots.invocationRoot,
    publisherRoot: projected.roots.publisherRoot,
    runtimeRoot: projected.roots.runtimeRoot,
    providerRoot: projected.roots.providerRoot,
    parentRoot: projected.roots.parentRoot,
  });
}

test("all entry and recovery adapters collapse to one rooted invocation per semantic release", () => {
  const projections = new Map(
    fixture.cases.map((entry) => [entry.id, project(entry)]),
  );
  for (const group of fixture.equivalenceGroups) {
    const expected = projections.get(group[0]).roots;
    for (const id of group)
      assert.deepEqual(projections.get(id).roots, expected, id);
  }
  assert.notEqual(
    projections.get("alpha-fresh").roots.invocationRoot,
    projections.get("stable-fresh").roots.invocationRoot,
  );
});

test("post-admission invocation is closed and contains no floating selector", () => {
  const invocation = structuredClone(fixture.invocations.alpha);
  assert.equal(createReleaseInvocation(invocation).invocation, invocation);
  assert.throws(
    () => createReleaseInvocation({ ...invocation, execution: "resume" }),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-release-invocation-shape",
  );
  assert.throws(
    () =>
      createReleaseInvocation({
        ...invocation,
        target: { ...invocation.target, ref: "v4-alpha" },
      }),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-release-invocation-shape",
  );
  assert.throws(
    () =>
      createReleaseInvocation({
        ...invocation,
        runtime: { ...invocation.runtime, ref: "v4-alpha" },
      }),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-release-invocation-shape",
  );
  assert.throws(
    () =>
      createReleaseInvocation({
        ...invocation,
        publisher: { ...invocation.publisher, job: "legacy-promote" },
      }),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-publisher-identity",
  );
});

test("the public schema freezes the same closed ReleaseInvocation shape", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL(
        "../contracts/v4-release-invocation-v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    schema,
  );
  assert.equal(
    validate(fixture.invocations.alpha),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate(fixture.invocations.stable),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(
    validate({
      ...structuredClone(fixture.invocations.alpha),
      runtime: { ...fixture.invocations.alpha.runtime, ref: "v4-alpha" },
    }),
    false,
  );
  assert.equal(schema.additionalProperties, false);
  for (const definition of [
    "publisher",
    "runtime",
    "candidate",
    "target",
    "authority",
    "provider",
    "parent",
  ])
    assert.equal(
      schema.$defs[definition].additionalProperties,
      false,
      definition,
    );
});

test("every admitted identity class changes or rejects invocation lineage drift", () => {
  const baseline = project(fixture.cases[0]);
  const validDrifts = [
    ["publisher", "workflowSha", "1".repeat(40)],
    ["runtime", "commit", "2".repeat(40)],
    ["runtime", "tree", "3".repeat(40)],
    ["candidate", "commit", "4".repeat(40)],
    ["candidate", "tree", "5".repeat(40)],
    ["target", "expectedOldSha", "6".repeat(40)],
    ["authority", "policyRoot", `sha256:${"7".repeat(64)}`],
  ];
  for (const [identity, field, value] of validDrifts) {
    const drifted = structuredClone(fixture.invocations.alpha);
    drifted[identity][field] = value;
    assert.notEqual(
      createReleaseInvocation(drifted).roots.invocationRoot,
      baseline.roots.invocationRoot,
      `${identity}.${field}`,
    );
  }
  const parentDrift = structuredClone(fixture.invocations.alpha);
  parentDrift.parent = {
    invocationRoot: `sha256:${"8".repeat(64)}`,
    transactionRoot: `sha256:${"9".repeat(64)}`,
    receiptRoot: `sha256:${"a".repeat(64)}`,
  };
  assert.notEqual(
    createReleaseInvocation(parentDrift).roots.invocationRoot,
    baseline.roots.invocationRoot,
    "parent lineage",
  );
  const providerDrift = structuredClone(fixture.invocations.alpha);
  providerDrift.provider.adapter = "legacy-provider";
  assert.throws(
    () => createReleaseInvocation(providerDrift),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-release-provider",
  );
  const partialParent = structuredClone(fixture.invocations.alpha);
  partialParent.parent.invocationRoot = `sha256:${"b".repeat(64)}`;
  assert.throws(
    () => createReleaseInvocation(partialParent),
    (error) =>
      error instanceof ContractFault &&
      error.code === "invalid-release-parent-lineage",
  );
});

test("fresh, resume, no-op, and blocked routing is provider-free and deterministic", () => {
  const base = {
    requestedSha: "a".repeat(40),
    observedSha: "a".repeat(40),
    comparisonStatus: "identical",
    requestedChannel: "alpha",
    targetRef: "alpha/v4/v4.0",
  };
  assert.equal(planReleaseRoute(base).decision, "Fresh");
  assert.equal(planReleaseRoute({ ...base, resume: true }).decision, "Resume");
  assert.equal(
    planReleaseRoute({
      ...base,
      observedSha: "b".repeat(40),
      comparisonStatus: "ahead",
    }).decision,
    "NoOp",
  );
  assert.equal(
    planReleaseRoute({
      ...base,
      observedSha: "b".repeat(40),
      comparisonStatus: "diverged",
    }).decision,
    "Blocked",
  );
});

test("one three-phase ReleaseTransaction owns one terminal ReleaseReceipt", () => {
  const transaction = transactionFor(fixture.invocations.alpha);
  assert.deepEqual(transaction.transaction.phases, [
    "QUALIFY",
    "APPLY",
    "SETTLE",
  ]);
  assert.equal(transaction.transaction.writer, "canonical-v4-apply");
  const roots = ["1", "2"].map((digit) => `sha256:${digit.repeat(64)}`);
  const terminal = createReleaseReceipt({
    schema: RELEASE_RECEIPT_CONTRACT,
    transactionRoot: transaction.transactionRoot,
    outcome: "complete",
    releasePassportRoot: `sha256:${"3".repeat(64)}`,
    providerTransactionRoot: `sha256:${"4".repeat(64)}`,
    providerStateRoot: `sha256:${"5".repeat(64)}`,
    providerReceiptRoots: roots,
  });
  assert.match(terminal.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(
    () =>
      createReleaseReceipt({
        ...terminal.receipt,
        providerReceiptRoots: [...roots].reverse(),
      }),
    (error) => error.code === "invalid-release-receipt",
  );
  assert.throws(
    () =>
      createReleaseReceipt({
        ...terminal.receipt,
        releasePassportRoot: null,
      }),
    (error) => error.code === "invalid-release-receipt",
  );
});

test("Rust and JavaScript produce byte-identical ReleaseInvocation root DAGs", () => {
  const cases = Object.entries(fixture.invocations).flatMap(
    ([name, invocation]) => {
      const projected = createReleaseInvocation(invocation);
      const transaction = transactionFor(invocation);
      const receipt = createReleaseReceipt({
        schema: RELEASE_RECEIPT_CONTRACT,
        transactionRoot: transaction.transactionRoot,
        outcome: "complete",
        releasePassportRoot: `sha256:${"3".repeat(64)}`,
        providerTransactionRoot: `sha256:${"4".repeat(64)}`,
        providerStateRoot: `sha256:${"5".repeat(64)}`,
        providerReceiptRoots: [`sha256:${"6".repeat(64)}`],
      });
      return [
        ["publisher", "release-invocation-publisher", invocation.publisher],
        ["runtime", "release-invocation-runtime", invocation.runtime],
        ["candidate", "release-invocation-candidate", invocation.candidate],
        ["target", "release-invocation-target", invocation.target],
        ["authority", "release-invocation-authority", invocation.authority],
        ["provider", "release-invocation-provider", invocation.provider],
        ["parent", "release-invocation-parent", invocation.parent],
        [
          "invocation",
          "release-invocation",
          {
            schema: invocation.schema,
            publisherRoot: projected.roots.publisherRoot,
            runtimeRoot: projected.roots.runtimeRoot,
            candidateRoot: projected.roots.candidateRoot,
            targetRoot: projected.roots.targetRoot,
            authorityRoot: projected.roots.authorityRoot,
            providerRoot: projected.roots.providerRoot,
            parentRoot: projected.roots.parentRoot,
          },
        ],
        ["transaction", "release-transaction", transaction.transaction],
        ["receipt", "release-receipt", receipt.receipt],
      ].map(([component, domain, value]) => ({
        id: `${name}-${component}`,
        domain,
        value,
        clock: "2026-08-28T00:00:00.000Z",
      }));
    },
  );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "release-invocation-"));
  const fixturePath = path.join(scratch, "roots.json");
  fs.writeFileSync(
    fixturePath,
    `${JSON.stringify({ validCases: cases, invalidCases: [] })}\n`,
  );
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    [
      "run",
      "--locked",
      "--quiet",
      "--manifest-path",
      "crates/buildchain-domain-contracts/Cargo.toml",
      "--",
      fixturePath,
    ],
    { cwd: root, encoding: "utf8" },
  );
  fs.rmSync(scratch, { recursive: true });
  assert.equal(result.status, 0, result.error?.stack || result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).validCases,
    cases.map(({ id, domain, value }) => ({
      id,
      canonicalUtf8: domainCanonicalBytes(value).toString("utf8"),
      root: domainContentRoot(domain, value),
      clockValid: true,
    })),
  );
});

test("the topology ledger exactly freezes all current release jobs and authority signals", () => {
  const topology = checkReleaseTopology();
  assert.deepEqual(topology.metrics, {
    workflowCount: 35,
    jobCount: 86,
    reusableEdgeCount: 21,
    mutationRelevantNodeCount: 72,
    contentsWriteJobCount: 14,
    oidcWriteJobCount: 12,
  });
  assert.deepEqual(topology.semanticMetrics, {
    workflowCount: 5,
    mutationRelevantNodeCount: 8,
    contentsWriteJobCount: 1,
    oidcWriteJobCount: 1,
  });
  assert.deepEqual(
    discoverReleaseTopology(
      topologyLedger.closedWorld.workflowPaths,
      topologyLedger.semanticScope.workflowPaths,
    ),
    topology,
  );
});

test("fresh, recovery, and startup-failure routes cannot reach a legacy release engine", () => {
  const canonical = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  const publicWrapper = fs.readFileSync(
    path.join(root, ".github/workflows/release-candidate-promote.yml"),
    "utf8",
  );
  const recovery = fs.readFileSync(
    path.join(root, ".github/workflows/self-ops-promotion-recovery.yml"),
    "utf8",
  );
  assert.deepEqual(topologyLedger.authorityClosure.runtimeEngines, [
    "actions/release-candidate-promote/index.js",
  ]);
  assert.deepEqual(
    topologyLedger.authorityClosure.privilegedExecutableClosure.entrypoints,
    [
      "actions/release-candidate-promote/index.js",
      "scripts/binary-publication-evidence.mjs",
      "scripts/next-development-review.mjs",
      "scripts/oci-compose-preview.mjs",
      "scripts/publication-settlement.mjs",
    ],
  );
  assert.match(
    topologyLedger.authorityClosure.privilegedExecutableClosure.root,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.ok(
    topologyLedger.authorityClosure.privilegedExecutableClosure.modules.includes(
      "actions/release-candidate-promote/product-provider.js",
    ),
  );
  assert.deepEqual(
    topologyLedger.authorityClosure.legacyEngineModules.filter((relative) =>
      topologyLedger.authorityClosure.privilegedExecutableClosure.modules.includes(
        relative,
      ),
    ),
    [],
  );
  assert.doesNotMatch(
    [canonical, publicWrapper, recovery].join("\n"),
    /legacy-promote|v4-declarative-promote/u,
  );
  assert.match(
    canonical,
    /uses: \.\/\.buildchain\/runtime\/actions\/release-candidate-promote/u,
  );
  assert.match(
    canonical,
    /source-sha: \$\{\{ needs\.qualify\.outputs\.requested-sha \}\}/u,
  );
  assert.match(
    publicWrapper,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.release-candidate-promote\.yml@/u,
  );
  assert.match(
    recovery,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@/u,
  );
});

test("closed-world discovery rejects an undeclared release topology workflow", () => {
  assert.deepEqual(
    findUnknownReleaseTopology(
      ["known.yml"],
      ["known.yml", "new.yml", "unrelated.yml"],
      (relative) =>
        relative === "new.yml"
          ? "uses: kungfu-systems/buildchain/actions/promote-buildchain-ref@v4"
          : "jobs:\n  check:\n    runs-on: ubuntu-24.04\n",
    ),
    ["new.yml"],
  );
});

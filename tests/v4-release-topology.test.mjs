import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  V4_RELEASE_INVOCATION_ADAPTER_CONTRACT,
  V4_RELEASE_RECEIPT_CONTRACT,
  adaptV4ReleaseInvocation,
  createV4ReleaseInvocation,
  createV4ReleaseReceipt,
  createV4ReleaseTransaction,
  planV4ReleaseRoute,
} from "../packages/core/v4-release-invocation.js";
import {
  V4ContractFault,
  v4CanonicalBytes,
  v4ContentRoot,
} from "../packages/core/v4-canonical-contracts.js";
import {
  checkV4ReleaseTopology,
  discoverV4ReleaseTopology,
  findUnknownV4ReleaseTopology,
} from "../scripts/check-v4-release-topology.mjs";
import { resolveV4ReleaseCandidateAdapter } from "../scripts/v4-release-candidate-adapter.mjs";
import {
  sealedCandidateVersion,
  selectProductPublicationPlan,
} from "../actions/v4-release-candidate-promote/product-provider.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL(
      "../architecture/v4-release-invocation-fixtures.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const topologyLedger = JSON.parse(
  fs.readFileSync(
    new URL("../architecture/v4-release-topology.json", import.meta.url),
    "utf8",
  ),
);
const root = path.resolve(import.meta.dirname, "..");

function project(entry) {
  return adaptV4ReleaseInvocation({
    schema: V4_RELEASE_INVOCATION_ADAPTER_CONTRACT,
    route: entry.route,
    invocation: structuredClone(fixture.invocations[entry.invocation]),
  });
}

function transactionFor(invocation) {
  const projected = createV4ReleaseInvocation(invocation);
  return createV4ReleaseTransaction({
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
  assert.equal(createV4ReleaseInvocation(invocation).invocation, invocation);
  assert.throws(
    () => createV4ReleaseInvocation({ ...invocation, execution: "resume" }),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "invalid-release-invocation-shape",
  );
  assert.throws(
    () =>
      createV4ReleaseInvocation({
        ...invocation,
        target: { ...invocation.target, ref: "v4-alpha" },
      }),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "invalid-release-invocation-shape",
  );
  assert.throws(
    () =>
      createV4ReleaseInvocation({
        ...invocation,
        runtime: { ...invocation.runtime, ref: "v4-alpha" },
      }),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "invalid-release-invocation-shape",
  );
  assert.throws(
    () =>
      createV4ReleaseInvocation({
        ...invocation,
        publisher: { ...invocation.publisher, job: "legacy-promote" },
      }),
    (error) =>
      error instanceof V4ContractFault &&
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
      createV4ReleaseInvocation(drifted).roots.invocationRoot,
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
    createV4ReleaseInvocation(parentDrift).roots.invocationRoot,
    baseline.roots.invocationRoot,
    "parent lineage",
  );
  const providerDrift = structuredClone(fixture.invocations.alpha);
  providerDrift.provider.adapter = "legacy-provider";
  assert.throws(
    () => createV4ReleaseInvocation(providerDrift),
    (error) =>
      error instanceof V4ContractFault &&
      error.code === "invalid-release-provider",
  );
  const partialParent = structuredClone(fixture.invocations.alpha);
  partialParent.parent.invocationRoot = `sha256:${"b".repeat(64)}`;
  assert.throws(
    () => createV4ReleaseInvocation(partialParent),
    (error) =>
      error instanceof V4ContractFault &&
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
  assert.equal(planV4ReleaseRoute(base).decision, "Fresh");
  assert.equal(
    planV4ReleaseRoute({ ...base, resume: true }).decision,
    "Resume",
  );
  assert.equal(
    planV4ReleaseRoute({
      ...base,
      observedSha: "b".repeat(40),
      comparisonStatus: "ahead",
    }).decision,
    "NoOp",
  );
  assert.equal(
    planV4ReleaseRoute({
      ...base,
      observedSha: "b".repeat(40),
      comparisonStatus: "diverged",
    }).decision,
    "Blocked",
  );
});

test("fresh and recovery candidate discovery are data-only adapters into the same APPLY engine", () => {
  assert.deepEqual(resolveV4ReleaseCandidateAdapter(), {
    mode: "fresh",
    script: "scripts/release-candidate-resolver.mjs",
  });
  assert.deepEqual(
    resolveV4ReleaseCandidateAdapter({ resumeCandidateRunId: "123" }),
    {
      mode: "recovery",
      script: "scripts/resume-from-candidate-run.mjs",
    },
  );
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.release-candidate-promote.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /run: node \.buildchain\/runtime\/scripts\/v4-release-candidate-adapter\.mjs/u,
  );
  assert.doesNotMatch(
    workflow,
    /if \[ -n "\$BUILDCHAIN_RESUME_CANDIDATE_RUN_ID" \]/u,
  );
});

test("canonical APPLY roots the product provider's planned exact version", () => {
  assert.deepEqual(
    selectProductPublicationPlan({
      updates: [
        {
          action: "dry-run-publish-transaction",
          version: "4.0.2-alpha.3",
          tag: "v4.0.2-alpha.3",
          releaseCandidateVersion: "4.0.2-alpha.2",
        },
      ],
    }),
    {
      version: "4.0.2-alpha.3",
      tag: "v4.0.2-alpha.3",
      candidateVersion: "4.0.2-alpha.2",
    },
  );
  assert.throws(
    () =>
      selectProductPublicationPlan({
        updates: [
          {
            action: "dry-run-publish-transaction",
            version: "4.0.2-alpha.3",
            tag: "v22.22.3-kf.0",
          },
        ],
      }),
    /mismatched exact tag/u,
  );
  assert.deepEqual(
    selectProductPublicationPlan(
      {
        updates: [
          {
            action: "dry-run-publish-transaction",
            version: "4.0.1",
            tag: "v4.0.1",
          },
        ],
      },
      { fallbackCandidateVersion: "4.0.1-alpha.56" },
    ),
    {
      version: "4.0.1",
      tag: "v4.0.1",
      candidateVersion: "4.0.1-alpha.56",
    },
  );
  assert.throws(
    () =>
      selectProductPublicationPlan(
        {
          updates: [
            {
              action: "dry-run-publish-transaction",
              version: "4.0.1",
              tag: "v4.0.1",
              releaseCandidateVersion: "4.0.1-alpha.55",
            },
          ],
        },
        { fallbackCandidateVersion: "4.0.1-alpha.56" },
      ),
    /drifted from the sealed candidate version/u,
  );
});

test("canonical APPLY recovers the candidate version from the sealed package manifest", () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-sealed-version-"),
  );
  try {
    const manifest = path.join(temporaryRoot, "sealed-bundle.json");
    fs.writeFileSync(
      manifest,
      `${JSON.stringify({
        npm: {
          name: "@kungfu-tech/buildchain",
          version: "4.0.1-alpha.56",
        },
      })}\n`,
    );
    assert.equal(
      sealedCandidateVersion({
        sealedBundleManifest: manifest,
        publishPackageMain: "@kungfu-tech/buildchain",
      }),
      "4.0.1-alpha.56",
    );
    assert.throws(
      () =>
        sealedCandidateVersion({
          sealedBundleManifest: manifest,
          publishPackageMain: "@kungfu-tech/not-buildchain",
        }),
      /omitted the exact main package version/u,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("canonical APPLY activates the pnpm shim required by nested lifecycle scripts", () => {
  const provider = fs.readFileSync(
    path.join(root, "actions/v4-release-candidate-promote/product-provider.js"),
    "utf8",
  );
  assert.match(
    provider,
    /execFileSync\("corepack", \["enable", "pnpm"\], \{ stdio: "inherit" \}\);/u,
  );
  assert.match(
    provider,
    /const candidateVersion = sealedCandidateVersion\(request\);[\s\S]*promotionOptions\(request, \{ dryRun: true \}, candidateVersion\)/u,
  );
  assert.match(provider, /\}\s*,\s*plan\.candidateVersion,?\s*\),/u);
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
  const terminal = createV4ReleaseReceipt({
    schema: V4_RELEASE_RECEIPT_CONTRACT,
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
      createV4ReleaseReceipt({
        ...terminal.receipt,
        providerReceiptRoots: [...roots].reverse(),
      }),
    (error) => error.code === "invalid-release-receipt",
  );
  assert.throws(
    () =>
      createV4ReleaseReceipt({
        ...terminal.receipt,
        releasePassportRoot: null,
      }),
    (error) => error.code === "invalid-release-receipt",
  );
});

test("Rust and JavaScript produce byte-identical ReleaseInvocation root DAGs", () => {
  const cases = Object.entries(fixture.invocations).flatMap(
    ([name, invocation]) => {
      const projected = createV4ReleaseInvocation(invocation);
      const transaction = transactionFor(invocation);
      const receipt = createV4ReleaseReceipt({
        schema: V4_RELEASE_RECEIPT_CONTRACT,
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
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "v4-release-invocation-"),
  );
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
      "crates/buildchain-v4-contracts/Cargo.toml",
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
      canonicalUtf8: v4CanonicalBytes(value).toString("utf8"),
      root: v4ContentRoot(domain, value),
      clockValid: true,
    })),
  );
});

test("the topology ledger exactly freezes all current release jobs and authority signals", () => {
  const topology = checkV4ReleaseTopology();
  assert.deepEqual(topology.metrics, {
    workflowCount: 37,
    jobCount: 92,
    reusableEdgeCount: 23,
    mutationRelevantNodeCount: 74,
    contentsWriteJobCount: 14,
    oidcWriteJobCount: 16,
  });
  assert.deepEqual(topology.semanticMetrics, {
    workflowCount: 5,
    mutationRelevantNodeCount: 8,
    contentsWriteJobCount: 1,
    oidcWriteJobCount: 1,
  });
  assert.deepEqual(
    discoverV4ReleaseTopology(
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
    path.join(root, ".github/workflows/buildchain-ref-promotion-recovery.yml"),
    "utf8",
  );
  const promoteRelease = fs.readFileSync(
    path.join(root, "actions/promote-buildchain-ref/internal/promote-release-channel.js"),
    "utf8",
  );
  assert.deepEqual(topologyLedger.authorityClosure.runtimeEngines, [
    "actions/v4-release-candidate-promote/index.js",
  ]);
  assert.doesNotMatch(
    [canonical, publicWrapper, recovery].join("\n"),
    /legacy-promote|v4-declarative-promote/u,
  );
  assert.match(
    canonical,
    /uses: \.\/\.buildchain\/runtime\/actions\/v4-release-candidate-promote/u,
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
  assert.match(
    promoteRelease,
    /recoveredCandidate: Boolean\(state\.containsPublishedMaterial\)/u,
  );
});

test("closed-world discovery rejects an undeclared release topology workflow", () => {
  assert.deepEqual(
    findUnknownV4ReleaseTopology(
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

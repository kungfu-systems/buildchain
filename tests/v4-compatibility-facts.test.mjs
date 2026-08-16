import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  assertBuildchainCompatibilityProjection,
  createBuildchainCompatibilityFactRegistry,
  createBuildchainCompatibilityPathQuery,
  createBuildchainCompatibilityReleaseEvidence,
  createBuildchainContractLock,
  createBuildchainContractWorld,
  evaluateBuildchainContractLock,
  finalizeBuildchainContractWorld,
  verifyBuildchainCompatibilityFactRegistry,
  verifyBuildchainCompatibilityPath,
  verifyBuildchainCompatibilityVerificationReceipt,
} from "../packages/core/buildchain-contract.js";
import { devDeliveryContentRoot } from "../packages/core/dev-delivery-common.js";

const root = path.resolve(import.meta.dirname, "..");
const fixturePath = path.join(
  root,
  "contracts/fixtures/v4-compatibility-facts-v1/shared.json",
);

function contractWorld() {
  return createBuildchainContractWorld({ root });
}

function syntheticFactInput({ id, source, target, cut, pull }) {
  return {
    proofId: id,
    surfaceId: "synthetic-surface",
    surfaceKind: "workflow",
    sourceBreakingDigest: source,
    targetBreakingDigest: target,
    evidence: {
      kind: "protected-pull-request-contract-acceptance",
      pullRequest: `https://github.com/kungfu-systems/buildchain/pull/${pull}`,
      protectedBase: "dev/v3/v3.0",
      sourceCommit: "1".repeat(40),
      mergeCommit: "2".repeat(40),
      contractDigest: `sha256:${"3".repeat(64)}`,
      compatibilityDigest: `sha256:${"4".repeat(64)}`,
    },
    authority: {
      kind: "protected-base-contract-authority",
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v3/v3.0",
    },
    cut: {
      kind: "protected-git-cut",
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v3/v3.0",
      commit: cut,
    },
  };
}

test("rooted parity inventory binds the exact v3 and v4 heads", () => {
  const matrix = JSON.parse(
    fs.readFileSync(
      path.join(root, "architecture/v4-compatibility-facts-parity.json"),
      "utf8",
    ),
  );
  const matrixRoot = matrix.matrixRoot;
  delete matrix.matrixRoot;
  assert.equal(devDeliveryContentRoot(matrix), matrixRoot);
  assert.equal(
    matrix.source.commit,
    "6b96bdad8d9f8ccf9275f27d9370a226a9c78465",
  );
  assert.equal(
    matrix.target.commit,
    "60e61d0a17bdf41262454a3499aae430248036fc",
  );
  assert.deepEqual(
    new Set(matrix.matrix.map((entry) => entry.invariant)),
    new Set([
      "immutable-directional-relation",
      "operation-scope",
      "time-awareness",
      "append-only-current-truth",
      "explicit-path",
      "negative-receipts",
      "legacy-digest-projection",
      "legacy-proof-projection",
      "release-passport",
      "unknown-state",
    ]),
  );
});

test("current v4 world derives legacy arrays only from exact-target Facts", () => {
  const world = contractWorld();
  assert.equal(world.compatibilityFacts.length, 9);
  assert.equal(world.compatibilityProofs.length, 9);
  assert.equal(assertBuildchainCompatibilityProjection(world).ok, true);
  assert.equal(
    verifyBuildchainCompatibilityFactRegistry(
      createBuildchainCompatibilityFactRegistry(),
    ).ok,
    true,
  );
  const projected = world.surfaces.filter(
    (surface) => surface.compatibilityFactRoots?.length,
  );
  assert.equal(
    projected.reduce(
      (count, surface) => count + surface.compatibilityFactRoots.length,
      0,
    ),
    8,
  );
  assert.equal(
    world.surfaces.find((surface) => surface.id === "release-candidate-promote")
      .compatibleBreakingDigests,
    undefined,
  );
  for (const surface of projected) {
    assert.equal(
      surface.compatibleBreakingDigests.length,
      surface.compatibilityProofRoots.length,
    );
    assert.equal(
      surface.compatibleBreakingDigests.length,
      surface.compatibilityFactRoots.length,
    );
  }
});

test("public v4 schema validates registries, queries, and receipts", () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/v4-compatibility-facts-v1.schema.json"),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const registry = createBuildchainCompatibilityFactRegistry();
  const fact = registry.facts[0];
  const query = createBuildchainCompatibilityPathQuery({
    registry,
    queryId: "schema-direct-query",
    sourceRoot: fact.sourceRoot,
    targetRoot: fact.targetRoot,
    relationPathRoots: [fact.factRoot],
  });
  const receipt = verifyBuildchainCompatibilityPath({ registry, query });
  assert.equal(validate(registry), true, JSON.stringify(validate.errors));
  assert.equal(validate(query), true, JSON.stringify(validate.errors));
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
});

test("Fact-less, tampered, or caller-asserted compatibility fails closed", () => {
  const current = contractWorld();
  const missing = structuredClone(current);
  delete missing.compatibilityFacts;
  assert.throws(
    () => finalizeBuildchainContractWorld(missing),
    /requires compatibility Facts/,
  );

  const tampered = structuredClone(current);
  const surface = tampered.surfaces.find(
    (entry) => entry.compatibleBreakingDigests?.length,
  );
  surface.compatibleBreakingDigests.push(`sha256:${"0".repeat(64)}`);
  assert.throws(
    () => assertBuildchainCompatibilityProjection(tampered),
    /projection mismatch/,
  );

  const registry = createBuildchainCompatibilityFactRegistry();
  registry.currentCut.commit = "0".repeat(40);
  assert.equal(
    verifyBuildchainCompatibilityFactRegistry(registry).reason,
    "registry-root-drift",
  );
});

test("contract admission binds the direct Fact and rooted v2 receipt", () => {
  const current = contractWorld();
  const lock = createBuildchainContractLock({
    buildchainRef: "v4-alpha",
    resolvedSha: "a".repeat(40),
    contractWorld: current,
  });
  const action = lock.buildchain.surfaces.find(
    (entry) => entry.id === "promote-buildchain-ref-action",
  );
  action.breakingDigest =
    "sha256:a59f0910e6df842e7699139472e5dd69ac2fdd7f7213bf2cb346d1d622556874";
  lock.buildchain.contractDigest = `sha256:${"1".repeat(64)}`;
  const result = evaluateBuildchainContractLock({
    lock,
    current,
    runtimeRef: "v4-alpha",
    runtimeSha: "b".repeat(40),
    runtimeClass: "alpha",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "compatible-drift");
  assert.equal(result.usedFactRoots.length, 1);
  assert.equal(result.usedProofRoots.length, 1);
  assert.equal(result.pathReceiptRoots.length, 1);
  assert.equal(
    result.compatibilityDecisions[0].pathReceipt.record.status,
    "accepted",
  );
  assert.equal(
    verifyBuildchainCompatibilityVerificationReceipt(result.verificationReceipt)
      .ok,
    true,
  );
});

test("supersede and revoke preserve old-Cut replay while changing current truth", () => {
  const source = `sha256:${"a".repeat(64)}`;
  const target = `sha256:${"b".repeat(64)}`;
  const inputs = [
    syntheticFactInput({
      id: "prior",
      source,
      target,
      cut: "5".repeat(40),
      pull: "4101",
    }),
    syntheticFactInput({
      id: "successor",
      source,
      target,
      cut: "6".repeat(40),
      pull: "4102",
    }),
  ];
  const registryCut = {
    kind: "protected-git-cut",
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    commit: "7".repeat(40),
  };
  const base = createBuildchainCompatibilityFactRegistry({
    factInputs: inputs,
    registryCut,
  });
  const prior = base.facts.find((fact) => fact.factId === "prior");
  const successor = base.facts.find((fact) => fact.factId === "successor");
  const supersession = {
    schema: "kungfu.fact.temporal-supersession/v1",
    priorRelationRoot: prior.factRoot,
    successorRelationRoot: successor.factRoot,
    effectiveCutRoot: successor.proof.cutRoot,
    reasonRoot: `sha256:${"d".repeat(64)}`,
    authorityRoot: prior.proof.authorityRoot,
    admissionRoots: [prior.proof.evidenceRoot],
  };
  const revocation = {
    schema: "kungfu.fact.temporal-revocation/v1",
    relationRoot: successor.factRoot,
    effectiveCutRoot: base.currentCutRoot,
    reasonRoot: `sha256:${"e".repeat(64)}`,
    authorityRoot: successor.proof.authorityRoot,
    admissionRoots: [successor.proof.evidenceRoot],
  };
  const registry = createBuildchainCompatibilityFactRegistry({
    factInputs: inputs,
    registryCut,
    supersessions: [supersession],
    revocations: [revocation],
  });
  const query = (fact, queryId) =>
    createBuildchainCompatibilityPathQuery({
      registry,
      queryId,
      sourceRoot: fact.sourceRoot,
      targetRoot: fact.targetRoot,
      relationPathRoots: [fact.factRoot],
    });
  const priorCurrent = verifyBuildchainCompatibilityPath({
    registry,
    query: query(prior, "prior-current"),
  });
  assert.equal(priorCurrent.record.failureCode, "relation-superseded");
  const priorOld = verifyBuildchainCompatibilityPath({
    registry,
    query: {
      ...query(prior, "prior-old"),
      cutRoot: prior.proof.cutRoot,
    },
  });
  assert.equal(priorOld.record.status, "accepted");
  const successorCurrent = verifyBuildchainCompatibilityPath({
    registry,
    query: query(successor, "successor-current"),
  });
  assert.equal(successorCurrent.record.failureCode, "relation-revoked");
  const successorOld = verifyBuildchainCompatibilityPath({
    registry,
    query: {
      ...query(successor, "successor-old"),
      cutRoot: successor.proof.cutRoot,
    },
  });
  assert.equal(successorOld.record.status, "accepted");
});

test("Rust and TypeScript emit byte-identical shared fixture projections", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const typescript = JSON.stringify({
    schema: "buildchain.v4.compatibility-facts-projection/v1",
    cases: fixture.cases.map(({ id, bundle, query }) => ({
      id,
      receipt: verifyBuildchainCompatibilityPath({
        registry: { temporalBundle: bundle },
        query,
      }),
    })),
  });
  const rust = execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "--manifest-path",
      "crates/buildchain-v4-contracts/Cargo.toml",
      "--",
      "compatibility-facts",
      path.relative(root, fixturePath),
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  assert.equal(rust, typescript);
  const cases = JSON.parse(typescript).cases;
  assert.deepEqual(
    cases.map((entry) => [
      entry.id,
      entry.receipt.record.status,
      entry.receipt.record.failureCode,
    ]),
    [
      ["positive-direct", "accepted", ""],
      ["positive-explicit-bounded-composition", "accepted", ""],
      ["negative-wrong-direction", "rejected", "direction-mismatch"],
      ["negative-wrong-cut", "rejected", "orphan-root"],
      ["negative-disconnected-path", "rejected", "path-missing"],
      ["negative-unscoped-operation", "rejected", "unscoped-compatibility"],
      ["temporal-not-yet-valid", "rejected", "relation-not-yet-valid"],
      ["temporal-superseded", "rejected", "relation-superseded"],
      ["temporal-expired-by-revocation", "rejected", "relation-revoked"],
      ["corruption-ambiguous-root", "rejected", "ambiguous-root"],
    ],
  );
});

test("Release Passport attachment exposes lineage without release authority", () => {
  const world = contractWorld();
  const evidence = createBuildchainCompatibilityReleaseEvidence({
    contractWorld: world,
    release: {
      sourceSha: "a".repeat(40),
      tag: "v4.0.1-alpha.3",
      channel: "alpha",
    },
  });
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.id, "buildchain-compatibility-facts");
  assert.equal(evidence.compatibility.grantsReleaseAuthority, false);
  assert.equal(
    evidence.compatibility.factRegistryRoot,
    world.compatibilityFactRegistryRoot,
  );
  assert.match(evidence.evidenceRoot, /^sha256:[0-9a-f]{64}$/);
});

test("compatibility CLI projects, verifies, templates, and rejects bad paths", () => {
  const cli = path.join(root, "bin/buildchain.mjs");
  const projected = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, "facts", "compatibility", "project", "--json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  );
  assert.equal(projected.authority, "Fact-registry-only");
  assert.equal(projected.grantsReleaseAuthority, false);
  const verified = JSON.parse(
    execFileSync(
      process.execPath,
      [cli, "facts", "compatibility", "verify", "--json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    ),
  );
  assert.equal(verified.ok, true);

  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-compat-facts-"),
  );
  try {
    const fact = projected.registry.facts[0];
    const query = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          "facts",
          "compatibility",
          "query-template",
          "--fact-root",
          fact.factRoot,
          "--json",
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    query.sourceRoot = query.targetRoot;
    const queryPath = path.join(temp, "query.json");
    const registryPath = path.join(temp, "registry.json");
    fs.writeFileSync(queryPath, JSON.stringify(query));
    fs.writeFileSync(registryPath, JSON.stringify(projected.registry));
    const rejected = spawnSync(
      process.execPath,
      [
        cli,
        "facts",
        "compatibility",
        "query",
        "--query",
        queryPath,
        "--registry",
        registryPath,
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(rejected.status, 1);
    assert.equal(
      JSON.parse(rejected.stdout).record.failureCode,
      "direction-mismatch",
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

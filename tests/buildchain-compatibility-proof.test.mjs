import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA,
  BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA,
  assertBuildchainCompatibilityProjection,
  createBuildchainCompatibilityFactRegistry,
  createBuildchainCompatibilityPathQuery,
  createBuildchainCompatibilityProofRegistry,
  createBuildchainContractLock,
  createBuildchainContractWorld,
  createHistoricalBuildchainCompatibilityProofs,
  evaluateBuildchainContractLock,
  finalizeBuildchainContractWorld,
  resolveBuildchainCompatibilityProof,
  verifyBuildchainCompatibilityPath,
  verifyBuildchainCompatibilityProof,
  verifyBuildchainCompatibilityVerificationReceipt,
} from "../packages/core/buildchain-contract.js";
import { kungfuTemporalRecordRoot } from "../packages/core/kungfu-temporal-fact.js";

const root = path.resolve(import.meta.dirname, "..");

function contractWorld() {
  return createBuildchainContractWorld({
    root,
    packageJson: { name: "@kungfu-tech/buildchain", version: "3.0.6-alpha.0" },
  });
}

test("historical compatibility relations are immutable direct proofs", () => {
  const proofs = createHistoricalBuildchainCompatibilityProofs();

  assert.equal(proofs.length, 9);
  assert.equal(new Set(proofs.map((proof) => proof.proofRoot)).size, 9);
  for (const proof of proofs) {
    assert.equal(proof.schema, BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA);
    assert.equal(proof.direction, "source-to-target");
    assert.equal(proof.operation, "accept-contract-lock");
    assert.notEqual(proof.source.breakingDigest, proof.target.breakingDigest);
    assert.match(
      proof.evidence.pullRequest,
      /^https:\/\/github\.com\/kungfu-systems\/buildchain\/pull\/\d+$/,
    );
    assert.equal(proof.authority.protectedBase, "dev/v3/v3.0");
    const historicalCuts = {
      "controller:build-channel-router":
        "34fad9d3a94c450d75c0d06fd6ed00470c992ff7",
      "reusable-build": "71a75f21159b994241ec7cb2c50f7a150c5d440b",
      "web-surface": "71a75f21159b994241ec7cb2c50f7a150c5d440b",
      "controller:release-propagation":
        "487ee09ca4832ffd15607db00060df4c0839fbae",
    };
    assert.equal(
      proof.cut.commit,
      historicalCuts[proof.source.surfaceId] ||
        "ff0f9006be1c8f63be40e67789e0cfd28fd69d46",
    );
    assert.equal(verifyBuildchainCompatibilityProof(proof).ok, true);
  }

  const controllerProofs = proofs.filter(
    (proof) => proof.source.surfaceId === "controller:build-lifecycle",
  );
  assert.equal(controllerProofs.length, 2);
  assert.ok(
    controllerProofs.every(
      (proof) =>
        proof.target.breakingDigest ===
        "sha256:6b8d38e92b2c67b5bc83fae0a3fd95bfa47582fbc176e6cdeebe7630a57534cb",
    ),
  );

  const routerProof = proofs.find(
    (proof) => proof.source.surfaceId === "controller:build-channel-router",
  );
  assert.equal(
    routerProof.source.breakingDigest,
    "sha256:d40dd05d7e07473d4b2dc1b62fbb0ed6f06449b4d3a7c44a2e8014313e3c0273",
  );
  assert.equal(
    routerProof.target.breakingDigest,
    "sha256:30549aa26cd1e1dd81f10fe3529d3c6e3f8438a6efa0100c47ebae4d2f3d71df",
  );
  assert.equal(
    routerProof.evidence.pullRequest,
    "https://github.com/kungfu-systems/buildchain/pull/2549",
  );
  assert.equal(
    routerProof.cut.commit,
    "34fad9d3a94c450d75c0d06fd6ed00470c992ff7",
  );

  const tapProofs = proofs.filter((proof) =>
    [
      "reusable-build",
      "web-surface",
      "controller:release-propagation",
    ].includes(proof.source.surfaceId),
  );
  assert.equal(tapProofs.length, 3);
  assert.deepEqual(
    tapProofs.map((proof) => proof.evidence.pullRequest).sort(),
    [
      "https://github.com/kungfu-systems/buildchain/pull/2089",
      "https://github.com/kungfu-systems/buildchain/pull/2089",
      "https://github.com/kungfu-systems/buildchain/pull/2143",
    ],
  );
});

test("legacy digest lists are deterministic proof-backed projections", () => {
  const first = contractWorld();
  const second = contractWorld();

  assert.equal(
    first.compatibilityProofRegistryRoot,
    second.compatibilityProofRegistryRoot,
  );
  assert.deepEqual(first.compatibilityProofs, second.compatibilityProofs);
  assert.equal(assertBuildchainCompatibilityProjection(first).ok, true);

  const tampered = structuredClone(first);
  const surface = tampered.surfaces.find(
    (entry) => entry.id === "promote-buildchain-ref-action",
  );
  surface.compatibleBreakingDigests.push(`sha256:${"0".repeat(64)}`);
  assert.throws(
    () => assertBuildchainCompatibilityProjection(tampered),
    /compatibleBreakingDigests projection mismatch/,
  );
});

test("contract locks and compatibility receipts bind the proof roots used", () => {
  const current = contractWorld();
  const lock = createBuildchainContractLock({
    buildchainRef: "v3-alpha",
    resolvedSha: "a".repeat(40),
    contractWorld: current,
  });
  const acceptedSurface = lock.buildchain.surfaces.find(
    (entry) => entry.id === "promote-buildchain-ref-action",
  );
  acceptedSurface.breakingDigest =
    "sha256:a59f0910e6df842e7699139472e5dd69ac2fdd7f7213bf2cb346d1d622556874";
  lock.buildchain.contractDigest = `sha256:${"1".repeat(64)}`;

  const evaluation = evaluateBuildchainContractLock({
    lock,
    current,
    runtimeRef: "v3-alpha",
    runtimeSha: "b".repeat(40),
    runtimeClass: "alpha",
  });

  assert.equal(
    lock.buildchain.compatibilityProofRegistryRoot,
    current.compatibilityProofRegistryRoot,
  );
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.status, "compatible-drift");
  assert.equal(evaluation.usedProofRoots.length, 1);
  assert.equal(
    evaluation.verificationReceipt.schema,
    BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA,
  );
  assert.deepEqual(
    evaluation.verificationReceipt.usedProofRoots,
    evaluation.usedProofRoots,
  );
  assert.equal(
    verifyBuildchainCompatibilityVerificationReceipt(
      evaluation.verificationReceipt,
    ).ok,
    true,
  );

  const [decision] = evaluation.compatibilityDecisions;
  assert.equal(decision.direction, "source-to-target");
  assert.equal(decision.scope.operation, "accept-contract-lock");
  assert.equal(
    decision.evidence.kind,
    "protected-pull-request-contract-acceptance",
  );
  assert.equal(decision.authority.kind, "protected-base-contract-authority");
  assert.equal(decision.cut.kind, "protected-git-cut");
  assert.equal(decision.proofRoot, evaluation.usedProofRoots[0]);
});

test("unknown breaking drift fails closed with a rooted negative receipt", () => {
  const current = contractWorld();
  const lock = createBuildchainContractLock({
    buildchainRef: "v3-alpha",
    resolvedSha: "a".repeat(40),
    contractWorld: current,
  });
  const acceptedSurface = lock.buildchain.surfaces.find(
    (entry) => entry.id === "promote-buildchain-ref-action",
  );
  acceptedSurface.breakingDigest = `sha256:${"0".repeat(64)}`;
  lock.buildchain.contractDigest = `sha256:${"1".repeat(64)}`;

  const evaluation = evaluateBuildchainContractLock({
    lock,
    current,
    runtimeRef: "v3-alpha",
    runtimeSha: "b".repeat(40),
    runtimeClass: "alpha",
  });

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.status, "breaking-drift");
  assert.deepEqual(evaluation.usedProofRoots, []);
  assert.match(evaluation.reasons.join("\n"), /compatibility-proof-missing/);
  assert.equal(
    verifyBuildchainCompatibilityVerificationReceipt(
      evaluation.verificationReceipt,
    ).ok,
    true,
  );

  const tampered = structuredClone(evaluation.verificationReceipt);
  tampered.compatible = true;
  assert.equal(
    verifyBuildchainCompatibilityVerificationReceipt(tampered).reason,
    "receipt-root-drift",
  );
});

test("proof root drift cannot be projected as compatibility authority", () => {
  const [proof] = createHistoricalBuildchainCompatibilityProofs();
  const tampered = structuredClone(proof);
  tampered.cut.commit = "0".repeat(40);

  assert.equal(
    verifyBuildchainCompatibilityProof(tampered).reason,
    "proof-root-drift",
  );
});

test("historical authority loads from a rooted Fact source without a JavaScript acceptance table", () => {
  const current = contractWorld();
  const source = fs.readFileSync(
    path.join(root, "packages/core/buildchain-compatibility-proof.js"),
    "utf8",
  );

  assert.doesNotMatch(source, /HISTORICAL_ACCEPTANCES/);
  assert.equal(current.compatibilityFacts.length, 9);
  assert.match(current.compatibilityFactRegistryRoot, /^sha256:[0-9a-f]{64}$/);
  assert.match(current.compatibilityFactCutRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    new Set(current.compatibilityFacts.map((fact) => fact.factRoot)).size,
    9,
  );
  assert.equal(
    current.surfaces
      .flatMap((surface) => surface.compatibilityFactRoots || [])
      .every((factRoot) =>
        current.compatibilityFacts.some((fact) => fact.factRoot === factRoot),
      ),
    true,
  );
});

test("a contract world without compatibility Facts fails closed", () => {
  const current = contractWorld();
  const missing = structuredClone(current);
  delete missing.compatibilityFacts;
  delete missing.compatibilityFactRegistryRoot;
  delete missing.compatibilityFactCutRoot;

  assert.throws(
    () => assertBuildchainCompatibilityProjection(missing),
    /compatibility Facts/,
  );
  assert.throws(
    () => finalizeBuildchainContractWorld(missing),
    /requires compatibility Facts/,
  );
});

function factInput({ id, source, target, cut, pull = "3000" }) {
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

test("KFR2 roots match the independent Kungfu temporal predicate vector", () => {
  assert.equal(
    kungfuTemporalRecordRoot({
      schema: "kungfu.fact.temporal-predicate/v1",
      predicateId: "kungfu.buildchain.compatibility:accept-contract-lock/v1",
      operations: ["accept-contract-lock"],
      direction: "source-to-target",
      pathPolicy: "explicit-bounded",
      cyclePolicy: "forbid",
      authorityRoot:
        "sha256:6908bf14a35e1ad7d0b865cb776744b789d1b41a0920d2160ef374febb4e24ea",
    }),
    "sha256:2b211f8251b0410b178f1f579d9bda9aa707877cc05c1ee839a3343f0f2307c9",
  );
});

test("compatibility is direct by default and composes only through an explicit bounded path receipt", () => {
  const digestA = `sha256:${"a".repeat(64)}`;
  const digestB = `sha256:${"b".repeat(64)}`;
  const digestC = `sha256:${"c".repeat(64)}`;
  const registry = createBuildchainCompatibilityFactRegistry({
    factInputs: [
      factInput({
        id: "a-to-b",
        source: digestA,
        target: digestB,
        cut: "5".repeat(40),
        pull: "3001",
      }),
      factInput({
        id: "b-to-c",
        source: digestB,
        target: digestC,
        cut: "6".repeat(40),
        pull: "3002",
      }),
    ],
    registryCut: {
      kind: "protected-git-cut",
      repository: "kungfu-systems/buildchain",
      protectedBase: "dev/v3/v3.0",
      commit: "7".repeat(40),
    },
  });
  const [first, second] = registry.facts.sort((left, right) =>
    left.proof.source.breakingDigest.localeCompare(
      right.proof.source.breakingDigest,
    ),
  );
  const query = createBuildchainCompatibilityPathQuery({
    registry,
    queryId: "explicit-a-to-c",
    sourceRoot: first.sourceRoot,
    targetRoot: second.targetRoot,
    relationPathRoots: [first.factRoot, second.factRoot],
    maxDepth: 2,
  });
  const accepted = verifyBuildchainCompatibilityPath({ registry, query });
  assert.equal(accepted.record.status, "accepted");
  assert.match(accepted.root, /^sha256:[0-9a-f]{64}$/);

  const directRegistry = createBuildchainCompatibilityProofRegistry({
    proofs: registry.legacyProofs,
    surfaces: [
      { id: "synthetic-surface", kind: "workflow", breakingDigest: digestC },
    ],
    majorLine: "v3",
  });
  const rejected = resolveBuildchainCompatibilityProof({
    registry: directRegistry,
    surface: {
      id: "synthetic-surface",
      kind: "workflow",
      breakingDigest: digestC,
    },
    sourceBreakingDigest: digestA,
    majorLine: "v3",
  });
  assert.equal(rejected.reason, "compatibility-proof-missing");

  const reversed = verifyBuildchainCompatibilityPath({
    registry,
    query: {
      ...query,
      queryId: "reverse-c-to-a",
      sourceRoot: second.targetRoot,
      targetRoot: first.sourceRoot,
    },
  });
  assert.equal(reversed.record.failureCode, "direction-mismatch");
});

test("supersession and revocation append new Facts while old Cuts replay the prior decision", () => {
  const source = `sha256:${"a".repeat(64)}`;
  const target = `sha256:${"b".repeat(64)}`;
  const inputs = [
    factInput({
      id: "prior",
      source,
      target,
      cut: "1".repeat(40),
      pull: "3010",
    }),
    factInput({
      id: "successor",
      source,
      target,
      cut: "2".repeat(40),
      pull: "3011",
    }),
  ];
  const registryCut = {
    kind: "protected-git-cut",
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    commit: "3".repeat(40),
  };
  const base = createBuildchainCompatibilityFactRegistry({
    factInputs: inputs,
    registryCut,
  });
  const prior = base.facts.find((fact) => fact.factId === "prior");
  const successor = base.facts.find((fact) => fact.factId === "successor");
  const reasonRoot = `sha256:${"d".repeat(64)}`;
  const supersession = {
    schema: "kungfu.fact.temporal-supersession/v1",
    priorRelationRoot: prior.factRoot,
    successorRelationRoot: successor.factRoot,
    effectiveCutRoot: successor.proof.cutRoot,
    reasonRoot,
    authorityRoot: prior.proof.authorityRoot,
    admissionRoots: [prior.proof.evidenceRoot],
  };
  const revocation = {
    schema: "kungfu.fact.temporal-revocation/v1",
    relationRoot: successor.factRoot,
    effectiveCutRoot: base.currentCutRoot,
    reasonRoot,
    authorityRoot: successor.proof.authorityRoot,
    admissionRoots: [successor.proof.evidenceRoot],
  };
  const registry = createBuildchainCompatibilityFactRegistry({
    factInputs: inputs,
    registryCut,
    supersessions: [supersession],
    revocations: [revocation],
  });
  const priorQuery = createBuildchainCompatibilityPathQuery({
    registry,
    queryId: "prior-current",
    sourceRoot: prior.sourceRoot,
    targetRoot: prior.targetRoot,
    relationPathRoots: [prior.factRoot],
  });
  assert.equal(
    verifyBuildchainCompatibilityPath({ registry, query: priorQuery }).record
      .failureCode,
    "relation-superseded",
  );
  assert.equal(
    verifyBuildchainCompatibilityPath({
      registry,
      query: {
        ...priorQuery,
        queryId: "prior-old-cut",
        cutRoot: prior.proof.cutRoot,
      },
    }).record.status,
    "accepted",
  );
  const successorQuery = createBuildchainCompatibilityPathQuery({
    registry,
    queryId: "successor-current",
    sourceRoot: successor.sourceRoot,
    targetRoot: successor.targetRoot,
    relationPathRoots: [successor.factRoot],
  });
  assert.equal(
    verifyBuildchainCompatibilityPath({ registry, query: successorQuery })
      .record.failureCode,
    "relation-revoked",
  );
  assert.equal(
    verifyBuildchainCompatibilityPath({
      registry,
      query: {
        ...successorQuery,
        queryId: "successor-old-cut",
        cutRoot: successor.proof.cutRoot,
      },
    }).record.status,
    "accepted",
  );
});

test("Fact lifecycle cycles and orphan Fact projections fail closed", () => {
  const inputs = [
    factInput({
      id: "first",
      source: `sha256:${"a".repeat(64)}`,
      target: `sha256:${"b".repeat(64)}`,
      cut: "1".repeat(40),
      pull: "3020",
    }),
    factInput({
      id: "second",
      source: `sha256:${"a".repeat(64)}`,
      target: `sha256:${"b".repeat(64)}`,
      cut: "2".repeat(40),
      pull: "3021",
    }),
  ];
  const registryCut = {
    kind: "protected-git-cut",
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    commit: "3".repeat(40),
  };
  const base = createBuildchainCompatibilityFactRegistry({
    factInputs: inputs,
    registryCut,
  });
  const [first, second] = base.facts;
  const lifecycle = (prior, successor) => ({
    schema: "kungfu.fact.temporal-supersession/v1",
    priorRelationRoot: prior.factRoot,
    successorRelationRoot: successor.factRoot,
    effectiveCutRoot: successor.proof.cutRoot,
    reasonRoot: `sha256:${"e".repeat(64)}`,
    authorityRoot: prior.proof.authorityRoot,
    admissionRoots: [prior.proof.evidenceRoot],
  });
  const cyclic = createBuildchainCompatibilityFactRegistry({
    factInputs: inputs,
    registryCut,
    supersessions: [lifecycle(first, second), lifecycle(second, first)],
  });
  const query = createBuildchainCompatibilityPathQuery({
    registry: cyclic,
    queryId: "cycle",
    sourceRoot: first.sourceRoot,
    targetRoot: first.targetRoot,
    relationPathRoots: [first.factRoot],
  });
  assert.equal(
    verifyBuildchainCompatibilityPath({ registry: cyclic, query }).record
      .failureCode,
    "forbidden-cycle",
  );

  const current = contractWorld();
  const orphan = structuredClone(current);
  orphan.surfaces
    .find((surface) => surface.compatibilityFactRoots?.length)
    .compatibilityFactRoots.push(`sha256:${"0".repeat(64)}`);
  assert.throws(
    () => assertBuildchainCompatibilityProjection(orphan),
    /compatibilityFactRoots projection mismatch/,
  );
});

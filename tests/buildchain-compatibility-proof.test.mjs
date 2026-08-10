import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA,
  BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA,
  assertBuildchainCompatibilityProjection,
  createBuildchainContractLock,
  createBuildchainContractWorld,
  createHistoricalBuildchainCompatibilityProofs,
  evaluateBuildchainContractLock,
  verifyBuildchainCompatibilityProof,
  verifyBuildchainCompatibilityVerificationReceipt,
} from "../packages/core/buildchain-contract.js";

const root = path.resolve(import.meta.dirname, "..");

function contractWorld() {
  return createBuildchainContractWorld({
    root,
    packageJson: { name: "@kungfu-tech/buildchain", version: "3.0.6-alpha.0" },
  });
}

test("historical compatibility relations are immutable direct proofs", () => {
  const proofs = createHistoricalBuildchainCompatibilityProofs();

  assert.equal(proofs.length, 5);
  assert.equal(new Set(proofs.map((proof) => proof.proofRoot)).size, 5);
  for (const proof of proofs) {
    assert.equal(proof.schema, BUILDCHAIN_COMPATIBILITY_PROOF_SCHEMA);
    assert.equal(proof.direction, "source-to-target");
    assert.equal(proof.operation, "accept-contract-lock");
    assert.notEqual(proof.source.breakingDigest, proof.target.breakingDigest);
    assert.match(proof.evidence.pullRequest, /^https:\/\/github\.com\/kungfu-systems\/buildchain\/pull\/\d+$/);
    assert.equal(proof.authority.protectedBase, "dev/v3/v3.0");
    assert.equal(proof.cut.commit, "ff0f9006be1c8f63be40e67789e0cfd28fd69d46");
    assert.equal(verifyBuildchainCompatibilityProof(proof).ok, true);
  }

  const controllerProofs = proofs.filter((proof) => proof.source.surfaceId === "controller:build-lifecycle");
  assert.equal(controllerProofs.length, 2);
  assert.ok(controllerProofs.every((proof) => proof.target.breakingDigest === "sha256:6b8d38e92b2c67b5bc83fae0a3fd95bfa47582fbc176e6cdeebe7630a57534cb"));
});

test("legacy digest lists are deterministic proof-backed projections", () => {
  const first = contractWorld();
  const second = contractWorld();

  assert.equal(first.compatibilityProofRegistryRoot, second.compatibilityProofRegistryRoot);
  assert.deepEqual(first.compatibilityProofs, second.compatibilityProofs);
  assert.equal(assertBuildchainCompatibilityProjection(first).ok, true);

  const tampered = structuredClone(first);
  const surface = tampered.surfaces.find((entry) => entry.id === "promote-buildchain-ref-action");
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
  const acceptedSurface = lock.buildchain.surfaces.find((entry) => entry.id === "promote-buildchain-ref-action");
  acceptedSurface.breakingDigest = "sha256:a59f0910e6df842e7699139472e5dd69ac2fdd7f7213bf2cb346d1d622556874";
  lock.buildchain.contractDigest = `sha256:${"1".repeat(64)}`;

  const evaluation = evaluateBuildchainContractLock({
    lock,
    current,
    runtimeRef: "v3-alpha",
    runtimeSha: "b".repeat(40),
    runtimeClass: "alpha",
  });

  assert.equal(lock.buildchain.compatibilityProofRegistryRoot, current.compatibilityProofRegistryRoot);
  assert.equal(evaluation.ok, true);
  assert.equal(evaluation.status, "compatible-drift");
  assert.equal(evaluation.usedProofRoots.length, 1);
  assert.equal(evaluation.verificationReceipt.schema, BUILDCHAIN_COMPATIBILITY_VERIFICATION_RECEIPT_SCHEMA);
  assert.deepEqual(evaluation.verificationReceipt.usedProofRoots, evaluation.usedProofRoots);
  assert.equal(verifyBuildchainCompatibilityVerificationReceipt(evaluation.verificationReceipt).ok, true);

  const [decision] = evaluation.compatibilityDecisions;
  assert.equal(decision.direction, "source-to-target");
  assert.equal(decision.scope.operation, "accept-contract-lock");
  assert.equal(decision.evidence.kind, "protected-pull-request-contract-acceptance");
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
  const acceptedSurface = lock.buildchain.surfaces.find((entry) => entry.id === "promote-buildchain-ref-action");
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
  assert.equal(verifyBuildchainCompatibilityVerificationReceipt(evaluation.verificationReceipt).ok, true);

  const tampered = structuredClone(evaluation.verificationReceipt);
  tampered.compatible = true;
  assert.equal(verifyBuildchainCompatibilityVerificationReceipt(tampered).reason, "receipt-root-drift");
});

test("proof root drift cannot be projected as compatibility authority", () => {
  const [proof] = createHistoricalBuildchainCompatibilityProofs();
  const tampered = structuredClone(proof);
  tampered.cut.commit = "0".repeat(40);

  assert.equal(verifyBuildchainCompatibilityProof(tampered).reason, "proof-root-drift");
});

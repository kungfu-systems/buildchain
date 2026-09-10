import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { activateExactPnpm } from "../packages/core/release/promote-candidate/product-provider.js";

import { sha256Json } from "../packages/core/release/release-candidate.js";

import { resolveCandidateBuildSummaryPath, resolveCandidateProviderInputs, resolvePublicationTarget } from "../packages/core/release/promote-candidate/evidence-inputs.js";

test("promotion requires declared evidence paths even when neighboring artifacts exist", () => {
  const { candidatePassportPath } = recoveredPromotionFixture();
  assert.throws(() => resolveCandidateBuildSummaryPath({ candidatePassportPath }), /candidate-build-summary-path is required/);
  assert.equal(resolveCandidateBuildSummaryPath({ declaredPath: "evidence/build-summary.json" }), "evidence/build-summary.json");
  const input = { artifactKind: "npm", sealedBundleRoot: "payloads", sealedBundleManifest: "sealed.json", requiredArtifactsPath: "required.json", publishPackageMain: "@scope/pkg" };
  for (const field of ["sealedBundleRoot", "sealedBundleManifest", "requiredArtifactsPath"])
    assert.throws(() => resolveCandidateProviderInputs({ ...input, [field]: "", candidatePassportPath }), /is required/);
  assert.equal(resolveCandidateProviderInputs(input).releaseCandidateRecoveryReceiptPath, "");
  assert.equal(resolveCandidateProviderInputs({ ...input, recoveryReceiptPath: "admitted/receipt.json" }).releaseCandidateRecoveryReceiptPath, "admitted/receipt.json");
});

test("sealed artifact metadata selects a unique npm main; ambiguous metadata is rejected", () => {
  const { recoveryReceiptPath } = recoveredPromotionFixture();
  const requiredArtifactsPath = path.join(path.dirname(recoveryReceiptPath), "required.json");
  const input = { sealedBundleRoot: "payloads", sealedBundleManifest: "sealed.json", requiredArtifactsPath };
  for (const artifact of [{ name: "@scope/pkg", role: "main" }, { name: "@scope/pkg", kind: "npm", required: true }]) {
    fs.writeFileSync(requiredArtifactsPath, JSON.stringify([artifact]));
    assert.equal(resolveCandidateProviderInputs(input).publishPackageMain, "@scope/pkg");
  }
  fs.writeFileSync(requiredArtifactsPath, JSON.stringify([{ name: "a", role: "main" }, { name: "b", role: "main" }]));
  assert.throws(() => resolveCandidateProviderInputs(input), /Unique main package/);
  assert.deepEqual(resolveCandidateProviderInputs({ artifactKind: "custom", requiredArtifactsPath }), {
    sealedBundleRoot: "", sealedBundleManifest: "", requiredArtifactsPath,
    publishPackageMain: "", releaseCandidateRecoveryReceiptPath: "",
  });
});

function recoveryRequest() {
  const { candidate, recoveryReceipt, recoveryReceiptPath } = recoveredPromotionFixture();
  return { candidate, repository: candidate.repository, channel: "alpha", recoveryReceiptPath,
    sourceSha: recoveryReceipt.target.sha, targetSha: recoveryReceipt.target.sha,
    targetRef: recoveryReceipt.target.ref, expectedTransactionId: recoveryReceipt.transaction.identity };
}

test("promotion validates explicit target and rooted recovery transaction together", () => {
  const request = recoveryRequest();
  assert.deepEqual(resolvePublicationTarget(request), { sourceSha: request.targetSha, targetSha: request.targetSha, targetRef: request.targetRef });
  assert.throws(() => resolvePublicationTarget({ ...request, targetRef: "alpha/v4/v4.1" }), /target ref mismatch/);
  assert.throws(() => resolvePublicationTarget({ ...request, expectedTransactionId: "drifted" }), /transaction identity mismatch/);
  assert.throws(() => resolvePublicationTarget({ ...request, sourceSha: request.candidate.source.headSha }), /exact protected target-sha/);
  assert.throws(() => resolvePublicationTarget({ ...request, recoveryReceiptPath: "" }), /requires recovery-receipt-path/);
  const receipt = JSON.parse(fs.readFileSync(request.recoveryReceiptPath, "utf8"));
  receipt.payloadBytes = "changed";
  fs.writeFileSync(request.recoveryReceiptPath, JSON.stringify(receipt));
  assert.throws(() => resolvePublicationTarget(request), /Recovery receipt is invalid/);
});

test("promotion never infers absent target coordinates from recovery evidence or a merged PR", () => {
  const request = recoveryRequest();
  for (const field of ["targetRef", "targetSha"])
    assert.throws(() => resolvePublicationTarget({ ...request, [field]: "", octokit: { rest: { pulls: { get() { assert.fail("No inferred PR lookup"); } } } } }), /target-(ref|sha) is required/);
  assert.deepEqual(resolvePublicationTarget({ ...request, expectedTransactionId: "", recoveryReceiptPath: "" }),
    { sourceSha: request.targetSha, targetSha: request.targetSha, targetRef: request.targetRef });
});
function recoveredPromotionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-promote-"));
  const candidatePassportPath = path.join(
    root,
    "sealed-candidate",
    "artifacts",
    "candidate",
    "release-candidate-passport.json",
  );
  const candidate = {
    repository: "kungfu-systems/buildchain",
    candidateHash: "a".repeat(64),
    source: { headSha: "1".repeat(40), treeHash: "2".repeat(40) },
  };
  const recoveryReceipt = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-recovery/v1",
    action: "reused",
    repository: candidate.repository,
    originalCandidate: {
      sourceSha: candidate.source.headSha,
      tree: candidate.source.treeHash,
    },
    target: {
      channel: "alpha",
      ref: "alpha/v4/v4.0",
      sha: "3".repeat(40),
      tree: candidate.source.treeHash,
      version: "4.0.2-alpha.3",
    },
    recovered: { candidateRoot: `sha256:${candidate.candidateHash}` },
    skippedBuildStages: ["install", "build", "verify", "platform-matrix"],
    payloadBytes: "unchanged",
    transaction: {
      identity: "transaction-exact",
      state: "publishing",
      publicationState: "publishing",
    },
  };
  recoveryReceipt.root = `sha256:${sha256Json(recoveryReceipt)}`;
  fs.mkdirSync(path.dirname(candidatePassportPath), { recursive: true });
  fs.writeFileSync(candidatePassportPath, `${JSON.stringify(candidate)}\n`);
  fs.writeFileSync(
    path.join(root, "recovery-receipt.json"),
    `${JSON.stringify(recoveryReceipt)}\n`,
  );
  return { candidatePassportPath, candidate, recoveryReceipt, recoveryReceiptPath: path.join(root, "recovery-receipt.json") };
}

test("provider verification exposes only the pinned pnpm runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-promote-"));
  const previousPath = process.env.PATH;
  try {
    const shim = activateExactPnpm({ temporaryRoot: root });
    assert.equal(
      fs.readFileSync(shim, "utf8"),
      '#!/bin/sh\nexec corepack pnpm@11.7.0 "$@"\n',
    );
    assert.equal(
      fs.readFileSync(path.join(path.dirname(shim), "pnpm.cmd"), "utf8"),
      "@echo off\r\ncorepack pnpm@11.7.0 %*\r\n",
    );
    if (process.platform !== "win32")
      assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
    assert.equal(
      process.env.PATH?.split(path.delimiter)[0],
      path.dirname(shim),
    );
  } finally {
    process.env.PATH = previousPath;
  }
});

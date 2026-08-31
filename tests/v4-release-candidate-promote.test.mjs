import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateExactPnpm,
  resolveCandidateBuildSummaryPath,
  resolveCandidateProviderInputs,
  resolvePublicationTarget,
  resolvePromotionTarget,
} from "../actions/v4-release-candidate-promote/index.js";

import { sha256Json } from "../packages/core/release-candidate.js";

test("legacy promotion shells recover the standard sealed build summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(
    root,
    "passport",
    "release-candidate-passport.json",
  );
  const summary = path.join(root, "summary", "build-summary.json");
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(passport, "{}\n");
  fs.writeFileSync(summary, "{}\n");

  assert.equal(
    resolveCandidateBuildSummaryPath({ candidatePassportPath: passport }),
    summary,
  );
  assert.equal(
    resolveCandidateBuildSummaryPath({
      candidatePassportPath: passport,
      declaredPath: "explicit/build-summary.json",
    }),
    "explicit/build-summary.json",
  );
});

test("legacy promotion shells fail closed without the standard summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(
    root,
    "passport",
    "release-candidate-passport.json",
  );
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.writeFileSync(passport, "{}\n");

  assert.throws(
    () => resolveCandidateBuildSummaryPath({ candidatePassportPath: passport }),
    /candidate-build-summary-path is required/,
  );
});

test("legacy promotion shells recover standard sealed provider inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(root, "passport", "release-candidate-passport.json");
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.mkdirSync(path.join(root, "payloads"));
  fs.writeFileSync(path.join(root, "sealed-bundle.json"), "{}\n");
  fs.writeFileSync(path.join(root, "publish-required-artifacts.json"), `${JSON.stringify([{ name: "@kungfu-tech/buildchain", role: "main" }])}\n`);
  assert.deepEqual(resolveCandidateProviderInputs({ candidatePassportPath: passport }), {
    sealedBundleRoot: path.join(root, "payloads"),
    sealedBundleManifest: path.join(root, "sealed-bundle.json"),
    requiredArtifactsPath: path.join(root, "publish-required-artifacts.json"),
    publishPackageMain: "@kungfu-tech/buildchain",
  });
});

test("legacy promotion shells infer the only required npm package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(root, "passport", "release-candidate-passport.json");
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.mkdirSync(path.join(root, "payloads"));
  fs.writeFileSync(path.join(root, "sealed-bundle.json"), "{}\n");
  fs.writeFileSync(path.join(root, "publish-required-artifacts.json"), `${JSON.stringify([{ kind: "npm", name: "@kungfu-tech/buildchain", role: "platform", required: true }])}\n`);

  assert.equal(
    resolveCandidateProviderInputs({ candidatePassportPath: passport })
      .publishPackageMain,
    "@kungfu-tech/buildchain",
  );
});

test("candidate recovery passes the rooted sibling receipt to the product provider", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(root, "passport", "release-candidate-passport.json");
  const recoveryReceipt = path.join(root, "recovery-receipt.json");
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.mkdirSync(path.join(root, "payloads"));
  fs.writeFileSync(path.join(root, "sealed-bundle.json"), "{}\n");
  fs.writeFileSync(recoveryReceipt, "{}\n");
  fs.writeFileSync(path.join(root, "publish-required-artifacts.json"), `${JSON.stringify([{ name: "@kungfu-tech/buildchain", role: "main" }])}\n`);

  assert.equal(
    resolveCandidateProviderInputs({ candidatePassportPath: passport })
      .releaseCandidateRecoveryReceiptPath,
    recoveryReceipt,
  );
});

test("legacy promotion shells bind the exact merged PR target", async () => {
  const candidateSha = "1".repeat(40), mergeSha = "2".repeat(40);
  const result = await resolvePublicationTarget({
    octokit: { rest: { pulls: { get: async () => ({ data: { merged: true, merge_commit_sha: mergeSha, base: { ref: "alpha/v4/v4.0" } } }) } } },
    repository: "kungfu-systems/buildchain",
    candidate: { source: { headSha: candidateSha }, pullRequest: { number: "3322", baseRef: "alpha/v4/v4.0" } },
    sourceSha: candidateSha,
  });
  assert.deepEqual(result, { sourceSha: mergeSha, targetRef: "alpha/v4/v4.0", targetSha: mergeSha });
});

test("declared publication targets reject partial legacy bindings", async () => {
  await assert.rejects(resolvePublicationTarget({ repository: "kungfu-systems/buildchain", candidate: {}, sourceSha: "1".repeat(40), targetRef: "alpha/v4/v4.0" }), /matching target-ref, target-sha, and source-sha/);
});

test("legacy promotion shells fail closed on ambiguous build summaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const passport = path.join(
    root,
    "passport",
    "release-candidate-passport.json",
  );
  fs.mkdirSync(path.dirname(passport), { recursive: true });
  fs.writeFileSync(passport, "{}\n");
  for (const directory of ["summary-a", "summary-b"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "build-summary.json"), "{}\n");
  }
  assert.throws(
    () => resolveCandidateBuildSummaryPath({ candidatePassportPath: passport }),
    /ambiguous standard summary artifacts/,
  );
});

function recoveredPromotionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
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
  return { candidatePassportPath, candidate, recoveryReceipt };
}

test("legacy promotion shells recover the protected target from rooted evidence", () => {
  const { candidatePassportPath, candidate, recoveryReceipt } =
    recoveredPromotionFixture();
  assert.deepEqual(
    resolvePromotionTarget({
      candidatePassportPath,
      candidate,
      repository: candidate.repository,
      channel: "alpha",
      sourceSha: candidate.source.headSha,
    }),
    {
      targetRef: recoveryReceipt.target.ref,
      targetSha: recoveryReceipt.target.sha,
    },
  );
});

test("legacy promotion shells reject a drifted recovered target", () => {
  const { candidatePassportPath, candidate } = recoveredPromotionFixture();
  assert.throws(
    () =>
      resolvePromotionTarget({
        candidatePassportPath,
        candidate,
        repository: candidate.repository,
        channel: "alpha",
        sourceSha: candidate.source.headSha,
        declaredTargetRef: "alpha/v4/v4.1",
      }),
    /target ref mismatch/,
  );
});

test("legacy promotion shells bind an expected recovery transaction", () => {
  const { candidatePassportPath, candidate, recoveryReceipt } =
    recoveredPromotionFixture();
  assert.deepEqual(
    resolvePromotionTarget({
      candidatePassportPath,
      candidate,
      repository: candidate.repository,
      channel: "alpha",
      sourceSha: candidate.source.headSha,
      expectedTransactionId: recoveryReceipt.transaction.identity,
    }),
    {
      targetRef: recoveryReceipt.target.ref,
      targetSha: recoveryReceipt.target.sha,
    },
  );
  assert.throws(
    () =>
      resolvePromotionTarget({
        candidatePassportPath,
        candidate,
        repository: candidate.repository,
        channel: "alpha",
        sourceSha: candidate.source.headSha,
        expectedTransactionId: "transaction-drifted",
      }),
    /transaction identity mismatch/,
  );
});

test("fresh promotion shells require exact protected source coordinates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
  const candidatePassportPath = path.join(
    root,
    "sealed-candidate",
    "artifacts",
    "candidate",
    "release-candidate-passport.json",
  );
  const candidate = { source: { headSha: "1".repeat(40) } };
  fs.mkdirSync(path.dirname(candidatePassportPath), { recursive: true });
  assert.throws(
    () =>
      resolvePromotionTarget({
        candidatePassportPath,
        candidate,
        repository: "kungfu-systems/buildchain",
        channel: "alpha",
        sourceSha: candidate.source.headSha,
        declaredTargetRef: "alpha/v4/v4.0",
        declaredTargetSha: "3".repeat(40),
      }),
    /protected source SHA must equal target-sha/,
  );
});

test("provider verification exposes only the pinned pnpm runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-v4-promote-"));
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

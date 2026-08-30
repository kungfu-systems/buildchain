import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateExactPnpm,
  resolveCandidateBuildSummaryPath,
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
    assert.equal(fs.statSync(shim).mode & 0o777, 0o755);
    assert.equal(process.env.PATH?.split(path.delimiter)[0], path.dirname(shim));
  } finally {
    process.env.PATH = previousPath;
  }
});

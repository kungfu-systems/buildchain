import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCandidateBuildSummaryPath, resolveCandidateProviderInputs, resolvePublicationTarget } from "../actions/v4-release-candidate-promote/index.js";

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

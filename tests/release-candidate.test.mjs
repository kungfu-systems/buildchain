import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RELEASE_CANDIDATE_PASSPORT_CONTRACT,
  createReleaseCandidatePassport,
  validateReleaseCandidatePassport,
} from "../packages/core/release-candidate.js";
import { generateReleaseCandidatePassportCli } from "../scripts/generate-release-candidate-passport.mjs";

const SOURCE_SHA = "1111111111111111111111111111111111111111";

function sampleBuildSummary() {
  return {
    contract: "kungfu-buildchain-build-summary",
    artifactName: "libnode",
    git: {
      repository: "kungfu-systems/libnode",
      sha: SOURCE_SHA,
      ref: "refs/pull/42/merge",
      runId: "123",
      runAttempt: "1",
    },
    publishGate: {
      trustedEvent: true,
      channel: "alpha",
      allowed: true,
      reason: "channel",
    },
    publishSource: {
      ref: "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.7",
      sha: SOURCE_SHA,
      locked: true,
      channel: "alpha",
      line: "v22/v22.22",
      consumerVersion: "22.22.3-kf.3-alpha.7",
    },
    runtime: {
      workflowShellRef: "v2",
      ref: "train/v2/v2.4/rc-promote-feedback",
      sha: "2222222222222222222222222222222222222222",
      class: "train",
    },
    platforms: [
      {
        artifactName: "libnode-darwin-arm64",
        platform: { id: "macos-arm64", name: "macOS arm64" },
        summary: { fileCount: 2, totalBytes: 1234 },
        artifacts: [{ path: "dist/libnode.tgz", size: 1234, sha256: "abc" }],
        manifestPath: ".buildchain/artifacts/macos-arm64/manifest.json",
      },
    ],
  };
}

test("release candidate passport records source lock, platform matrix, and build summary hash", () => {
  const buildSummary = sampleBuildSummary();
  const passport = createReleaseCandidatePassport({
    repository: "kungfu-systems/libnode",
    targetChannel: "alpha",
    version: "22.22.3-kf.3-alpha.7",
    sourceHeadSha: SOURCE_SHA,
    buildSummary,
    createdAt: "2026-07-04T00:00:00.000Z",
  });

  assert.equal(passport.contract, RELEASE_CANDIDATE_PASSPORT_CONTRACT);
  assert.equal(passport.repository, "kungfu-systems/libnode");
  assert.equal(passport.target.channel, "alpha");
  assert.equal(passport.target.version, "22.22.3-kf.3-alpha.7");
  assert.equal(passport.source.headSha, SOURCE_SHA);
  assert.equal(passport.platformMatrix.length, 1);
  assert.equal(validateReleaseCandidatePassport({ passport, buildSummary }).ok, true);
});

test("release candidate validation rejects stale source and summary evidence", () => {
  const buildSummary = sampleBuildSummary();
  const passport = createReleaseCandidatePassport({
    repository: "kungfu-systems/libnode",
    targetChannel: "alpha",
    version: "22.22.3-kf.3-alpha.7",
    sourceHeadSha: SOURCE_SHA,
    buildSummary,
  });

  const staleSource = validateReleaseCandidatePassport({
    passport,
    sourceHeadSha: "3333333333333333333333333333333333333333",
    buildSummary,
  });
  assert.equal(staleSource.ok, false);
  assert.match(staleSource.errors.join("; "), /source head mismatch/);

  const staleSummary = validateReleaseCandidatePassport({
    passport,
    buildSummary: { ...buildSummary, totalBytes: 999 },
  });
  assert.equal(staleSummary.ok, false);
  assert.match(staleSummary.errors.join("; "), /build summary hash mismatch/);
});

test("generateReleaseCandidatePassportCli writes GitHub outputs for workflow reuse", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-rc-"));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  try {
    process.chdir(cwd);
    fs.mkdirSync(path.join(cwd, ".buildchain", "artifacts"), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, ".buildchain", "artifacts", "build-summary.json"),
      `${JSON.stringify(sampleBuildSummary(), null, 2)}\n`,
    );
    process.env = {
      ...previousEnv,
      GITHUB_REPOSITORY: "kungfu-systems/libnode",
      GITHUB_OUTPUT: path.join(cwd, "outputs.txt"),
    };

    const passport = generateReleaseCandidatePassportCli();
    const outputPath = path.join(cwd, ".buildchain", "artifacts", "release-candidate-passport.json");
    const outputs = fs.readFileSync(process.env.GITHUB_OUTPUT, "utf8");

    assert.equal(passport.contract, RELEASE_CANDIDATE_PASSPORT_CONTRACT);
    assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).candidateHash, passport.candidateHash);
    assert.match(outputs, /release-candidate-passport-path=/);
    assert.match(outputs, /release-candidate-passport-json=/);
  } finally {
    process.chdir(previousCwd);
    process.env = previousEnv;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

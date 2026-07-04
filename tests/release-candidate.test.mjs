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
import {
  generatePublishRequiredArtifacts,
  selectMergedChannelPullRequest,
  selectPayloadArtifacts,
  selectReleaseCandidateArtifacts,
  selectReleaseCandidateRun,
} from "../scripts/release-candidate-resolver.mjs";
import {
  buildWorkflowFrictionBody,
  selectFrictionClass,
} from "../scripts/workflow-friction-report.mjs";

const SOURCE_SHA = "1111111111111111111111111111111111111111";

function sampleBuildSummary() {
  return {
    contract: "kungfu-buildchain-build-summary",
    artifactName: "libnode",
    git: {
      repository: "kungfu-systems/libnode",
      sha: SOURCE_SHA,
      treeSha: "tree-source",
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
  assert.equal(passport.source.treeHash, "tree-source");
  assert.equal(passport.platformMatrix.length, 1);
  assert.equal(validateReleaseCandidatePassport({ passport, buildSummary }).ok, true);
});

test("release candidate passport derives channel from PR base when publish channel is none", () => {
  const buildSummary = sampleBuildSummary();
  const passport = createReleaseCandidatePassport({
    repository: "kungfu-systems/libnode",
    pullRequest: { baseRef: "alpha/v22/v22.22" },
    targetChannel: "none",
    version: "22.22.3-kf.3-alpha.7",
    sourceHeadSha: SOURCE_SHA,
    buildSummary,
  });
  assert.equal(passport.target.channel, "alpha");
  const legacyNone = {
    ...passport,
    target: { ...passport.target, channel: "none" },
  };
  assert.equal(validateReleaseCandidatePassport({ passport: legacyNone, targetChannel: "alpha" }).ok, true);
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

test("release candidate resolver selects same-repo merged PR run and paired artifacts", () => {
  const pullRequest = selectMergedChannelPullRequest({
    targetRef: "refs/heads/alpha/v22/v22.22",
    repository: "kungfu-systems/buildchain",
    pullRequests: [
      {
        number: 10,
        state: "open",
        base: { ref: "alpha/v22/v22.22" },
        head: { repo: { full_name: "kungfu-systems/buildchain" } },
      },
      {
        number: 11,
        state: "closed",
        merged_at: "2026-07-04T01:00:00.000Z",
        updated_at: "2026-07-04T01:00:00.000Z",
        base: { ref: "alpha/v22/v22.22" },
        head: { repo: { full_name: "kungfu-systems/buildchain" } },
      },
    ],
  });
  assert.equal(pullRequest.number, 11);

  const run = selectReleaseCandidateRun({
    pullRequest,
    workflowName: "Build Surface Fixture",
    runs: [
      { id: 1, name: "Build Surface Fixture", event: "pull_request", status: "completed", conclusion: "failure", pull_requests: [{ number: 11 }] },
      { id: 2, name: "Build Surface Fixture", event: "pull_request", status: "completed", conclusion: "success", updated_at: "2026-07-04T02:00:00.000Z", pull_requests: [{ number: 11 }] },
    ],
  });
  assert.equal(run.id, 2);

  const titledRun = selectReleaseCandidateRun({
    pullRequest,
    runs: [
      { id: 3, name: ".github/workflows/build-surface-fixture.yml", display_title: "Prepare v2.4.7-alpha.1", event: "pull_request", status: "completed", conclusion: "success", updated_at: "2026-07-04T03:00:00.000Z", pull_requests: [{ number: 11 }] },
    ],
  });
  assert.equal(titledRun.id, 3);

  const emptyPullRequestArrayRun = selectReleaseCandidateRun({
    pullRequest: {
      ...pullRequest,
      head: {
        ref: "buildchain/version-state/alpha-v2-v2.4/f68f8ea5a983",
        sha: "f68f8ea5a983d1a788436ef9d00a2c9efb1787b8",
        repo: { full_name: "kungfu-systems/buildchain" },
      },
    },
    runs: [
      {
        id: 4,
        name: "Build Surface Fixture",
        display_title: "Prepare v2.4.7-alpha.1",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-04T03:00:00.000Z",
        head_branch: "buildchain/version-state/alpha-v2-v2.4/f68f8ea5a983",
        head_sha: "f68f8ea5a983d1a788436ef9d00a2c9efb1787b8",
        head_repository: { full_name: "kungfu-systems/buildchain" },
        pull_requests: [],
      },
    ],
  });
  assert.equal(emptyPullRequestArrayRun.id, 4);

  const artifacts = selectReleaseCandidateArtifacts({
    artifacts: [
      { id: 1, name: `${"libnode"}-summary-${SOURCE_SHA}` },
      { id: 2, name: `${"libnode"}-release-candidate-${SOURCE_SHA}` },
    ],
  });
  assert.equal(artifacts.sourceSha, SOURCE_SHA);
  assert.equal(artifacts.summary.id, 1);
  assert.equal(artifacts.passport.id, 2);
});

test("release candidate resolver filters paired artifacts by artifact-name", () => {
  const artifacts = selectReleaseCandidateArtifacts({
    artifactName: "libnode",
    artifacts: [
      { id: 1, name: `other-summary-${SOURCE_SHA}` },
      { id: 2, name: `other-release-candidate-${SOURCE_SHA}` },
      { id: 3, name: `libnode-summary-${SOURCE_SHA}` },
      { id: 4, name: `libnode-release-candidate-${SOURCE_SHA}` },
    ],
  });

  assert.equal(artifacts.sourceSha, SOURCE_SHA);
  assert.equal(artifacts.summary.id, 3);
  assert.equal(artifacts.passport.id, 4);
  assert.throws(
    () => selectReleaseCandidateArtifacts({
      artifactName: "missing",
      artifacts: [
        { id: 1, name: `libnode-summary-${SOURCE_SHA}` },
        { id: 2, name: `libnode-release-candidate-${SOURCE_SHA}` },
      ],
    }),
    /expected exactly one release-candidate passport artifact for artifact-name missing, found 0/,
  );
});

test("release candidate resolver selects payload artifacts and generates publish requirements", () => {
  const payloads = selectPayloadArtifacts({
    artifactName: "libnode",
    sourceSha: SOURCE_SHA,
    artifacts: [
      { id: 1, name: `libnode-release-candidate-${SOURCE_SHA}` },
      { id: 2, name: `libnode-summary-${SOURCE_SHA}` },
      { id: 3, name: `libnode-manifest-linux-x64-${SOURCE_SHA}` },
      { id: 4, name: `libnode-manifest-darwin-arm64-${SOURCE_SHA}` },
      { id: 5, name: `libnode-diagnostics-linux-x64-${SOURCE_SHA}` },
      { id: 6, name: `other-manifest-linux-x64-${SOURCE_SHA}` },
    ],
  });
  assert.deepEqual(
    payloads.map((artifact) => artifact.name),
    [
      `libnode-manifest-darwin-arm64-${SOURCE_SHA}`,
      `libnode-manifest-linux-x64-${SOURCE_SHA}`,
    ],
  );

  const customPayloads = selectPayloadArtifacts({
    artifactName: "libnode",
    sourceSha: SOURCE_SHA,
    patterns: `libnode-diagnostics-*-${SOURCE_SHA}`,
    artifacts: [
      { id: 1, name: `libnode-manifest-linux-x64-${SOURCE_SHA}` },
      { id: 2, name: `libnode-diagnostics-linux-x64-${SOURCE_SHA}` },
    ],
  });
  assert.deepEqual(customPayloads.map((artifact) => artifact.id), [2]);

  const required = generatePublishRequiredArtifacts({
    version: "22.22.3-kf.3-alpha.7",
    manifests: [
      {
        artifactName: "libnode-linux-x64",
        platform: { id: "linux-x64" },
        files: [
          {
            path: "dist/@kungfu-tech/libnode-linux-x64-22.22.3-kf.3-alpha.7.tgz",
            sha256: "a".repeat(64),
          },
        ],
      },
    ],
  });
  assert.deepEqual(required, [
    {
      kind: "npm",
      name: "libnode-linux-x64-22.22.3-kf.3-alpha.7",
      ref: "22.22.3-kf.3-alpha.7",
      digest: `sha256:${"a".repeat(64)}`,
      role: "platform",
      platform: "linux-x64",
    },
  ]);
});

test("workflow friction classifier prioritizes duplicate PRs, heavy builds, and late fail-fast", () => {
  assert.equal(
    selectFrictionClass({ duplicatePullRequests: [{}, {}], heavyBuilds: [{}, {}], releaseCandidateOutcome: "failure" }),
    "duplicate-channel-pr",
  );
  assert.equal(
    selectFrictionClass({ duplicatePullRequests: [{}], heavyBuilds: [{}, {}] }),
    "duplicate-heavy-build",
  );
  assert.equal(
    selectFrictionClass({ releaseCandidateOutcome: "failure" }),
    "late-fail-fast",
  );
  const body = buildWorkflowFrictionBody({
    repository: "kungfu-systems/buildchain",
    targetRef: "alpha/v2/v2.4",
    targetSha: SOURCE_SHA,
    frictionClass: "duplicate-heavy-build",
    heavyBuilds: [{ name: "Build Surface Fixture", durationMs: 1000 }],
  });
  assert.match(body, /Buildchain workflow friction evidence/);
  assert.match(body, /duplicate-heavy-build/);
  assert.match(body, /Heavy build runs/);
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

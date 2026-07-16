import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RELEASE_CANDIDATE_PASSPORT_CONTRACT,
  createReleaseCandidatePassport,
  sha256Json,
  validateReleaseCandidatePassport,
} from "../packages/core/release-candidate.js";
import { generateReleaseCandidatePassportCli } from "../scripts/generate-release-candidate-passport.mjs";
import {
  generatePublishRequiredArtifacts,
  readNpmPackageArtifact,
  resolveReleaseCandidateArtifacts,
  releaseCandidateDownloadEnabled,
  selectMergedChannelPullRequest,
  selectPayloadArtifacts,
  selectReleaseCandidateArtifacts,
  selectReleaseCandidateRun,
  selectReleaseCandidateRuns,
} from "../scripts/release-candidate-resolver.mjs";
import {
  buildWorkflowFrictionBody,
  classifyWorkflowFriction,
  selectFrictionClass,
} from "../scripts/workflow-friction-report.mjs";

const SOURCE_SHA = "1111111111111111111111111111111111111111";

test("release candidate resolver makes metadata-only preflight explicit", () => {
  assert.equal(releaseCandidateDownloadEnabled("false"), false);
  assert.equal(releaseCandidateDownloadEnabled("FALSE"), false);
  assert.equal(releaseCandidateDownloadEnabled("true"), true);
  assert.equal(releaseCandidateDownloadEnabled(""), true);
});

function createNpmTarball(root, packageJson, filename) {
  const source = path.join(root, `${filename}-src`);
  const packageDir = path.join(source, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const tarballPath = path.join(root, filename);
  execFileSync("tar", ["-czf", tarballPath, "-C", source, "package"], { stdio: "ignore" });
  return tarballPath;
}

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

test("release candidate passport binds controller receipts to source and runtime", () => {
  const buildSummary = sampleBuildSummary();
  const reference = {
    controllerId: "build-lifecycle",
    planDigest: `sha256:${"3".repeat(64)}`,
    receiptDigest: `sha256:${"4".repeat(64)}`,
    sourceSha: SOURCE_SHA,
    runtimeSha: buildSummary.runtime.sha,
    status: "passed",
    artifact: "buildchain-controller-receipt",
  };
  const passport = createReleaseCandidatePassport({
    repository: "kungfu-systems/libnode",
    targetChannel: "alpha",
    version: "22.22.3-kf.3-alpha.7",
    sourceHeadSha: SOURCE_SHA,
    buildSummary,
    controllerReceiptReferences: [reference],
  });

  assert.deepEqual(passport.controllerReceipts, [reference]);
  assert.equal(validateReleaseCandidatePassport({ passport, buildSummary }).ok, true);
  passport.controllerReceipts[0].runtimeSha = "5".repeat(40);
  assert.match(
    validateReleaseCandidatePassport({ passport, buildSummary }).errors.join("; "),
    /runtime SHA mismatch/,
  );
});

test("release candidate passport binds a qualifying Shifu Gate aggregate", () => {
  const buildSummary = sampleBuildSummary();
  const gateAggregate = {
    contract: "buildchain.shifu-gate-aggregate/v1",
    profile: "candidate",
    sourceSha: SOURCE_SHA,
    registry: { projectId: "fixture", digest: `sha256:${"b".repeat(64)}` },
    matrixDigest: `sha256:${"c".repeat(64)}`,
    status: "pass",
    qualifying: true,
    receipts: [{ platformId: "linux" }],
    gates: [{ gateId: "source.contract" }],
  };
  gateAggregate.digest = `sha256:${sha256Json(gateAggregate)}`;
  const passport = createReleaseCandidatePassport({
    repository: "kungfu-systems/libnode",
    targetChannel: "alpha",
    version: "22.22.3-kf.3-alpha.7",
    sourceHeadSha: SOURCE_SHA,
    buildSummary,
    gateAggregate,
  });
  assert.equal(passport.gateProfileEvidence.digest, gateAggregate.digest);
  assert.equal(passport.gateProfileEvidence.receiptCount, 1);
  assert.equal(validateReleaseCandidatePassport({ passport, buildSummary }).ok, true);

  const stale = {
    ...passport,
    gateProfileEvidence: { ...passport.gateProfileEvidence, sourceSha: "9".repeat(40) },
  };
  const validation = validateReleaseCandidatePassport({ passport: stale, buildSummary });
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("; "), /gate profile evidence source SHA mismatch/);
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

  const reusedBranchPullRequest = {
    number: 610,
    head: {
      ref: "dev/v2/v2.8",
      sha: "db807d5f4d8e38f439f97e32dcc0768e10d0150d",
      repo: { full_name: "kungfu-systems/buildchain" },
    },
  };
  const reusedBranchRuns = selectReleaseCandidateRuns({
    pullRequest: reusedBranchPullRequest,
    workflowName: "Build Surface Fixture",
    runs: [
      {
        id: 28779551847,
        name: "Build Surface Fixture",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-06T12:00:00.000Z",
        head_branch: "dev/v2/v2.8",
        head_sha: "0c3b6c05725122d0339053d0837e6384d44b90e5",
        head_repository: { full_name: "kungfu-systems/buildchain" },
        pull_requests: [],
      },
      {
        id: 28795133445,
        name: "Build Surface Fixture",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-06T13:00:00.000Z",
        head_branch: "dev/v2/v2.8",
        head_sha: "db807d5f4d8e38f439f97e32dcc0768e10d0150d",
        head_repository: { full_name: "kungfu-systems/buildchain" },
        pull_requests: [],
      },
    ],
  });
  assert.deepEqual(reusedBranchRuns.map((run) => run.id), [28795133445]);

  const staleOnlyRuns = selectReleaseCandidateRuns({
    pullRequest: reusedBranchPullRequest,
    workflowName: "Build Surface Fixture",
    runs: [
      {
        id: 28779551847,
        name: "Build Surface Fixture",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-06T12:00:00.000Z",
        head_branch: "dev/v2/v2.8",
        head_sha: "0c3b6c05725122d0339053d0837e6384d44b90e5",
        head_repository: { full_name: "kungfu-systems/buildchain" },
        pull_requests: [],
      },
    ],
  });
  assert.deepEqual(staleOnlyRuns, []);

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

test("release candidate resolver keeps candidate runs ordered for artifact fallback", () => {
  const pullRequest = {
    number: 20,
    head: {
      ref: "alpha/v2/v2.5",
      sha: "2222222222222222222222222222222222222222",
      repo: { full_name: "kungfu-systems/buildchain" },
    },
  };
  const runs = selectReleaseCandidateRuns({
    pullRequest,
    workflowName: "Build Surface Fixture",
    runs: [
      {
        id: 1,
        name: "Build Surface Fixture",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-04T02:00:00.000Z",
        pull_requests: [{ number: 20 }],
      },
      {
        id: 2,
        name: "Build Surface Fixture",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-04T03:00:00.000Z",
        pull_requests: [{ number: 20 }],
      },
    ],
  });

  assert.deepEqual(runs.map((run) => run.id), [2, 1]);
  assert.equal(selectReleaseCandidateRun({ runs, pullRequest, workflowName: "Build Surface Fixture" }).id, 2);
});

test("release candidate resolver skips newer successful run without passport artifacts", async () => {
  const targetSha = "3333333333333333333333333333333333333333";
  const olderSourceSha = "4444444444444444444444444444444444444444";
  const fetchImpl = async (url) => {
    const jsonResponse = (value) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
    });
    if (url.endsWith(`/commits/${targetSha}/pulls`)) {
      return jsonResponse([
        {
          number: 520,
          state: "closed",
          merged_at: "2026-07-05T08:30:00Z",
          updated_at: "2026-07-05T08:30:00Z",
          base: { ref: "release/v2/v2.5" },
          head: {
            ref: "alpha/v2/v2.5",
            sha: olderSourceSha,
            repo: { full_name: "kungfu-systems/buildchain" },
          },
        },
      ]);
    }
    if (url.includes("actions/workflows/build-surface-fixture.yml/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 200,
            name: "Build Surface Fixture",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-05T08:29:00Z",
            pull_requests: [{ number: 520 }],
          },
          {
            id: 100,
            name: "Build Surface Fixture",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-05T08:27:00Z",
            pull_requests: [{ number: 520 }],
          },
        ],
      });
    }
    if (url.includes("actions/runs/200/artifacts")) {
      return jsonResponse({
        artifacts: [
          { id: 1, name: `libnode-shaped-summary-${olderSourceSha}`, expired: false },
        ],
      });
    }
    if (url.includes("actions/runs/100/artifacts")) {
      return jsonResponse({
        artifacts: [
          { id: 2, name: `libnode-shaped-release-candidate-${olderSourceSha}`, expired: false },
          { id: 3, name: `libnode-shaped-summary-${olderSourceSha}`, expired: false },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await resolveReleaseCandidateArtifacts({
    repository: "kungfu-systems/buildchain",
    targetRef: "release/v2/v2.5",
    targetSha,
    workflowFile: "build-surface-fixture.yml",
    workflowName: "Build Surface Fixture",
    artifactName: "libnode-shaped",
    fetchImpl,
    download: false,
  });

  assert.equal(result.run.id, "100");
  assert.equal(result.artifacts.passport, `libnode-shaped-release-candidate-${olderSourceSha}`);
});

test("release candidate resolver waits for the exact channel PR run", async () => {
  const targetSha = "5".repeat(40);
  const builtSourceSha = "6".repeat(40);
  let workflowQueries = 0;
  let waits = 0;
  const jsonResponse = (value) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  });
  const fetchImpl = async (url) => {
    if (url.endsWith(`/commits/${targetSha}/pulls`)) {
      return jsonResponse([
        {
          number: 530,
          state: "closed",
          merged_at: "2026-07-15T16:04:52Z",
          base: { ref: "alpha/v2/v2.13" },
          head: {
            ref: "dev/v2/v2.13",
            sha: builtSourceSha,
            repo: { full_name: "kungfu-systems/buildchain" },
          },
        },
      ]);
    }
    if (url.includes("actions/workflows/build-surface-fixture.yml/runs")) {
      workflowQueries += 1;
      if (workflowQueries === 1) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 700,
              name: "Build Surface Fixture",
              event: "pull_request",
              status: "completed",
              conclusion: "success",
              pull_requests: [{ number: 529 }],
            },
          ],
        });
      }
      return jsonResponse({
        workflow_runs: [
          {
            id: 701,
            name: "Build Surface Fixture",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            head_sha: builtSourceSha,
            pull_requests: [{ number: 530 }],
          },
        ],
      });
    }
    if (url.includes("actions/runs/701/artifacts")) {
      return jsonResponse({
        artifacts: [
          { id: 1, name: `libnode-shaped-release-candidate-${builtSourceSha}`, expired: false },
          { id: 2, name: `libnode-shaped-summary-${builtSourceSha}`, expired: false },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await resolveReleaseCandidateArtifacts({
    repository: "kungfu-systems/buildchain",
    targetRef: "alpha/v2/v2.13",
    targetSha,
    workflowFile: "build-surface-fixture.yml",
    workflowName: "Build Surface Fixture",
    artifactName: "libnode-shaped",
    fetchImpl,
    download: false,
    waitSeconds: 1,
    pollIntervalMs: 0,
    sleepImpl: async () => {
      waits += 1;
    },
  });

  assert.equal(workflowQueries, 2);
  assert.equal(waits, 1);
  assert.equal(result.run.id, "701");
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

test("release candidate resolver generates npm package-set required artifacts from tarballs", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-rc-npm-"));
  try {
    const version = "22.22.3-kf.3-alpha.7";
    const mainTarball = createNpmTarball(
      workspace,
      { name: "@kungfu-tech/libnode", version },
      "libnode-main.tgz",
    );
    const linuxTarball = createNpmTarball(
      workspace,
      { name: "@kungfu-tech/libnode-linux-x64", version },
      "libnode-linux.tgz",
    );

    const mainIntegrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(mainTarball)).digest("base64")}`;
    const linuxIntegrity = `sha512-${crypto.createHash("sha512").update(fs.readFileSync(linuxTarball)).digest("base64")}`;

    assert.deepEqual(
      readNpmPackageArtifact({
        tarballPath: mainTarball,
        mainPackage: "@kungfu-tech/libnode",
      }),
      {
        kind: "npm",
        name: "@kungfu-tech/libnode",
        ref: version,
        digest: mainIntegrity,
        integrity: mainIntegrity,
        role: "main",
      },
    );

    const required = generatePublishRequiredArtifacts({
      kind: "npm",
      tarballPaths: [linuxTarball, mainTarball],
      mainPackage: "@kungfu-tech/libnode",
    });

    assert.deepEqual(required, [
      {
        kind: "npm",
        name: "@kungfu-tech/libnode",
        ref: version,
        digest: mainIntegrity,
        integrity: mainIntegrity,
        role: "main",
      },
      {
        kind: "npm",
        name: "@kungfu-tech/libnode-linux-x64",
        ref: version,
        digest: linuxIntegrity,
        integrity: linuxIntegrity,
        role: "platform",
      },
    ]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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

test("workflow friction classifier falls back when configured workflow file is missing", async () => {
  const targetSha = "c".repeat(40);
  const builtSourceSha = "a".repeat(40);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-friction-"));
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const jsonResponse = (value, ok = true, status = 200) => ({
      ok,
      status,
      text: async () => JSON.stringify(value),
    });
    if (url.endsWith(`/commits/${targetSha}/pulls`)) {
      return jsonResponse([
        {
          number: 42,
          title: "Promote alpha",
          html_url: "https://github.com/kungfu-systems/libnode/pull/42",
          merged_at: "2026-07-04T00:00:00Z",
          updated_at: "2026-07-04T00:00:00Z",
          base: { ref: "alpha/v22/v22.22" },
          head: {
            sha: builtSourceSha,
            ref: "dev/v22/v22.22",
            repo: { full_name: "kungfu-systems/libnode" },
          },
        },
      ]);
    }
    if (url.includes("actions/workflows/build-surface-fixture.yml/runs")) {
      return jsonResponse({ message: "Not Found" }, false, 404);
    }
    if (url.includes("actions/runs?event=pull_request")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 456,
            name: "Build",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-04T00:01:00Z",
            run_started_at: "2026-07-04T00:00:00Z",
            pull_requests: [{ number: 42 }],
          },
          {
            id: 999,
            name: "Docs",
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            updated_at: "2026-07-04T00:01:00Z",
            pull_requests: [{ number: 42 }],
          },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  try {
    const result = await classifyWorkflowFriction({
      repository: "kungfu-systems/libnode",
      targetSha,
      targetRef: "alpha/v22/v22.22",
      buildWorkflowFile: "build-surface-fixture.yml",
      buildWorkflowName: "Build",
      releaseCandidateOutcome: "failure",
      outputDir: workspace,
      fetchImpl,
    });

    assert.equal(result.frictionClass, "late-fail-fast");
    assert.equal(result.pullRequest, "#42");
    assert.equal(result.relatedRuns.length, 1);
    assert.equal(result.heavyBuilds.length, 1);
    assert.match(result.relatedRuns[0], /Build/);
    assert.match(result.diagnosis, /workflow file build-surface-fixture\.yml was not found/);
    assert.match(result.diagnosis, /fell back to repository pull_request workflow runs/);
    assert.doesNotMatch(result.summary, /auto-classification did not complete/);

    const promotionResult = await classifyWorkflowFriction({
      repository: "kungfu-systems/libnode",
      targetSha,
      targetRef: "alpha/v22/v22.22",
      buildWorkflowFile: "build-surface-fixture.yml",
      buildWorkflowName: "Build",
      releaseCandidateOutcome: "success",
      releaseCandidateDiagnosis: "Resolved the exact PR-stage release candidate.",
      promotionOutcome: "failure",
      promotionDiagnosis: "Generated protected ref update was rejected by branch protection.",
      outputDir: workspace,
      fetchImpl,
    });

    assert.equal(promotionResult.frictionClass, "buildchain-ref-promotion-failed");
    assert.match(promotionResult.diagnosis, /Generated protected ref update was rejected/);
    assert.doesNotMatch(promotionResult.diagnosis, /Resolved the exact PR-stage release candidate/);
    assert.doesNotMatch(promotionResult.nextAction, /Deduplicate/);
    assert.equal(seen.length, 6);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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

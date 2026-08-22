import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createReleaseCandidatePassport,
  sha256Json,
} from "../packages/core/release-candidate.js";
import { releaseTransactionId } from "../packages/core/publish-transaction.js";
import {
  ReleaseCandidateRecoveryError,
  validateRecoveryTargetRef,
  validateReleaseCandidateRecoveryReceipt,
  verifyReleaseCandidateRecovery,
} from "../packages/core/release-candidate-recovery.js";
import {
  candidateArtifactNames,
  createRecoveredPublication,
  createRecoveredPublicationCandidate,
  normalizePlatformManifests,
  resolveAnchorRecoveryRequest,
  trackedRuntimePersistenceScan,
  validateV4RuntimeResumePublicReadback,
  verifyReleaseCandidateStageCapsules,
} from "../scripts/resume-from-candidate-run.mjs";
import { createReleaseCandidateStageCapsules } from "../scripts/generate-release-candidate-passport.mjs";

const SOURCE_SHA = "1".repeat(40);
const TARGET_SHA = "2".repeat(40);
const TREE = "3".repeat(40);
const RUNTIME_SHA = "4".repeat(40);
const PAYLOAD_DIGEST = `sha256:${"5".repeat(64)}`;
const ARCHIVE_DIGEST = `sha256:${"6".repeat(64)}`;

function fixture(overrides = {}) {
  const platformFiles = [
    { path: "buildchain.tgz", size: 7, sha256: PAYLOAD_DIGEST },
    {
      path: ".buildchain/artifacts/linux-x64/diagnostics.json",
      size: 11,
      sha256: `sha256:${"7".repeat(64)}`,
    },
  ];
  const payloadFiles = platformFiles.map((file) => ({ ...file }));
  payloadFiles[1] = { ...payloadFiles[1], size: 13, sha256: `sha256:${"8".repeat(64)}` };
  const buildSummary = {
    contract: "kungfu-buildchain-build-summary",
    git: { repository: "kungfu-systems/buildchain", sha: SOURCE_SHA, treeSha: TREE, runId: "100", runAttempt: "1" },
    runtime: { ref: "train/v3/v3.0/resume-candidate-run", sha: RUNTIME_SHA },
    publishSource: { channel: "alpha", ref: "alpha/v3/v3.0", sha: SOURCE_SHA, consumerVersion: "3.1.0-alpha.1" },
    platforms: [{
      platform: { id: "linux-x64" },
      artifactName: "buildchain-package",
      summary: {
        fileCount: platformFiles.length,
        totalBytes: platformFiles.reduce((total, file) => total + file.size, 0),
        files: platformFiles,
      },
    }],
  };
  const passport = createReleaseCandidatePassport({
    repository: "kungfu-systems/buildchain",
    pullRequest: { number: "42", headRef: "feature/recovery", baseRef: "alpha/v3/v3.0" },
    targetChannel: "alpha",
    version: "3.1.0-alpha.1",
    sourceHeadSha: SOURCE_SHA,
    baseSha: "0".repeat(40),
    mergeRefSha: SOURCE_SHA,
    sourceTreeHash: TREE,
    buildSummary,
    buildchain: { ref: "train/v3/v3.0/resume-candidate-run", sha: RUNTIME_SHA },
    workflow: { name: "Build Surface Fixture", runId: "100", runAttempt: "1" },
  });
  const input = {
    candidateRepository: "kungfu-systems/buildchain",
    targetRepository: "kungfu-systems/buildchain",
    expectedRunId: "100",
    expectedWorkflowFile: "build-surface-fixture.yml",
    expectedWorkflowName: "Build Surface Fixture",
    channel: "alpha",
    targetRef: "alpha/v3/v3.0",
    targetSha: TARGET_SHA,
    targetTree: TREE,
    expectedSourceTree: TREE,
    expectedCandidateRoot: `sha256:${passport.candidateHash}`,
    expectedRuntimeSha: RUNTIME_SHA,
    run: {
      id: "100",
      repository: "kungfu-systems/buildchain",
      headRepository: "kungfu-systems/buildchain",
      status: "completed",
      conclusion: "success",
      event: "pull_request",
      pullRequestNumbers: [42],
      headSha: SOURCE_SHA,
      headBranch: "feature/recovery",
    },
    workflow: { path: ".github/workflows/build-surface-fixture.yml", name: "Build Surface Fixture", state: "active" },
    pullRequest: {
      number: 42,
      merged: true,
      mergeSha: SOURCE_SHA,
      headRepository: "kungfu-systems/buildchain",
      baseRef: "alpha/v3/v3.0",
      authorAssociation: "MEMBER",
      headSha: SOURCE_SHA,
      headRef: "feature/recovery",
    },
    ancestry: { mergeIsAncestor: true, status: "ahead" },
    passport,
    buildSummary,
    controllerReceipts: [],
    platformManifests: [{
      artifactName: "buildchain-package",
      files: platformFiles,
    }],
    platformManifestEvidence: [{
      artifactName: "buildchain-package",
      files: [{ path: "diagnostics.json", size: payloadFiles[1].size, sha256: payloadFiles[1].sha256 }],
    }],
    productPayloadManifests: [],
    artifacts: [{
      name: "buildchain-package",
      size: 11,
      downloadedSize: 11,
      digest: ARCHIVE_DIGEST,
      downloadedDigest: ARCHIVE_DIGEST,
      files: payloadFiles,
    }],
    currentToolingSha: RUNTIME_SHA,
    recoveryRunId: "200",
  };
  return { ...input, ...overrides };
}

function expectCode(code, input) {
  assert.throws(() => verifyReleaseCandidateRecovery(input), (error) => {
    assert.ok(error instanceof ReleaseCandidateRecoveryError);
    assert.equal(error.code, code);
    assert.ok(error.nextAction);
    return true;
  });
}

function durableTransaction(input, state = "complete") {
  const id = releaseTransactionId({
    repository: input.candidateRepository,
    version: input.passport.target.version,
    sourceSha: input.targetSha,
    targetRef: input.targetRef,
  });
  return {
    id,
    repository: input.candidateRepository,
    target_ref: input.targetRef,
    source_sha: input.targetSha,
    version: input.passport.target.version,
    channel: input.passport.target.channel,
    state,
    publication_state: state === "published" ? "package-published" : state,
  };
}

test("cross-runtime recovery reuses only provider-bound original Stage Capsules", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-release-candidate-capsule-"),
  );
  try {
    const manifestPath = path.join(workspace, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        platform: { id: "linux-x64" },
        lifecycle: { verify: "pnpm test" },
      })}\n`,
    );
    const digest = `sha256:${"9".repeat(64)}`;
    const passport = {
      repository: "kungfu-systems/buildchain",
      source: { headSha: SOURCE_SHA, treeHash: TREE },
      buildchain: { sha: RUNTIME_SHA },
      workflow: { runId: "100", runAttempt: "1" },
      candidateHash: "a".repeat(64),
      consumerPolicy: { receiptRoot: `sha256:${"b".repeat(64)}` },
      controllerReceipts: [{ receiptDigest: `sha256:${"c".repeat(64)}` }],
      platformMatrix: [
        {
          platformId: "linux-x64",
          artifactName: "buildchain-linux",
          manifestPath,
          summary: { status: "passed" },
        },
      ],
    };
    const expiresAt = "2026-09-01T00:00:00.000Z";
    const coordinate = {
      platformId: "linux-x64",
      id: "17",
      name: "buildchain-linux",
      digest,
      url: "https://github.example/artifacts/17",
      expiresAt,
    };
    const coordinates = {
      repository: passport.repository,
      runId: passport.workflow.runId,
      runAttempt: passport.workflow.runAttempt,
      sourceSha: passport.source.headSha,
      artifacts: [coordinate],
    };
    const sidecar = createReleaseCandidateStageCapsules({
      passport,
      buildSummary: {},
      coordinates,
    });
    const downloads = [
      {
        artifact: {
          id: 17,
          name: "buildchain-linux",
          digest,
          expires_at: expiresAt,
        },
        record: { digest, downloadedDigest: digest },
      },
    ];
    const reused = verifyReleaseCandidateStageCapsules({
      sidecar,
      passport,
      downloads,
    });
    assert.equal(reused[0].buildRuntimeSha, RUNTIME_SHA);
    assert.equal(reused[0].sourceTreeSha, TREE);
    assert.throws(
      () =>
        verifyReleaseCandidateStageCapsules({
          sidecar,
          passport,
          downloads: [
            {
              artifact: downloads[0].artifact,
              record: {
                digest,
                downloadedDigest: `sha256:${"d".repeat(64)}`,
              },
            },
          ],
        }),
      /does not bind the verified provider artifact/,
    );
    assert.throws(
      () =>
        createReleaseCandidateStageCapsules({
          passport,
          buildSummary: {},
          coordinates: { ...coordinates, runId: "101" },
        }),
      /does not bind the candidate run/,
    );
    assert.throws(
      () =>
        verifyReleaseCandidateStageCapsules({
          sidecar: {
            ...sidecar,
            buildAttempt: {
              ...sidecar.buildAttempt,
              id: "github-run:101:attempt:1",
            },
            root: sidecar.root,
          },
          passport,
          downloads,
        }),
      /sidecar identity mismatch/,
    );
    assert.throws(
      () =>
        verifyReleaseCandidateStageCapsules({
          sidecar: createReleaseCandidateStageCapsules({
            passport,
            buildSummary: {},
            coordinates: {
              ...coordinates,
              artifacts: [
                { ...coordinate, digest: `sha256:${"e".repeat(64)}` },
              ],
            },
          }),
          passport,
          downloads,
        }),
      /does not bind the verified provider artifact/,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime persistence scan is rooted at the checked-out recovery runtime", () => {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-runtime-persistence-scan-"),
  );
  try {
    const workflowPath = path.join(workspace, ".github/workflows/recovery.yml");
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, "name: Recovery\n");
    for (const args of [
      ["init", "--quiet"],
      ["add", ".github/workflows/recovery.yml"],
    ]) {
      execFileSync("git", args, { cwd: workspace });
    }

    const scan = trackedRuntimePersistenceScan({ runtimeRoot: workspace });
    assert.equal(scan.status, "passed");
    assert.deepEqual(
      scan.files.map((file) => file.path),
      [".github/workflows/recovery.yml"],
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("resume public readback keeps the target branch distinct from the floating runtime", () => {
  const version = "4.0.1-alpha.6";
  const targetRef = "alpha/v4/v4.0";
  const exactTagSha = "6".repeat(40);
  const targetSha = "7".repeat(40);
  const runtimeSha = "8".repeat(40);
  const digest = "sha512-public";
  const transaction = {
    target_ref: targetRef,
    source_sha: exactTagSha,
    version,
  };
  const main = { digest };
  const npm = {
    "dist-tags": { alpha: version },
    versions: { [version]: { dist: { integrity: digest } } },
  };
  assert.doesNotThrow(() =>
    validateV4RuntimeResumePublicReadback({
      targetRef,
      targetSha,
      alphaSha: runtimeSha,
      exactTagSha,
      tagLineage: { status: "ahead" },
      runtimeSha,
      version,
      transaction,
      main,
      npm,
    }),
  );
  assert.throws(
    () =>
      validateV4RuntimeResumePublicReadback({
        targetRef,
        targetSha,
        alphaSha: runtimeSha,
        exactTagSha,
        tagLineage: { status: "diverged" },
        runtimeSha,
        version,
        transaction,
        main,
        npm,
      }),
    /does not match durable publication/,
  );
});

test("recovery accepts the same tree at a different promotion commit and records reuse", () => {
  const { receipt } = verifyReleaseCandidateRecovery(fixture());
  assert.equal(receipt.action, "reused");
  assert.equal(receipt.originalCandidate.sourceSha, SOURCE_SHA);
  assert.equal(receipt.target.sha, TARGET_SHA);
  assert.equal(receipt.target.observedRefSha, TARGET_SHA);
  assert.equal(receipt.target.version, "3.1.0-alpha.1");
  assert.equal(receipt.originalCandidate.tree, receipt.target.tree);
  assert.deepEqual(receipt.skippedBuildStages, ["install", "build", "verify", "platform-matrix"]);
  assert.equal(receipt.payloadBytes, "unchanged");
  assert.match(receipt.root, /^sha256:[0-9a-f]{64}$/);
});

test("custom-product recovery uses Passport version and manifests without treating product archives as npm", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-custom-recovery-"));
  try {
    const first = path.join(workspace, "kungfu-episodes-cli-linux-x64.tar.gz");
    const second = path.join(workspace, "kungfu-desktop-linux-x64.tgz");
    fs.writeFileSync(first, "first-product-archive");
    fs.writeFileSync(second, "second-product-archive");
    const files = [first, second].map((absolutePath) => ({
      path: path.basename(absolutePath),
      absolutePath,
      size: fs.statSync(absolutePath).size,
      sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")}`,
    }));
    const manifest = { platform: { id: "linux-x64" }, files: files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })) };
    const publication = createRecoveredPublication({
      downloads: [{ files }],
      bundleRoot: workspace,
      repository: "kungfu-systems/kungfu",
      passport: {
        buildchain: { sha: RUNTIME_SHA },
        candidateHash: "a".repeat(64),
        source: { headSha: SOURCE_SHA, treeHash: TREE },
        target: { version: "4.0.0-alpha.1" },
      },
      candidateRuntimeSha: RUNTIME_SHA,
      publishArtifactKind: "kungfu-product",
      releasePatterns: "kungfu-episodes-cli-*.tar.gz",
      platformManifests: [manifest],
    });
    assert.equal(publication.version, "4.0.0-alpha.1");
    assert.equal(publication.manifest, undefined);
    assert.deepEqual(publication.npmArtifacts, []);
    assert.deepEqual(publication.releaseAssets.map((entry) => path.basename(entry.absolutePath)), [path.basename(first)]);
    assert.equal(publication.publishRequiredArtifacts.length, 2);
    assert.ok(publication.publishRequiredArtifacts.every((entry) => entry.kind === "kungfu-product"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("candidate recovery excludes credential-island manifests outside the Passport platform matrix", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-platform-manifests-"));
  try {
    const downloads = [
      ["kungfu-manifest-macos-arm64-source", "macos-arm64", "kungfu-macos-arm64-source"],
      ["kungfu-credential-manifest-macos-source", "macos-arm64-credential", "native-kungfu-desktop-macos-arm64-credential"],
    ].map(([name, platformId, artifactName]) => {
      const absolutePath = path.join(workspace, `${platformId}.json`);
      fs.writeFileSync(absolutePath, `${JSON.stringify({ artifactName, platform: { id: platformId }, files: [] })}\n`);
      const evidence = { path: "manifest.json", size: fs.statSync(absolutePath).size, sha256: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")}` };
      return { artifact: { name }, files: [{ ...evidence, absolutePath }], record: { files: [evidence] } };
    });
    const normalized = normalizePlatformManifests(downloads, {
      platformMatrix: [{ platformId: "macos-arm64", artifactName: "kungfu-macos-arm64-source" }],
    });
    assert.deepEqual(normalized.manifests.map((entry) => entry.platform.id), ["macos-arm64"]);
    assert.deepEqual(normalized.evidence.map((entry) => entry.artifactName), ["kungfu-macos-arm64-source"]);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("recovery accepts a target advanced by the same explicit durable transaction", () => {
  const input = fixture();
  const existingTransaction = durableTransaction(input, "complete");
  const observedTargetSha = "a".repeat(40);
  assert.deepEqual(validateRecoveryTargetRef({
    targetSha: input.targetSha,
    observedTargetSha,
    expectedTransactionId: existingTransaction.id,
    existingTransaction,
    ancestry: { status: "ahead", mergeIsAncestor: true },
  }), { advanced: true, observedSha: observedTargetSha });

  assert.throws(() => validateRecoveryTargetRef({
    targetSha: input.targetSha,
    observedTargetSha,
  }), (error) => error instanceof ReleaseCandidateRecoveryError && error.code === "target-ref-moved");
});

test("recovery rejects unrelated target advancement and conflicting transaction state", () => {
  const input = fixture();
  const existingTransaction = durableTransaction(input, "complete");
  assert.throws(() => validateRecoveryTargetRef({
    targetSha: input.targetSha,
    observedTargetSha: "a".repeat(40),
    expectedTransactionId: existingTransaction.id,
    existingTransaction,
    ancestry: { status: "diverged", mergeIsAncestor: false },
  }), (error) => error instanceof ReleaseCandidateRecoveryError && error.code === "target-ancestry-mismatch");

  existingTransaction.state = "repair_required";
  assert.throws(() => validateRecoveryTargetRef({
    targetSha: input.targetSha,
    observedTargetSha: "a".repeat(40),
    expectedTransactionId: existingTransaction.id,
    existingTransaction,
    ancestry: { status: "ahead", mergeIsAncestor: true },
  }), (error) => error instanceof ReleaseCandidateRecoveryError && error.code === "transaction-state-conflict");
});

test("recovered sealed publication identity stays bound to the original candidate runtime", () => {
  const firstInput = fixture({ currentToolingSha: "a".repeat(40) });
  const secondInput = fixture({ currentToolingSha: "b".repeat(40) });
  const allFiles = firstInput.artifacts[0].files.map((file) => ({
    path: `artifacts/buildchain-package/${file.path}`,
    size: file.size,
    sha256: file.sha256,
  }));
  const first = createRecoveredPublicationCandidate({
    allFiles,
    repository: firstInput.candidateRepository,
    passport: firstInput.passport,
    candidateRuntimeSha: RUNTIME_SHA,
  });
  const second = createRecoveredPublicationCandidate({
    allFiles,
    repository: secondInput.candidateRepository,
    passport: secondInput.passport,
    candidateRuntimeSha: RUNTIME_SHA,
  });
  assert.notEqual(
    verifyReleaseCandidateRecovery(firstInput).receipt.buildchainToolingSha,
    verifyReleaseCandidateRecovery(secondInput).receipt.buildchainToolingSha,
  );
  assert.deepEqual(second, first);
  assert.equal(first.runtimeSha, RUNTIME_SHA);
  assert.throws(
    () => createRecoveredPublicationCandidate({
      allFiles,
      repository: firstInput.candidateRepository,
      passport: firstInput.passport,
      candidateRuntimeSha: "9".repeat(40),
    }),
    /recovered publication candidate runtime mismatch/,
  );
});

test("recovery seals only original publication payload artifacts", () => {
  const selected = {
    prefix: "libnode-shaped",
    sourceSha: SOURCE_SHA,
    passport: { name: `libnode-shaped-release-candidate-${SOURCE_SHA}` },
    summary: { name: `libnode-shaped-summary-${SOURCE_SHA}` },
  };
  const artifacts = [
    { name: `buildchain-package-${SOURCE_SHA}`, expired: false },
    { name: `libnode-shaped-summary-${SOURCE_SHA}`, expired: false },
    { name: `libnode-shaped-manifest-linux-x64-${SOURCE_SHA}`, expired: false },
    { name: `libnode-shaped-controller-receipt-${SOURCE_SHA}`, expired: false },
  ];
  const { names, publicationNames } = candidateArtifactNames({
    passport: { controllerReceipts: [], platformMatrix: [] },
    artifacts,
    selected,
    artifactPatterns: "buildchain-package-*",
  });
  assert.deepEqual([...publicationNames], [`buildchain-package-${SOURCE_SHA}`]);
  assert.ok(names.has(`libnode-shaped-summary-${SOURCE_SHA}`));
  assert.ok(!publicationNames.has(`libnode-shaped-summary-${SOURCE_SHA}`));
});

test("recovery binds transaction identity to the sealed product publication version", () => {
  const input = fixture({ publicationVersion: "3.1.0-alpha.2" });
  input.existingTransaction = {
    ...durableTransaction(input),
    id: releaseTransactionId({
      repository: input.candidateRepository,
      version: input.publicationVersion,
      sourceSha: input.targetSha,
      targetRef: input.targetRef,
    }),
    version: input.publicationVersion,
  };
  const { receipt } = verifyReleaseCandidateRecovery(input);
  assert.equal(receipt.target.version, input.publicationVersion);
  assert.equal(receipt.transaction.identity, input.existingTransaction.id);
});

test("recovery rejects the same SHA when an artifact digest drifts", () => {
  const input = fixture({ targetSha: SOURCE_SHA });
  input.artifacts[0].downloadedDigest = `sha256:${"7".repeat(64)}`;
  expectCode("artifact-digest-mismatch", input);
  const payloadDrift = fixture();
  payloadDrift.artifacts[0].files[0].size += 1;
  expectCode("artifact-manifest-mismatch", payloadDrift);
});

test("recovery accepts only byte-identical Buildchain manifest and summary sidecars", () => {
  const input = fixture();
  const platformId = input.passport.platformMatrix[0].platformId;
  const manifestSidecar = {
    path: `.buildchain/artifacts/${platformId}/manifest.json`,
    size: 17,
    sha256: `sha256:${"7".repeat(64)}`,
  };
  const summarySidecar = {
    path: `.buildchain/artifacts/${platformId}/summary.json`,
    size: 19,
    sha256: `sha256:${"8".repeat(64)}`,
  };
  input.artifacts[0].files.push(manifestSidecar, summarySidecar);
  input.platformManifestEvidence[0].files.push(
    { path: "manifest.json", size: manifestSidecar.size, sha256: manifestSidecar.sha256 },
    { path: "summary.json", size: summarySidecar.size, sha256: summarySidecar.sha256 },
  );
  assert.equal(verifyReleaseCandidateRecovery(input).receipt.action, "reused");

  input.platformManifestEvidence[0].files[2].sha256 = `sha256:${"9".repeat(64)}`;
  expectCode("artifact-manifest-mismatch", input);

  input.platformManifestEvidence[0].files[2].sha256 = summarySidecar.sha256;
  input.artifacts[0].files.push({ path: "undeclared.bin", size: 1, sha256: PAYLOAD_DIGEST });
  expectCode("artifact-manifest-mismatch", input);
});

test("recovery accepts post-manifest Buildchain diagnostics only when independently uploaded bytes match", () => {
  const input = fixture();
  assert.equal(verifyReleaseCandidateRecovery(input).receipt.action, "reused");

  input.platformManifestEvidence[0].files[0].sha256 = `sha256:${"9".repeat(64)}`;
  expectCode("artifact-manifest-mismatch", input);
});

test("recovery rejects a different target tree", () => {
  expectCode("source-tree-mismatch", fixture({ targetTree: "8".repeat(40) }));
});

test("recovery rejects repository, workflow, and channel identity drift", () => {
  expectCode("repository-mismatch", fixture({ targetRepository: "kungfu-systems/kungfu" }));
  expectCode("workflow-mismatch", fixture({ expectedWorkflowName: "Other Build" }));
  expectCode("passport-invalid", fixture({ channel: "release" }));
});

test("recovery rejects missing and expired candidate artifacts", () => {
  const missing = fixture();
  missing.artifacts[0].missing = true;
  expectCode("artifact-missing", missing);
  const expired = fixture();
  expired.artifacts[0].expired = true;
  expectCode("artifact-expired", expired);
});

test("recovery rejects transaction identity and candidate-root conflicts", () => {
  expectCode("transaction-identity-conflict", fixture({
    expectedTransactionId: "tx-expected",
    existingTransaction: { id: "tx-other", state: "finalizing" },
  }));
  expectCode("transaction-identity-conflict", fixture({
    existingTransaction: { id: "tx-expected", state: "publishing", candidateRoot: `sha256:${"9".repeat(64)}` },
  }));
});

test("recovery is deterministic and idempotent for a complete transaction", () => {
  const input = fixture({ createdAt: "2026-08-06T00:00:00.000Z" });
  input.existingTransaction = durableTransaction(input);
  input.expectedTransactionId = input.existingTransaction.id;
  const first = verifyReleaseCandidateRecovery(input).receipt;
  const second = verifyReleaseCandidateRecovery(input).receipt;
  assert.deepEqual(second, first);
  assert.equal(first.transaction.state, "complete");
  assert.equal(first.transaction.publicationState, "complete");
});

test("recovery records finalizing and package-published durable transaction state", () => {
  const input = fixture();
  input.existingTransaction = durableTransaction(input, "published");
  const published = verifyReleaseCandidateRecovery(input).receipt;
  assert.equal(published.transaction.state, "published");
  assert.equal(published.transaction.publicationState, "package-published");
  input.existingTransaction.state = "finalizing";
  input.existingTransaction.publication_state = "package-published";
  const finalizing = verifyReleaseCandidateRecovery(input).receipt;
  assert.equal(finalizing.transaction.state, "finalizing");
});

test("recovery requires successful trusted PR workflow and permission evidence", () => {
  const startup = fixture();
  startup.run.conclusion = "startup_failure";
  expectCode("untrusted-build-run", startup);
  const untrusted = fixture();
  untrusted.pullRequest.authorAssociation = "NONE";
  expectCode("permission-evidence-insufficient", untrusted);
});

test("anchored rematerialization inherits only the exact superseded PR provenance", () => {
  const input = fixture();
  const originalPassport = structuredClone(input.passport);
  originalPassport.workflow.runId = "99";
  const originalBuildSummary = structuredClone(input.buildSummary);
  const originalRoot = `sha256:${originalPassport.candidateHash}`;
  const transactionId = releaseTransactionId({
    repository: input.candidateRepository,
    version: input.passport.target.version,
    sourceSha: input.targetSha,
    targetRef: input.targetRef,
  });
  const request = {
    schema: 1,
    contract: "kungfu-buildchain-explicit-publish-anchor-request/v1",
    assignmentId: "release-assignment",
    attemptId: "native:123e4567-e89b-12d3-a456-426614174000",
    transactionId,
    source: { sha: input.targetSha, tree: TREE },
    supersededCandidate: {
      workflowRunId: "99",
      sha: originalPassport.source.headSha,
      root: originalRoot,
    },
    runtime: { ref: "train/v3/v3.0/resume-candidate-run", sha: RUNTIME_SHA },
  };
  input.buildSummary = structuredClone(input.buildSummary);
  input.buildSummary.git.sha = input.targetSha;
  input.buildSummary.publishSource = {
    channel: "anchor",
    ref: "publish-gate/anchor",
    sha: input.targetSha,
    releaseManifest: JSON.stringify({
      sourceRef: "publish-gate/anchor",
      sourceSha: input.targetSha,
      anchorRequest: request,
    }),
  };
  input.passport = structuredClone(input.passport);
  input.passport.pullRequest = { number: "", url: "", headRef: "", baseRef: "" };
  input.passport.target = { ...input.passport.target, channel: "anchor", ref: "publish-gate/anchor" };
  input.passport.source = {
    ...input.passport.source,
    headSha: input.targetSha,
    mergeRefSha: RUNTIME_SHA,
    builtSourceSha: RUNTIME_SHA,
  };
  input.passport.diagnostics.buildSummaryHash = sha256Json(input.buildSummary);
  input.passport.candidateHash = sha256Json({
    repository: input.passport.repository,
    target: input.passport.target,
    source: input.passport.source,
    platformMatrix: input.passport.platformMatrix,
    buildchain: input.passport.buildchain,
  });
  input.expectedCandidateRoot = `sha256:${input.passport.candidateHash}`;
  input.run = {
    ...input.run,
    event: "workflow_dispatch",
    headSha: RUNTIME_SHA,
    headBranch: "fix/anchored-recovery",
    pullRequestNumbers: [],
  };
  input.anchorProvenance = {
    request,
    run: { ...fixture().run, id: "99", pullRequestNumbers: [42] },
    workflow: structuredClone(input.workflow),
    passport: originalPassport,
    buildSummary: originalBuildSummary,
  };
  input.expectedTransactionId = transactionId;
  input.existingTransaction = {
    ...durableTransaction(input, "finalizing"),
    id: transactionId,
    channel: "alpha",
  };
  const receipt = verifyReleaseCandidateRecovery(input).receipt;
  assert.equal(receipt.originalCandidate.provenance, "anchored-rematerialization");
  assert.equal(receipt.originalCandidate.supersededCandidate.candidateRoot, originalRoot);
  assert.equal(receipt.target.channel, "alpha");

  const drifted = structuredClone(input);
  drifted.anchorProvenance.request.supersededCandidate.root = `sha256:${"9".repeat(64)}`;
  expectCode("anchored-provenance-invalid", drifted);
});

test("anchor request parser rejects unbound workflow-dispatch candidates", () => {
  const input = fixture();
  input.passport.pullRequest.number = "";
  input.passport.target = { channel: "anchor", ref: "publish-gate/anchor", version: "3.1.0-alpha.1" };
  const request = {
    schema: 1,
    contract: "kungfu-buildchain-explicit-publish-anchor-request/v1",
    assignmentId: "release-assignment",
    attemptId: "native:123e4567-e89b-12d3-a456-426614174000",
    transactionId: "transaction-1",
    source: { sha: SOURCE_SHA, tree: TREE },
    supersededCandidate: {
      workflowRunId: "99",
      sha: TARGET_SHA,
      root: `sha256:${"8".repeat(64)}`,
    },
    runtime: { ref: "train/v3/v3.0/resume-candidate-run", sha: RUNTIME_SHA },
  };
  const buildSummary = {
    publishSource: {
      releaseManifest: JSON.stringify({
        sourceRef: "publish-gate/anchor",
        sourceSha: SOURCE_SHA,
        anchorRequest: request,
      }),
    },
  };
  assert.deepEqual(resolveAnchorRecoveryRequest({ passport: input.passport, buildSummary, transactionId: "transaction-1" }), request);
  request.runtime.sha = TARGET_SHA;
  assert.throws(() => resolveAnchorRecoveryRequest({
    passport: input.passport,
    buildSummary: {
      publishSource: {
        releaseManifest: JSON.stringify({
          sourceRef: "publish-gate/anchor",
          sourceSha: SOURCE_SHA,
          anchorRequest: request,
        }),
      },
    },
    transactionId: "transaction-1",
  }), /does not bind/u);
});

test("recovery binds an additional product payload manifest to candidate, summary, tree, and bytes", () => {
  const input = fixture();
  const productManifest = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-product-payload-manifest/v1",
    artifactName: "buildchain-package-extra",
    manifestPath: "product-payload-manifest.json",
    candidateRoot: input.expectedCandidateRoot,
    buildSummaryRoot: `sha256:${input.passport.diagnostics.buildSummaryHash}`,
    source: { sha: SOURCE_SHA, tree: TREE },
    runtimeSha: RUNTIME_SHA,
    files: [{ path: "kungfu-tech-buildchain.tgz", size: 13, sha256: PAYLOAD_DIGEST }],
  };
  productManifest.root = `sha256:${sha256Json(productManifest)}`;
  input.productPayloadManifests = [productManifest];
  input.artifacts.push({
    name: productManifest.artifactName,
    size: 21,
    downloadedSize: 21,
    digest: `sha256:${"a".repeat(64)}`,
    downloadedDigest: `sha256:${"a".repeat(64)}`,
    files: [
      productManifest.files[0],
      { path: productManifest.manifestPath, size: 17, sha256: `sha256:${"b".repeat(64)}` },
    ],
  });
  assert.equal(verifyReleaseCandidateRecovery(input).receipt.action, "reused");
  input.productPayloadManifests[0].files[0].size = 14;
  expectCode("artifact-manifest-mismatch", input);
});

test("workflow recovery is a fresh-event path and statically excludes product installation", async () => {
  const fs = await import("node:fs");
  const advanced = fs.readFileSync(
    new URL(
      "../.github/workflows/.release-candidate-promote.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const publicWorkflow = fs.readFileSync(
    new URL(
      "../.github/workflows/release-candidate-promote.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const refPromotion = fs.readFileSync(
    new URL(
      "../.github/workflows/buildchain-ref-promotion.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const dogfoodFailure = fs.readFileSync(
    new URL(
      "../.github/workflows/buildchain-candidate-recovery-dogfood-failure.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const alphaPromotion = fs.readFileSync(
    new URL(
      "../actions/promote-buildchain-ref/internal/promote-alpha-channel.js",
      import.meta.url,
    ),
    "utf8",
  );
  const durableOperations = fs.readFileSync(
    new URL(
      "../actions/promote-buildchain-ref/internal/durable-transaction-operations.js",
      import.meta.url,
    ),
    "utf8",
  );
  const promoteLib = fs.readFileSync(
    new URL("../actions/promote-buildchain-ref/lib.js", import.meta.url),
    "utf8",
  );
  for (const input of [
    "resume-candidate-repository",
    "resume-candidate-run-id",
    "resume-expected-workflow-file",
    "resume-expected-source-tree",
    "resume-expected-candidate-root",
    "resume-expected-candidate-runtime-sha",
    "resume-buildchain-runtime-sha",
    "resume-transaction-id",
  ]) {
    assert.match(advanced, new RegExp(`${input}:`));
    assert.match(publicWorkflow, new RegExp(`${input}:`));
  }
  assert.match(advanced, /node \.buildchain\/runtime\/scripts\/resume-from-candidate-run\.mjs/);
  assert.match(advanced, /name: Install promotion dependencies\n\s+if: \$\{\{ inputs\.resume-candidate-run-id == '' \}\}/);
  assert.match(
    advanced,
    /name: Bridge Buildchain self-runtime dependencies\n\s+if: \$\{\{ inputs\.resume-candidate-run-id != '' && github\.repository == inputs\.buildchain-repository \}\}/,
  );
  assert.match(advanced, /ln -s \.buildchain\/runtime\/node_modules node_modules/);
  assert.match(advanced, /test ! -d \.buildchain\/runtime\/promotion-shell\/actions\/promote-buildchain-ref \|\| cp -R \.buildchain\/runtime\/promotion-shell\/actions\/promote-buildchain-ref\/\. \.buildchain\/runtime\/actions\/promote-buildchain-ref\//);
  assert.match(advanced, /name: Install exact publication planning dependencies\n\s+if: \$\{\{ inputs\.resume-candidate-run-id == '' \}\}/);
  assert.match(advanced, /name: Resolve exact publication transaction version\n\s+id: plan\n\s+if: \$\{\{ inputs\.resume-candidate-run-id == '' \}\}/);
  assert.match(advanced, /name: Reuse sealed candidate publication version/);
  assert.match(advanced, /publish-sealed-bundle-root: \$\{\{ steps\.rc\.outputs\.publish-sealed-bundle-root \}\}/);
  assert.match(
    advanced,
    /publish-required-artifacts-path: \$\{\{ inputs\.publish-required-artifacts-json == '' && steps\.rc\.outputs\.publish-required-artifacts-path \|\| '' \}\}/,
  );
  assert.match(advanced, /BUILDCHAIN_EXPECTED_TRANSACTION_ID: \$\{\{ inputs\.resume-transaction-id \}\}/);
  assert.match(advanced, /BUILDCHAIN_RELEASE_CANDIDATE_RECOVERY_RECEIPT_PATH: \$\{\{ steps\.rc\.outputs\.release-candidate-recovery-receipt-path \}\}/);
  assert.match(
    advanced,
    /release-passport-v4-runtime-resume-evidence-json: \$\{\{ inputs\.release-passport-v4-runtime-resume-evidence-json \|\| steps\.rc\.outputs\.v4-runtime-resume-evidence-path \}\}/,
  );
  assert.match(
    advanced,
    /release-passport-v4-runtime-resume-evidence-command: \$\{\{ steps\.rc\.outputs\.v4-runtime-resume-finalize-command \}\}/,
  );
  assert.match(
    alphaPromotion,
    /updateTag\(context\.rule\.alphaTag,[\s\S]*?markComplete\(\)/,
  );
  assert.match(
    durableOperations,
    /completeTransactionFinalization\([\s\S]*?collectAndPersistReleasePassport\(/,
  );
  assert.match(
    promoteLib,
    /generatedV4RuntimeResumeEvidence = generateReleaseEvidenceInputs[\s\S]*?collectGitHubReleasePassport\(/,
  );
  assert.match(advanced, /if \[ -n "\$\{\{ steps\.rc\.outputs\.v4-runtime-resume-evidence-path \}\}" \]; then/);
  assert.match(
    advanced,
    /cp "\$\{\{ steps\.rc\.outputs\.v4-runtime-resume-evidence-path \}\}" "\$\{RELEASE_PASSPORT_OUTPUT_DIR\}\/"/,
  );
  assert.match(
    refPromotion,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/release-candidate-promote\.yml@v4-alpha/,
  );
  assert.match(
    refPromotion,
    /buildchain-ref: \$\{\{ inputs\['resume-candidate-run-id'\] != '' && inputs\['resume-buildchain-runtime-sha'\] \|\| '' \}\}/,
  );
  assert.match(
    refPromotion,
    /github-release-payload-patterns: \$\{\{ inputs\['resume-candidate-run-id'\] != '' && '\*\.tgz' \|\| '' \}\}/,
  );
  assert.doesNotMatch(refPromotion, /^\s+github-release-payload-patterns: "\*\.tgz"$/m);
  assert.match(dogfoodFailure, /workflow_dispatch:/);
  assert.match(dogfoodFailure, /__candidate-recovery-dogfood-missing\.yml@v3-alpha/);
  assert.doesNotMatch(advanced, /gh run rerun/);
});

test("recovery receipt schema exposes the immutable reused contract", async () => {
  const fs = await import("node:fs");
  const schema = JSON.parse(fs.readFileSync(new URL("../contracts/release-candidate-recovery-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.properties.contract.const, "kungfu-buildchain-release-candidate-recovery/v1");
  assert.equal(schema.properties.action.const, "reused");
  assert.deepEqual(schema.properties.skippedBuildStages.const, ["install", "build", "verify", "platform-matrix"]);
  assert.ok(schema.required.includes("root"));
});

test("recovery receipt binds a sealed payload publication version without rewriting the candidate passport", () => {
  const input = fixture({ publicationVersion: "3.1.0-alpha.2" });
  const originalCandidateHash = input.passport.candidateHash;
  const { receipt } = verifyReleaseCandidateRecovery(input);
  const validation = validateReleaseCandidateRecoveryReceipt({
    receipt,
    passport: input.passport,
    repository: input.targetRepository,
    targetChannel: input.channel,
    targetRef: input.targetRef,
    targetSha: input.targetSha,
    targetTree: input.targetTree,
    version: "3.1.0-alpha.2",
  });
  assert.equal(validation.ok, true);
  assert.equal(validation.publicationVersion, "3.1.0-alpha.2");
  assert.equal(input.passport.target.version, "3.1.0-alpha.1");
  assert.equal(input.passport.candidateHash, originalCandidateHash);

  const driftedVersion = structuredClone(receipt);
  driftedVersion.target.version = "3.1.0-alpha.3";
  assert.match(
    validateReleaseCandidateRecoveryReceipt({
      receipt: driftedVersion,
      passport: input.passport,
      repository: input.targetRepository,
      targetChannel: input.channel,
      targetRef: input.targetRef,
      targetSha: input.targetSha,
      targetTree: input.targetTree,
      version: "3.1.0-alpha.2",
    }).errors.join("; "),
    /receipt root mismatch.*publication version mismatch/,
  );
});

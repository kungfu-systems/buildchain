import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReleaseCandidatePassport, sha256Json } from "../packages/core/release-candidate.js";
import { releaseTransactionId } from "../packages/core/publish-transaction.js";
import {
  ReleaseCandidateRecoveryError,
  validateRecoveryTargetRef,
  validateReleaseCandidateRecoveryReceipt,
  verifyReleaseCandidateRecovery,
} from "../packages/core/release-candidate-recovery.js";
import {
  createRecoveredPublication,
  createRecoveredPublicationCandidate,
  exposeRecoveredPassportPath,
  exposeRecoveredPayloadRoot,
  normalizePlatformManifests,
  recoveredArtifactPathsByBasename,
} from "../scripts/resume-from-candidate-run.mjs";

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

test("recovery exposes sealed payloads at the legacy candidate path without copying bytes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-recovered-payload-root-"));
  try {
    const bundleRoot = path.join(workspace, "sealed-candidate");
    const recoveredPayloadRoot = path.join(bundleRoot, "artifacts");
    fs.mkdirSync(recoveredPayloadRoot, { recursive: true });
    fs.writeFileSync(path.join(recoveredPayloadRoot, "sealed.txt"), "sealed-candidate-bytes");
    const compatibilityRoot = exposeRecoveredPayloadRoot({ resolvedOutput: workspace, bundleRoot });
    assert.equal(fs.lstatSync(compatibilityRoot).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(compatibilityRoot), fs.realpathSync(recoveredPayloadRoot));
    assert.equal(fs.readFileSync(path.join(compatibilityRoot, "sealed.txt"), "utf8"), "sealed-candidate-bytes");
    assert.equal(exposeRecoveredPayloadRoot({ resolvedOutput: workspace, bundleRoot }), compatibilityRoot);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("recovery exposes the sealed Passport at the legacy candidate path without copying bytes", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-recovered-passport-path-"));
  try {
    const recoveredPassportPath = path.join(
      workspace,
      "sealed-candidate",
      "artifacts",
      "release-candidate-passport",
      "release-candidate-passport.json",
    );
    fs.mkdirSync(path.dirname(recoveredPassportPath), { recursive: true });
    fs.writeFileSync(recoveredPassportPath, '{"candidate":"sealed"}\n');
    const compatibilityPath = exposeRecoveredPassportPath({
      resolvedOutput: workspace,
      recoveredPassportPath,
    });
    assert.equal(fs.lstatSync(path.dirname(compatibilityPath)).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(compatibilityPath), fs.realpathSync(recoveredPassportPath));
    assert.equal(fs.readFileSync(compatibilityPath, "utf8"), '{"candidate":"sealed"}\n');
    assert.equal(
      exposeRecoveredPassportPath({ resolvedOutput: workspace, recoveredPassportPath }),
      compatibilityPath,
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
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

test("candidate recovery exposes the sealed GitHub artifact attestation policy", () => {
  const downloads = [{ files: [
    { path: "github-artifact-attestation-policy.json", absolutePath: "/sealed/policy.json" },
    { path: "manifest.json", absolutePath: "/sealed/manifest.json" },
  ] }];
  assert.deepEqual(
    recoveredArtifactPathsByBasename(downloads, "github-artifact-attestation-policy.json"),
    ["/sealed/policy.json"],
  );
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
  const advanced = fs.readFileSync(new URL("../.github/workflows/.release-candidate-promote.yml", import.meta.url), "utf8");
  const publicWorkflow = fs.readFileSync(new URL("../.github/workflows/release-candidate-promote.yml", import.meta.url), "utf8");
  const refPromotion = fs.readFileSync(new URL("../.github/workflows/buildchain-ref-promotion.yml", import.meta.url), "utf8");
  const dogfoodFailure = fs.readFileSync(new URL("../.github/workflows/buildchain-candidate-recovery-dogfood-failure.yml", import.meta.url), "utf8");
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
    /name: Bridge recovered Buildchain runtime dependencies\n\s+if: \$\{\{ inputs\.resume-candidate-run-id != '' \}\}/,
  );
  assert.match(
    advanced,
    /ln -s \.\.\/\.\. \.buildchain\/runtime\/node_modules\/@kungfu-tech\/buildchain-alpha/,
  );
  assert.match(
    advanced,
    /ln -s \.\.\/\.\. \.buildchain\/runtime\/node_modules\/@kungfu-tech\/buildchain/,
  );
  assert.match(
    advanced,
    /ln -s \.\.\/\.\.\/\.\.\/\.\.\/framework\/kfx \.buildchain\/runtime\/node_modules\/@kungfu-tech\/kfx/,
  );
  assert.match(advanced, /ln -s \.buildchain\/runtime\/node_modules node_modules/);
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
  assert.match(advanced, /BUILDCHAIN_RELEASE_CANDIDATE_PAYLOAD_ROOT: \$\{\{ steps\.rc\.outputs\.release-candidate-payload-dir \}\}/);
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

test("candidate recovery checks out the exact consumer publication controller", async () => {
  const fs = await import("node:fs");
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/.release-candidate-promote.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /name: Checkout exact consumer publication controller/);
  assert.match(
    workflow,
    /if: \$\{\{ inputs\.resume-candidate-run-id != '' && inputs\.publication-gate-controller-sha != '' \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ inputs\.publication-gate-controller-sha \}\}/);
  assert.match(workflow, /path: \.buildchain\/publication-controller/);
});

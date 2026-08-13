import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  alphaDistTagForPromotion,
  alignMajorBootstrapReleaseImpact,
  versionVerificationAllowedPathsForPromotion,
  assertAllowedLocalChanges,
  assertExpectedPublicationVersion,
  assertChannelPromotionPr,
  assertProviderEnforcedChannelTransaction,
  assertProtectedChannel,
  assertPromotableRepository,
  assertPromotableTargetRef,
  createTreeEquivalentReleaseImpact,
  discoverVersionStateFiles,
  ensureManagedChannelBranchProtection,
  expectedHeadRefForTarget,
  isAllowedReleaseLineRecoveryPath,
  latestAlphaForPatch,
  ownsMajorAlphaChannel,
  parseReleaseLineRef,
  parseTags,
  persistDurableReleaseTransaction,
  promoteBuildchainRefs,
  restoreDurableReleaseTransaction,
  runPublishTransaction,
  resolveTagsForTarget,
  testReleaseCommitMatchesTransactionMaterial,
  runVersionVerification,
  resolveReleaseImpactInput,
  generateReleaseEvidenceInputs,
  resolveProtectedStatusCheckContext,
  releasePassportArtifactFiles,
  selectAlphaTag,
  selectReleaseTag,
  updateVersionStateContents,
  validatePromotionReleaseCandidate,
} = await import("../actions/promote-buildchain-ref/lib.js");
const {
  loadBuildchainConfig,
} = await import("../packages/core/buildchain-config.js");

const {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} = await import("../packages/core/release-line-dry-run.js");
const {
  transitionReleaseTransaction,
} = await import("../packages/core/publish-transaction.js");
const {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} = await import("../packages/core/publication-artifact-candidate.js");
const {
  createPublicationSealedBundle,
} = await import("../packages/core/publication-sealed-bundle.js");
const {
  validateRequiredPublishSourceLock,
  plannedPublicationExactTag,
  collectGitHubReleaseEvidenceAssets,
  publishGitHubReleaseEvidence,
} = await import("../actions/promote-buildchain-ref/index.js");
const {
  containedReleaseExecutionIdentity,
  transactionContainedInRelease,
} = await import("../actions/promote-buildchain-ref/internal/promote-release-channel.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import {
  GENERATED_COMMIT_SIGN_OFF,
  OTHER_SHA,
  SHA,
  alreadyExists,
  createGitMock,
  makeTempWorkspace,
  notFound,
  productionImpactJson,
  protectedChannel,
  run,
  signedGeneratedCommitMessage,
  transientGitHubError,
  versionStateBranchName,
} from "./helpers/promote-buildchain-ref-fixtures.mjs";

test("stable recovery checks the advanced protected head for sealed release material", async () => {
  const requestedSourceSha = "1".repeat(40);
  const protectedMergeSha = "2".repeat(40);
  const sealedMaterialSha = "3".repeat(40);
  const checkedReleaseShas = [];
  const contained = await transactionContainedInRelease(
    {
      octokit: {},
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: requestedSourceSha,
      advancedChannelSha: protectedMergeSha,
      releaseCommitIncludesTransactionHead: async ({
        releaseSha,
        transactionReleaseSha,
      }) => {
        checkedReleaseShas.push(releaseSha);
        return (
          releaseSha === protectedMergeSha &&
          transactionReleaseSha === sealedMaterialSha
        );
      },
    },
    {
      release_sha: sealedMaterialSha,
      release_material_sha: sealedMaterialSha,
    },
  );

  assert.equal(contained, true);
  assert.deepEqual(checkedReleaseShas, [protectedMergeSha]);
});

test("stable recovery reuses the complete transaction publication identity", () => {
  const transaction = {
    state: "complete",
    source_sha: "1".repeat(40),
    release_sha: "2".repeat(40),
    release_material_sha: "3".repeat(40),
    publish_tooling_sha: "4".repeat(40),
  };
  const execution = containedReleaseExecutionIdentity(
    {
      sha: "5".repeat(40),
      advancedPublicationTransaction: transaction,
    },
    {
      containsPublishedMaterial: true,
      currentReleaseTransaction: transaction,
      releaseSha: "6".repeat(40),
    },
  );

  assert.equal(execution.transaction, transaction);
  assert.equal(execution.sourceSha, transaction.source_sha);
  assert.equal(execution.releaseSha, transaction.release_sha);
  assert.equal(execution.releaseMaterialSha, transaction.release_material_sha);
  assert.equal(execution.publishToolingSha, transaction.publish_tooling_sha);
});

test("publish transaction resumes matching alpha durable state refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha0"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "non-matching-alpha-1",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: OTHER_SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.1",
      exact_tag: "v1.0.0-alpha.1",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-1",
      state_path: "",
      evidence_path: "",
      state: "publishing",
      previous_state: "prepared",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });
  const matchingEvidencePath = path.join(cwd, "durable-alpha-0-evidence.json");
  fs.writeFileSync(
    matchingEvidencePath,
    JSON.stringify(
      {
        schema: 1,
        version: "1.0.0-alpha.0",
        channel: "alpha",
        source_sha: SHA,
        release_sha: OTHER_SHA,
        target_ref: "alpha/v1/v1.0",
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        artifacts: [
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0-alpha.0",
            digest: "sha256:alpha0",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "matching-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: matchingEvidencePath,
  });
  fs.unlinkSync(matchingEvidencePath);

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(result.publishTransaction.releaseSha, OTHER_SHA);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), OTHER_SHA);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.equal(
    fs.existsSync(path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.1.json")),
    false,
  );
});

test("publish transaction finalizes current alpha version-state merge commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", mergeSha]]),
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-merge-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), oldAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.equal(
    result.updates.some((update) => update.action === "stale-publish-transaction"),
    false,
  );
});

test("publication planning advances past published alpha material when version-state regeneration changes", async () => {
  const previousReleaseSha = "6".repeat(40);
  const promotionMergeSha = "5".repeat(40);
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "generated.json"
key = "version"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "generated.json": { version: "1.0.0-alpha.0", generated: false },
    "scripts/regenerate.mjs": `
import fs from "node:fs";

const value = JSON.parse(fs.readFileSync("generated.json", "utf8"));
value.generated = true;
fs.writeFileSync("generated.json", JSON.stringify(value, null, 2) + "\\n");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", promotionMergeSha],
      ["heads/dev/v1/v1.0", "7".repeat(40)],
      ["tags/v1.0.0-alpha.0", previousReleaseSha],
      ["tags/v1.0-alpha", promotionMergeSha],
    ]),
  });
  commits.set(promotionMergeSha, {
    sha: promotionMergeSha,
    tree: { sha: `tree-${promotionMergeSha}` },
    parents: [{ sha: previousReleaseSha }, { sha: "8".repeat(40) }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "published-alpha-regeneration",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: previousReleaseSha,
      release_material_sha: previousReleaseSha,
      publish_tooling_sha: previousReleaseSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [{
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      }],
      evidence: [".buildchain/release-evidence/v1.0.0-alpha.0/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: promotionMergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
    verificationCommand: "node scripts/regenerate.mjs",
    expectedPublicationVersion: "1.0.0-alpha.1",
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "advanced-published-transaction"),
    {
      tag: "v1.0.0-alpha.0",
      action: "advanced-published-transaction",
      sha: promotionMergeSha,
    },
  );
  assert.equal(
    result.updates.find((update) => update.action === "dry-run-publish-transaction").version,
    "1.0.0-alpha.1",
  );
});

test("published alpha finalization stays bound to its exact transaction after the protected version-state PR merges", async () => {
  const transactionSourceSha = "1".repeat(40);
  const transactionReleaseSha = "2".repeat(40);
  const channelMergeSha = "3".repeat(40);
  const version = "1.0.0-alpha.0";
  const exactTag = `v${version}`;
  const durableTarballPath = ".buildchain/sealed/durable-alpha.tgz";
  const requestedTarballPath = ".buildchain/sealed/version-state-rebuild.tgz";
  const durableAssetPath = ".buildchain/sealed/durable-passport.json";
  const requestedAssetPath = ".buildchain/sealed/version-state-passport.json";
  const durableTarballBytes = Buffer.from("durable published alpha bytes", "utf8");
  const requestedTarballBytes = Buffer.from("rebuilt version-state alpha bytes", "utf8");
  const durableAssetBytes = Buffer.from('{"source":"durable"}\n', "utf8");
  const requestedAssetBytes = Buffer.from('{"source":"version-state"}\n', "utf8");
  const durableIntegrity =
    `sha512-${crypto.createHash("sha512").update(durableTarballBytes).digest("base64")}`;
  const artifact = {
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: version,
    digest: durableIntegrity,
    integrity: durableIntegrity,
  };
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version,
      packageManager: "pnpm@11.7.0",
    },
  });
  for (const [relativePath, bytes] of [
    [durableTarballPath, durableTarballBytes],
    [requestedTarballPath, requestedTarballBytes],
    [durableAssetPath, durableAssetBytes],
    [requestedAssetPath, requestedAssetBytes],
  ]) {
    const target = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const createCandidate = ({ relativePath, bytes, assetPath, assetBytes, sourceSha }) => {
    const payload = {
      schemaVersion: 1,
      contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
      repository: "kungfu-systems/buildchain",
      sourceSha,
      sourceTreeSha: crypto.createHash("sha1").update(bytes).digest("hex"),
      runtimeSha: "4".repeat(40),
      manifestDigest: "5".repeat(64),
      passportDigest: "6".repeat(64),
      controllerReceiptDigest: "7".repeat(64),
      files: [
        { path: relativePath, bytes },
        { path: assetPath, bytes: assetBytes },
      ]
        .map((entry) => ({
          path: entry.path,
          size: entry.bytes.length,
          sha256: crypto.createHash("sha256").update(entry.bytes).digest("hex"),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    return {
      ...payload,
      candidateDigest: publicationArtifactCandidateDigest(payload),
    };
  };
  const durableManifest = createPublicationSealedBundle({
    candidate: createCandidate({
      relativePath: durableTarballPath,
      bytes: durableTarballBytes,
      assetPath: durableAssetPath,
      assetBytes: durableAssetBytes,
      sourceSha: transactionSourceSha,
    }),
    packageName: "@kungfu-tech/buildchain",
    packageVersion: version,
    npmTarballPath: durableTarballPath,
    npmIntegrity: durableIntegrity,
    releaseAssetPaths: [durableAssetPath],
  });
  const requestedIntegrity =
    `sha512-${crypto.createHash("sha512").update(requestedTarballBytes).digest("base64")}`;
  const requestedManifest = createPublicationSealedBundle({
    candidate: createCandidate({
      relativePath: requestedTarballPath,
      bytes: requestedTarballBytes,
      assetPath: requestedAssetPath,
      assetBytes: requestedAssetBytes,
      sourceSha: channelMergeSha,
    }),
    packageName: "@kungfu-tech/buildchain",
    packageVersion: version,
    npmTarballPath: requestedTarballPath,
    npmIntegrity: requestedIntegrity,
    releaseAssetPaths: [requestedAssetPath],
  });
  const requestedManifestPath = path.join(
    cwd,
    ".buildchain/admitted/version-state-sealed-bundle.json",
  );
  fs.mkdirSync(path.dirname(requestedManifestPath), { recursive: true });
  fs.writeFileSync(
    requestedManifestPath,
    `${JSON.stringify(requestedManifest, null, 2)}\n`,
  );
  const evidencePath = path.join(
    cwd,
    ".buildchain/release-evidence",
    exactTag,
    "evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "alpha",
    source_sha: transactionSourceSha,
    release_sha: transactionReleaseSha,
    target_ref: "alpha/v1/v1.0",
    release_material_sha: transactionReleaseSha,
    publish_tooling_sha: transactionReleaseSha,
    artifacts: [artifact],
  }, null, 2) + "\n");
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", channelMergeSha],
      ["heads/dev/v1/v1.0", channelMergeSha],
      [`tags/${exactTag}`, transactionSourceSha],
    ]),
  });
  commits.set(channelMergeSha, {
    sha: channelMergeSha,
    tree: { sha: `tree-${channelMergeSha}` },
    parents: [{ sha: transactionSourceSha }, { sha: transactionReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "contained-published-alpha",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: transactionSourceSha,
      release_sha: transactionReleaseSha,
      release_material_sha: transactionReleaseSha,
      publish_tooling_sha: transactionReleaseSha,
      version,
      exact_tag: exactTag,
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/v1.0.0-alpha.0/evidence.json"],
      sealed_bundle: durableManifest,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath,
    extraFiles: durableManifest.files.map((entry) => ({
      path: `${durableManifest.durablePath}/files/${entry.path}`,
      sourcePath: entry.path,
    })),
  });
  fs.rmSync(path.join(cwd, ".buildchain/release-state"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(cwd, ".buildchain/release-evidence"), {
    recursive: true,
    force: true,
  });

  const plan = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
  });
  assert.deepEqual(
    plan.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version,
      tag: exactTag,
      publicTag: exactTag,
      sha: transactionReleaseSha,
      finalizationOnly: true,
    },
  );

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishSealedBundleRoot: cwd,
    publishSealedBundleManifest: requestedManifestPath,
    publishRequiredArtifactsJson: JSON.stringify([{
      ...artifact,
      digest: requestedIntegrity,
      integrity: requestedIntegrity,
    }]),
    requireVersionState: true,
    expectedPublicationVersion: version,
    releasePassport: false,
  });

  assert.equal(result.sha, channelMergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.releaseSha, transactionReleaseSha);
  assert.equal(
    result.publishTransaction.sealedBundleRoot,
    durableManifest.root,
  );
  const finalizedTransaction = JSON.parse(
    fs.readFileSync(path.join(cwd, result.publishTransaction.statePath), "utf8"),
  );
  assert.equal(finalizedTransaction.artifacts.length, 1);
  assert.equal(finalizedTransaction.artifacts[0].digest, durableIntegrity);
  assert.notEqual(finalizedTransaction.artifacts[0].digest, requestedIntegrity);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), channelMergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), channelMergeSha);
  assert.equal(refs.get(`tags/${exactTag}`), transactionSourceSha);
  assert.equal(refs.get("tags/v1.0-alpha"), transactionReleaseSha);
  assert.equal(refs.get("tags/v1-alpha"), transactionReleaseSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.deepEqual(
    result.updates.find(
      (update) => update.action === "finalized-contained-published-transaction",
    ),
    {
      action: "finalized-contained-published-transaction",
      tag: exactTag,
      sourceSha: transactionSourceSha,
      releaseSha: transactionReleaseSha,
      currentChannelSha: channelMergeSha,
      sha: transactionReleaseSha,
    },
  );
});

test("publish transaction resumes partial alpha finalization with exact tag on release material", async () => {
  const oldAlphaSha = "3".repeat(40);
  const versionHeadSha = "4".repeat(40);
  const mergeSha = "5".repeat(40);
  const previousFinalizedSha = "6".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", mergeSha],
      ["heads/dev/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", previousFinalizedSha],
    ]),
  });
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "7".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-partial-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("heads/alpha/v1/v1.0"), mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
});

test("published alpha recovery accepts the exact protected merge tree after the channel advances", async () => {
  const transactionSourceSha = "3".repeat(40);
  const transactionReleaseSha = "4".repeat(40);
  const requestedMergeSha = "5".repeat(40);
  const currentChannelSha = "6".repeat(40);
  const materialTreeSha = "tree-published-alpha-material";
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", currentChannelSha],
      ["heads/dev/v1/v1.0", currentChannelSha],
      ["tags/v1.0.0-alpha.0", transactionSourceSha],
    ]),
  });
  octokit.rest.repos = {
    compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
  };
  commits.set(transactionReleaseSha, {
    sha: transactionReleaseSha,
    tree: { sha: materialTreeSha },
    parents: [{ sha: transactionSourceSha }],
  });
  commits.set(requestedMergeSha, {
    sha: requestedMergeSha,
    tree: { sha: materialTreeSha },
    parents: [
      { sha: transactionSourceSha },
      { sha: transactionReleaseSha },
    ],
  });
  commits.set(currentChannelSha, {
    sha: currentChannelSha,
    tree: { sha: `tree-${currentChannelSha}` },
    parents: [{ sha: requestedMergeSha }],
  });
  const differentTreeMergeSha = "7".repeat(40);
  commits.set(differentTreeMergeSha, {
    sha: differentTreeMergeSha,
    tree: { sha: "tree-with-additional-content" },
    parents: [
      { sha: transactionSourceSha },
      { sha: transactionReleaseSha },
    ],
  });
  assert.equal(
    await testReleaseCommitMatchesTransactionMaterial({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      releaseSha: requestedMergeSha,
      transactionReleaseShas: [transactionReleaseSha],
    }),
    true,
  );
  assert.equal(
    await testReleaseCommitMatchesTransactionMaterial({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      releaseSha: differentTreeMergeSha,
      transactionReleaseShas: [transactionReleaseSha],
    }),
    false,
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "published-alpha-protected-merge",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: transactionSourceSha,
      release_sha: transactionReleaseSha,
      release_material_sha: transactionReleaseSha,
      publish_tooling_sha: transactionReleaseSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: requestedMergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
    publishTransactionOverride: true,
    requireVersionState: true,
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "resumed-advanced-publication"),
    {
      action: "resumed-advanced-publication",
      ref: "alpha/v1/v1.0",
      requestedSha: requestedMergeSha,
      currentSha: currentChannelSha,
      transactionId: "published-alpha-protected-merge",
      transactionState: "finalizing",
      sha: currentChannelSha,
    },
  );
});

test("completed alpha transaction does not reuse exact tag for new alpha material", async () => {
  const oldAlphaSha = "3".repeat(40);
  const versionHeadSha = "4".repeat(40);
  const mergeSha = "5".repeat(40);
  const previousFinalizedSha = "6".repeat(40);
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:alpha-next"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", mergeSha],
      ["heads/dev/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", previousFinalizedSha],
      ["tags/v1.0-alpha", previousFinalizedSha],
    ]),
  });
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "7".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-complete",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: previousFinalizedSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "complete",
      previous_state: "finalizing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/publish.mjs",
    requireVersionState: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.1",
        digest: "sha256:alpha-next",
      },
    ]),
  });

  assert.notEqual(result.sha, mergeSha);
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.1"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), result.sha);
});

test("publish transaction finalizes current release version-state merge commits", async () => {
  const oldReleaseSha = "d".repeat(40);
  const alphaSha = "e".repeat(40);
  const versionHeadSha = "f".repeat(40);
  const mergeSha = "1".repeat(40);
  const toolingMergeSha = "2".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", toolingMergeSha],
      ["tags/v1.0.0-alpha.0", alphaSha],
    ]),
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: oldReleaseSha }, { sha: versionHeadSha }],
  });
  commits.set(toolingMergeSha, {
    sha: toolingMergeSha,
    tree: { sha: `tree-${toolingMergeSha}` },
    parents: [{ sha: mergeSha }, { sha: "3".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json");
  const distTagEvidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/dist-tag-evidence.json");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify({
      schema: 1,
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      channel: "release",
      source_sha: oldReleaseSha,
      release_sha: versionHeadSha,
      target_ref: "release/v1/v1.0",
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
        },
      ],
    }, null, 2)}\n`,
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "release-merge-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: oldReleaseSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: statePath,
      evidence_path: evidencePath,
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
          role: "main",
          required: true,
        },
      ],
      evidence: [
        ".buildchain/release-evidence/v1.0.0/evidence.json",
        ".buildchain/release-evidence/v1.0.0/dist-tag-evidence.json",
      ],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath,
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: toolingMergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishAuth: "trusted-publishing",
    publishDistTag: "latest",
    publishPackageMain: "@kungfu-tech/buildchain",
    releasePassportImpactJson: productionImpactJson(),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-release",
        role: "main",
      },
    ]),
    requireVersionState: true,
  });

  assert.equal(result.sha, toolingMergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0");
  assert.equal(refs.get("tags/v1.0.0"), oldReleaseSha);
  assert.equal(refs.get("tags/v1.0"), toolingMergeSha);
  assert.equal(refs.get("tags/v1"), toolingMergeSha);
  assert.equal(refs.has("tags/v1.0.1"), false);
  assert.equal(
    result.updates.some((update) => update.action === "stale-publish-transaction"),
    false,
  );
  assert.equal(result.publishTransaction.releasePassportPath, ".buildchain/release-passport/buildchain.release.json");
  const stateCommit = commits.get(result.publishTransaction.releasePassportStateSha);
  const passportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
    entry.path === "release-passport/buildchain.release.json"
  );
  const checkReportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
    entry.path === "release-passport/check-report.json"
  );
  assert.ok(passportEntry);
  assert.ok(checkReportEntry);
  const passport = JSON.parse(Buffer.from(blobs.get(passportEntry.sha).content, "base64").toString("utf8"));
  const checkReport = JSON.parse(Buffer.from(blobs.get(checkReportEntry.sha).content, "base64").toString("utf8"));
  assert.equal(passport.release.sourceSha, oldReleaseSha);
  assert.equal(passport.trustedPublishing.enabled, true);
  assert.equal(passport.trustedPublishing.auth, "trusted-publishing");
  assert.equal(passport.distTagPromotion, undefined);
  assert.equal(checkReport.ok, true);
});

test("release finalization uses the transaction alpha source after next-alpha advances", async () => {
  const oldReleaseSha = "4".repeat(40);
  const alphaZeroSha = "5".repeat(40);
  const alphaOneSha = "6".repeat(40);
  const releaseSourceSha = "7".repeat(40);
  const versionHeadSha = "8".repeat(40);
  const finalMergeSha = "9".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", finalMergeSha],
      ["tags/v1.0.0-alpha.0", alphaZeroSha],
      ["tags/v1.0.0-alpha.1", alphaOneSha],
      ["tags/v1.0-alpha", alphaOneSha],
    ]),
  });
  commits.set(alphaZeroSha, {
    sha: alphaZeroSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [],
  });
  commits.set(alphaOneSha, {
    sha: alphaOneSha,
    tree: { sha: "alpha-one-tree" },
    parents: [],
  });
  commits.set(releaseSourceSha, {
    sha: releaseSourceSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [{ sha: oldReleaseSha }, { sha: alphaZeroSha }],
  });
  commits.set(versionHeadSha, {
    sha: versionHeadSha,
    tree: { sha: "release-version-tree" },
    parents: [{ sha: releaseSourceSha }],
  });
  commits.set(finalMergeSha, {
    sha: finalMergeSha,
    tree: { sha: "final-release-tree" },
    parents: [{ sha: releaseSourceSha }, { sha: versionHeadSha }],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      assert.equal(basehead, `${releaseSourceSha}...${finalMergeSha}`);
      return { data: { files: [{ filename: "package.json" }] } };
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === releaseSourceSha
          ? [
              {
                merged_at: "2026-07-05T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "alpha/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json");
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify({
      schema: 1,
      repository: "kungfu-systems/buildchain",
      version: "1.0.0",
      channel: "release",
      source_sha: releaseSourceSha,
      release_sha: versionHeadSha,
      target_ref: "release/v1/v1.0",
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
        },
      ],
    }, null, 2)}\n`,
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "release-finalization-alpha-source",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: releaseSourceSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: statePath,
      evidence_path: evidencePath,
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
          role: "main",
          required: true,
        },
      ],
      evidence: [".buildchain/release-evidence/v1.0.0/evidence.json"],
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
    },
    evidencePath,
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: finalMergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishAuth: "trusted-publishing",
    publishDistTag: "latest",
    publishPackageMain: "@kungfu-tech/buildchain",
    releasePassportImpactJson: productionImpactJson(),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-release",
        role: "main",
      },
    ]),
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, finalMergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(refs.get("tags/v1.0.0"), releaseSourceSha);
});

test("release finalization merges generated next-alpha state into diverged dev", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "a".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const reconciliationWorkspace = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "dist/site/buildchain-contract.json"
key = "product.version"

[lifecycle.version-state]
command = "node scripts/generate-site-contract.mjs"

[lifecycle.verify]
command = "node scripts/check-site-contract.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "feature.json": { capability: "oci-family-provenance" },
    "dist/site/buildchain-contract.json": {
      product: { version: "1.0.0-alpha.0" },
      capabilities: [],
    },
    "scripts/generate-site-contract.mjs": `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const feature = JSON.parse(fs.readFileSync("feature.json", "utf8"));
fs.writeFileSync("dist/site/buildchain-contract.json", JSON.stringify({
  product: { version: pkg.version },
  capabilities: [feature.capability]
}, null, 2) + "\\n");
`,
    "scripts/check-site-contract.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const feature = JSON.parse(fs.readFileSync("feature.json", "utf8"));
const contract = JSON.parse(fs.readFileSync("dist/site/buildchain-contract.json", "utf8"));
assert.equal(contract.product.version, pkg.version);
assert.deepEqual(contract.capabilities, [feature.capability]);
`,
  });
  run(["git", "init"], reconciliationWorkspace);
  run(["git", "add", "."], reconciliationWorkspace);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ], reconciliationWorkspace);
  const devHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: reconciliationWorkspace,
    encoding: "utf8",
  }).trim();
  const { octokit, refs, blobs, commits, trees, commitLog } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const originalPackageBlob = "blob-package-alpha-0";
  const sharedActionBlob = "blob-action-current";
  const devRetrospectiveBlob = "blob-dev-retrospective";
  const devContractBlob = "blob-dev-contract";
  trees.set("alpha-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("dev-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
    {
      path: ".github/retrospectives/release.md",
      mode: "100644",
      type: "blob",
      sha: devRetrospectiveBlob,
    },
    {
      path: "dist/site/buildchain-contract.json",
      mode: "100644",
      type: "blob",
      sha: devContractBlob,
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaHeadSha }],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });
  const checkRuns = [];
  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/dev/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = {
    create: async (request) => {
      checkRuns.push(request);
      return { data: { id: checkRuns.length } };
    },
  };
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      assert.match(basehead, new RegExp(`^${devHeadSha}\\.\\.\\.commit-\\d+0+$`));
      return {
        data: {
          files: [
            { filename: "package.json" },
            { filename: "actions/promote-buildchain-ref/lib.js" },
          ],
        },
      };
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    reconciliationWorkspace,
    requiredStatusCheck: "check",
  });

  const releaseVersionCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): release v1.0.0"),
  );
  const nextAlphaCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): prepare v1.0.1-alpha.0"),
  );
  const devMergeCommit = commitLog.find((commit) =>
    commit.parents.length === 2 &&
    commit.parents[0] === devHeadSha &&
    commit.parents[1] === nextAlphaCommit.sha,
  );
  assert.ok(releaseVersionCommit);
  assert.ok(nextAlphaCommit);
  assert.ok(devMergeCommit);
  assert.match(devMergeCommit.message, new RegExp(`${GENERATED_COMMIT_SIGN_OFF}$`));
  const reconciledContractEntry = trees.get(devMergeCommit.tree).find(
    (entry) => entry.path === "dist/site/buildchain-contract.json",
  );
  const reconciledContract = JSON.parse(
    Buffer.from(blobs.get(reconciledContractEntry.sha).content, "base64").toString("utf8"),
  );
  assert.deepEqual(reconciledContract, {
    product: { version: "1.0.1-alpha.0" },
    capabilities: ["oci-family-provenance"],
  });
  assert.ok(
    trees.get(devMergeCommit.tree).some(
      (entry) =>
        entry.path === ".github/retrospectives/release.md" &&
        entry.sha === devRetrospectiveBlob,
    ),
  );
  assert.equal(result.sha, releaseVersionCommit.sha);
  assert.equal(result.nextAlphaSha, nextAlphaCommit.sha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaCommit.sha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), devMergeCommit.sha);
  assert.ok(
    checkRuns.some(
      (check) => check.name === "check" && check.head_sha === nextAlphaCommit.sha,
    ),
  );
  assert.ok(
    checkRuns.some(
      (check) => check.name === "check" && check.head_sha === devMergeCommit.sha,
    ),
  );
  assert.ok(
    result.updates.some(
      (update) =>
        update.ref === "dev/v1/v1.0" &&
        update.action === "created-version-state-merge" &&
        update.sha === devMergeCommit.sha &&
        update.sourceSha === nextAlphaCommit.sha &&
        update.currentSha === devHeadSha &&
        update.regenerated === true,
    ),
  );
});

test("completed stable release fails closed when the dev reconciliation checkout moved", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "c".repeat(40);
  const devHeadSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const reconciliationWorkspace = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  run(["git", "init"], reconciliationWorkspace);
  run(["git", "add", "."], reconciliationWorkspace);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "stale checkout",
  ], reconciliationWorkspace);
  const { octokit, refs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const packageBlob = "blob-package-alpha-0";
  trees.set("alpha-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: packageBlob },
  ]);
  trees.set("dev-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: packageBlob },
    {
      path: "docs/concurrent.md",
      mode: "100644",
      type: "blob",
      sha: "blob-concurrent",
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaHeadSha }],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });

  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/dev/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = { create: async () => ({ data: { id: 1 } }) };
  octokit.rest.repos = {
    getBranchProtection: async () => ({ data: protectedChannel() }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    reconciliationWorkspace,
  });

  assert.equal(result.nextAlphaRequired, true);
  assert.match(
    result.updates.find((update) => update.action === "deferred-post-release-bookkeeping")?.reason || "",
    /reconciliation workspace .* does not match current dev\/v1\/v1\.0/,
  );
  assert.ok(refs.has("tags/v1.0.0"));
  assert.equal(refs.get("tags/v1.0"), refs.get("tags/v1.0.0"));
  assert.equal(refs.get("tags/v1"), refs.get("tags/v1.0.0"));
});

test("release finalization merges release ancestry into generated next-alpha", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "a".repeat(40);
  const devHeadSha = "b".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits, trees, commitLog } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const originalPackageBlob = "blob-package-alpha-0";
  const sharedActionBlob = "blob-action-current";
  trees.set("alpha-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("release-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("dev-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "release-tree" },
    parents: [],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/alpha/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = {
    create: async () => ({ data: { id: 1 } }),
  };
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    requiredStatusCheck: "check",
  });

  const releaseVersionCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): release v1.0.0"),
  );
  const nextAlphaCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): prepare v1.0.1-alpha.0"),
  );
  const alphaMergeCommit = commitLog.find((commit) =>
    commit.parents.length === 2 &&
    commit.parents[0] === alphaHeadSha &&
    commit.parents[1] === nextAlphaCommit.sha,
  );
  assert.ok(releaseVersionCommit);
  assert.ok(nextAlphaCommit);
  assert.ok(alphaMergeCommit);
  assert.match(alphaMergeCommit.message, new RegExp(`${GENERATED_COMMIT_SIGN_OFF}$`));
  assert.equal(nextAlphaCommit.parents[0], releaseVersionCommit.sha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaMergeCommit.sha);
  assert.equal(result.nextAlphaSha, alphaMergeCommit.sha);
});

test("strict release promotion accepts a tree-equivalent release-line recovery trigger", async () => {
  const alphaSha = "a".repeat(40);
  const recoveryHeadSha = "b".repeat(40);
  const releaseTriggerSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseTriggerSha],
      ["heads/alpha/v1/v1.0", alphaSha],
      ["heads/dev/v1/v1.0", alphaSha],
      ["tags/v1.0.0-alpha.0", alphaSha],
      ["tags/v1.0-alpha", alphaSha],
    ]),
  });
  const packageBlob = "blob-package-alpha";
  const actionBlob = "blob-action-current";
  trees.set("alpha-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: packageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: actionBlob,
    },
  ]);
  commits.set(alphaSha, {
    sha: alphaSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(recoveryHeadSha, {
    sha: recoveryHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaSha }],
  });
  commits.set(releaseTriggerSha, {
    sha: releaseTriggerSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaSha }, { sha: recoveryHeadSha }],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({ data: protectedChannel() }),
    compareCommitsWithBasehead: async () => {
      throw new Error("tree-equivalent recovery trigger must not use commit-range file checks");
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === releaseTriggerSha
          ? [
              {
                merged_at: "2026-07-09T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "fix/release-line-v1-v1.0-stable-trigger",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseTriggerSha,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
    requiredStatusCheck: "check",
  });

  assert.equal(refs.get("tags/v1.0.0"), result.sha);
  assert.ok(
    result.updates.some(
      (update) =>
        update.action === "accepted-release-recovery-tree-equivalent-source" &&
        update.sha === releaseTriggerSha &&
        update.alphaTag === "v1.0.0-alpha.0",
    ),
  );
});

test("release promotion uses frozen PR alpha evidence when a later same-patch alpha exists", async () => {
  const oldReleaseSha = "4".repeat(40);
  const alphaZeroSha = "5".repeat(40);
  const alphaOneSha = "6".repeat(40);
  const promotionHeadSha = "7".repeat(40);
  const releaseMergeSha = "8".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    group: "node",
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha512-release"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseMergeSha],
      ["tags/v1.0.0-alpha.0", alphaZeroSha],
      ["tags/v1.0.0-alpha.1", alphaOneSha],
      ["tags/v1.0-alpha", alphaOneSha],
    ]),
  });
  commits.set(alphaZeroSha, {
    sha: alphaZeroSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [],
  });
  commits.set(alphaOneSha, {
    sha: alphaOneSha,
    tree: { sha: "alpha-one-tree" },
    parents: [{ sha: alphaZeroSha }],
  });
  commits.set(promotionHeadSha, {
    sha: promotionHeadSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [{ sha: oldReleaseSha }, { sha: alphaZeroSha }],
  });
  commits.set(releaseMergeSha, {
    sha: releaseMergeSha,
    tree: { sha: "alpha-zero-tree" },
    parents: [],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async () => {
      return { data: { files: [{ filename: "package.json" }] } };
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === releaseMergeSha
          ? [
              {
                merged_at: "2026-07-07T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "alpha/v1/v1.0",
                  sha: promotionHeadSha,
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseMergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/publish.mjs",
    publishAuth: "trusted-publishing",
    publishDistTag: "latest",
    publishPackageMain: "@kungfu-tech/buildchain",
    releasePassportImpactJson: productionImpactJson(),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "node",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-release",
        role: "main",
      },
    ]),
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.publishTransaction.exactTag, "v1.0.0");
  assert.equal(refs.get("tags/v1.0.0"), releaseMergeSha);
});

test("complete release transaction converges after its protected version-state merge", async () => {
  const oldReleaseSha = "8".repeat(40);
  const alphaSha = "9".repeat(40);
  const versionHeadSha = "1".repeat(40);
  const previousFinalizedSha = "2".repeat(40);
  const mergeSha = "3".repeat(40);
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "dist/site/site-manifest.json"
key = "version"

[lifecycle.version-state]
command = "node scripts/generate-site-manifest.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
    "dist/site/site-manifest.json": {
      version: "1.0.0",
      generatedAt: "2026-07-01T00:00:00.000Z",
      sourceRevision: versionHeadSha,
    },
    "scripts/generate-site-manifest.mjs": `
import fs from "node:fs";
const manifestPath = "dist/site/site-manifest.json";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
fs.writeFileSync(manifestPath, JSON.stringify({
  ...manifest,
  generatedAt: process.env.BUILDCHAIN_SITE_GENERATED_AT || manifest.generatedAt,
  sourceRevision: process.env.BUILDCHAIN_SOURCE_SHA || manifest.sourceRevision,
}, null, 2) + "\\n");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    cwd,
  );
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", alphaSha],
      ["tags/v1.0.0", previousFinalizedSha],
    ]),
  });
  octokit.rest.repos = {
    compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
  };
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldReleaseSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "4".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "release-partial-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: oldReleaseSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: statePath,
      evidence_path: "",
      state: "complete",
      previous_state: "finalizing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          group: "node",
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-release",
          role: "main",
          required: true,
        },
      ],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const inheritedLifecycleEnv = {
    BUILDCHAIN_SOURCE_SHA: process.env.BUILDCHAIN_SOURCE_SHA,
    BUILDCHAIN_SITE_GENERATED_AT: process.env.BUILDCHAIN_SITE_GENERATED_AT,
  };
  process.env.BUILDCHAIN_SOURCE_SHA = "f".repeat(40);
  process.env.BUILDCHAIN_SITE_GENERATED_AT = "2026-07-24T23:00:00.000Z";
  try {
    const recoveryPlan = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: oldReleaseSha,
      targetRef: "release/v1/v1.0",
      cwd,
      dryRun: true,
      publishTransaction: true,
      publishTransactionOverride: true,
      requireVersionState: true,
      expectedPublicationVersion: "1.0.0",
    });
    assert.equal(recoveryPlan.updates[0].action, "resumed-advanced-publication");
    assert.equal(recoveryPlan.updates[0].currentSha, mergeSha);
    assert.equal(recoveryPlan.updates[0].transactionState, "complete");

    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: mergeSha,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      publishRematerializeOnResume: true,
      requireVersionState: true,
      expectedPublicationVersion: "1.0.0",
    });

    assert.equal(result.sha, mergeSha);
    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(result.publishTransaction.exactTag, "v1.0.0");
    assert.equal(refs.get("heads/release/v1/v1.0"), mergeSha);
    assert.equal(refs.get("tags/v1.0.0"), previousFinalizedSha);
    assert.equal(refs.get("tags/v1.0"), mergeSha);
    assert.equal(refs.get("tags/v1"), mergeSha);
    assert.equal(refs.has("tags/v1.0.1"), false);
    assert.equal(
      result.updates.some(
        (update) =>
          update.action === "created-version-state" &&
          update.version === "1.0.0",
      ),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(inheritedLifecycleEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release promotion does not resume an ancestor transaction for another planned version", async () => {
  const staleReleaseSha = "5".repeat(40);
  const mergeSha = "6".repeat(40);
  const alphaSha = "7".repeat(40);
  const oldTagSha = "8".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.1",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", mergeSha],
      ["tags/v1.0.0", oldTagSha],
      ["tags/v1.0.1-alpha.0", alphaSha],
    ]),
  });
  commits.set(staleReleaseSha, {
    sha: staleReleaseSha,
    tree: { sha: `tree-${staleReleaseSha}` },
    parents: [],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: staleReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-ancestor-release",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: staleReleaseSha,
      release_sha: staleReleaseSha,
      release_material_sha: staleReleaseSha,
      publish_tooling_sha: staleReleaseSha,
      version: "1.0.0",
      exact_tag: "v1.0.0",
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: path.join(cwd, ".buildchain/release-state/1.0.0.json"),
      evidence_path: "",
      state: "publish_failed",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "old publication failed",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "release/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
    expectedPublicationVersion: "1.0.1",
    releasePassport: false,
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version: "1.0.1",
      tag: "v1.0.1",
      publicTag: "v1.0.1",
      sha: mergeSha,
      releaseCandidateVersion: "1.0.1-alpha.0",
    },
  );
  assert.equal(refs.get("tags/v1.0.0"), oldTagSha);
});

test("publish transaction durable ref restores state and evidence in a fresh workspace", async () => {
  const sourceCwd = makeTempWorkspace({});
  const statePath = path.join(sourceCwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(sourceCwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const transaction = {
    schema: 1,
    id: "tx-1",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: evidencePath,
    state: "published",
    previous_state: "publishing",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha256:ok",
        group: "",
        required: true,
      },
    ],
    evidence: [".buildchain/release-evidence/1.0.0/evidence.json"],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version: "1.0.0",
    channel: "release",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    target_ref: "release/v1/v1.0",
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    artifacts: transaction.artifacts,
  }, null, 2) + "\n");

  const { octokit } = createGitMock();
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd: sourceCwd,
    transaction,
    evidencePath,
  });

  const freshCwd = makeTempWorkspace({});
  const freshStatePath = path.join(freshCwd, ".buildchain/release-state/1.0.0.json");
  const freshEvidencePath = path.join(freshCwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const restored = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0",
    statePath: freshStatePath,
    evidencePath: freshEvidencePath,
  });

  assert.equal(restored.id, "tx-1");
  assert.equal(JSON.parse(fs.readFileSync(freshStatePath, "utf8")).id, "tx-1");
  assert.equal(JSON.parse(fs.readFileSync(freshEvidencePath, "utf8")).artifacts[0].digest, "sha256:ok");
});

test("publish transaction can opt in to rematerialize ephemeral Passport inputs on resume", async () => {
  const cwd = makeTempWorkspace({
    "package.json": JSON.stringify({
      name: "@kungfu-tech/rematerialization-fixture",
      version: "1.0.0-alpha.0",
    }, null, 2) + "\n",
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

const countPath = path.join(process.cwd(), ".buildchain/publish-count");
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
fs.mkdirSync(path.dirname(countPath), { recursive: true });
fs.writeFileSync(countPath, String(count));
const witnessPath = path.join(process.cwd(), ".buildchain/release-inputs/witness.json");
fs.mkdirSync(path.dirname(witnessPath), { recursive: true });
fs.writeFileSync(witnessPath, JSON.stringify({
  count,
  packageVersion,
  tarballPath: process.env.BUILDCHAIN_SEALED_NPM_TARBALL || "",
  tarballIntegrity: process.env.BUILDCHAIN_SEALED_NPM_INTEGRITY || ""
}, null, 2) + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/rematerialization-fixture",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + String(count).repeat(64)
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit } = createGitMock();
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const evidencePath = path.join(cwd, ".buildchain/release-evidence/1.0.0/evidence.json");
  const args = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    loadedConfig: loadBuildchainConfig(cwd),
    targetRef: "release/v1/v1.0",
    sourceSha: SHA,
    releaseSha: OTHER_SHA,
    version: "1.0.0",
    exactTag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([{ kind: "npm", name: "@kungfu-tech/rematerialization-fixture", ref_template: "{version}" }]),
    publishEvidencePath: evidencePath,
    transactionStatePath: statePath,
  };

  await runPublishTransaction(args);
  assert.equal(fs.readFileSync(path.join(cwd, ".buildchain/publish-count"), "utf8"), "1");

  fs.rmSync(path.join(cwd, ".buildchain/release-inputs/witness.json"));
  fs.rmSync(statePath);
  fs.rmSync(evidencePath);

  const resumed = await runPublishTransaction({
    ...args,
    publishRematerializeOnResume: true,
  });

  assert.equal(resumed.validation.valid, true);
  assert.equal(fs.readFileSync(path.join(cwd, ".buildchain/publish-count"), "utf8"), "2");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain/release-inputs/witness.json"), "utf8")).count,
    2,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain/release-inputs/witness.json"), "utf8")).packageVersion,
    "1.0.0",
  );
  const witness = JSON.parse(fs.readFileSync(path.join(cwd, ".buildchain/release-inputs/witness.json"), "utf8"));
  assert.match(path.basename(witness.tarballPath), /rematerialization-fixture-1\.0\.0\.tgz$/);
  assert.match(witness.tarballIntegrity, /^sha512-/);
  assert.equal(fs.existsSync(witness.tarballPath), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version, "1.0.0-alpha.0");
  assert.equal(
    JSON.parse(fs.readFileSync(resumed.distTagEvidencePath, "utf8")).source,
    "resume-rematerialized:buildchain.toml",
  );
});

test("publish_failed transaction rematerializes the exact npm version before retry", async () => {
  const cwd = makeTempWorkspace({
    "package.json": JSON.stringify({
      name: "@kungfu-tech/publish-failed-rematerialization-fixture",
      version: "1.0.0-alpha.0",
    }, null, 2) + "\n",
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

const countPath = path.join(process.cwd(), ".buildchain/publish-count");
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0") + 1;
fs.mkdirSync(path.dirname(countPath), { recursive: true });
fs.writeFileSync(countPath, String(count));
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
if (count === 1) {
  fs.writeFileSync("first-publish-witness.txt", packageVersion + "\\n");
  throw new Error("first publish fails");
}
fs.writeFileSync("publish-witness.json", JSON.stringify({
  packageVersion,
  tarballPath: process.env.BUILDCHAIN_SEALED_NPM_TARBALL || ""
}, null, 2) + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/publish-failed-rematerialization-fixture",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + "7".repeat(64)
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit } = createGitMock();
  const args = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    loadedConfig: loadBuildchainConfig(cwd),
    targetRef: "release/v1/v1.0",
    sourceSha: SHA,
    releaseSha: OTHER_SHA,
    version: "1.0.0",
    exactTag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    publishTransaction: true,
    publishRematerializeOnResume: true,
    publishRequiredArtifactsJson: JSON.stringify([{
      kind: "npm",
      name: "@kungfu-tech/publish-failed-rematerialization-fixture",
      ref_template: "{version}",
    }]),
    publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/1.0.0/evidence.json"),
    transactionStatePath: path.join(cwd, ".buildchain/release-state/1.0.0.json"),
  };

  await assert.rejects(runPublishTransaction(args));
  assert.equal(fs.readFileSync(path.join(cwd, "first-publish-witness.txt"), "utf8"), "1.0.0\n");
  assert.equal(JSON.parse(fs.readFileSync(args.transactionStatePath, "utf8")).state, "publish_failed");

  const resumed = await runPublishTransaction({
    ...args,
    publishRematerializeOnResume: true,
  });
  const witness = JSON.parse(fs.readFileSync(path.join(cwd, "publish-witness.json"), "utf8"));

  assert.equal(resumed.validation.valid, true);
  assert.equal(witness.packageVersion, "1.0.0");
  assert.match(path.basename(witness.tarballPath), /publish-failed-rematerialization-fixture-1\.0\.0\.tgz$/);
  assert.equal(fs.existsSync(witness.tarballPath), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).version, "1.0.0-alpha.0");
  assert.equal(
    JSON.parse(fs.readFileSync(resumed.distTagEvidencePath, "utf8")).source,
    "resume-rematerialized:buildchain.toml",
  );
});

test("explicit recovery finalizes an ancestry-bound published transaction without replaying publication", async () => {
  const cwd = makeTempWorkspace({});
  const version = "1.0.0";
  const exactTag = `v${version}`;
  const oldSourceSha = "1".repeat(40);
  const oldReleaseSha = "2".repeat(40);
  const newSourceSha = "3".repeat(40);
  const newReleaseSha = "4".repeat(40);
  const artifact = {
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: version,
    digest: "sha512:published",
  };
  const statePath = path.join(
    cwd,
    ".buildchain/release-state/1.0.0.json",
  );
  const evidencePath = path.join(
    cwd,
    ".buildchain/release-evidence/1.0.0/evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "release",
    source_sha: oldSourceSha,
    release_sha: oldReleaseSha,
    target_ref: "release/v1/v1.0",
    release_material_sha: oldReleaseSha,
    publish_tooling_sha: oldReleaseSha,
    artifacts: [artifact],
  }, null, 2) + "\n");

  const { octokit, commits } = createGitMock();
  commits.set(oldReleaseSha, {
    sha: oldReleaseSha,
    tree: { sha: `tree-${oldReleaseSha}` },
    parents: [],
  });
  commits.set(newReleaseSha, {
    sha: newReleaseSha,
    tree: { sha: `tree-${newReleaseSha}` },
    parents: [{ sha: oldReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "published-stable-recovery",
      repository: "kungfu-systems/buildchain",
      target_ref: "release/v1/v1.0",
      source_sha: oldSourceSha,
      release_sha: oldReleaseSha,
      release_material_sha: oldReleaseSha,
      publish_tooling_sha: oldReleaseSha,
      version,
      exact_tag: exactTag,
      channel: "release",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0",
      state_path: ".buildchain/release-state/1.0.0.json",
      evidence_path: ".buildchain/release-evidence/1.0.0/evidence.json",
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/1.0.0/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath,
  });

  const args = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    targetRef: "release/v1/v1.0",
    sourceSha: newSourceSha,
    releaseSha: newReleaseSha,
    version,
    exactTag,
    channel: "release",
    line: "v1.0",
    publishTransaction: true,
    publishEvidencePath: evidencePath,
    transactionStatePath: statePath,
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
  };

  await assert.rejects(
    runPublishTransaction(args),
    /release transaction identity mismatch/,
  );

  const recovered = await runPublishTransaction({
    ...args,
    explicitOverride: true,
  });

  assert.equal(recovered.transaction.id, "published-stable-recovery");
  assert.equal(recovered.transaction.source_sha, oldSourceSha);
  assert.equal(recovered.transaction.release_sha, oldReleaseSha);
  assert.equal(recovered.transaction.state, "published");
  assert.equal(recovered.validation, undefined);
});

test("publish transaction resumes from durable sealed bytes in a fresh workspace", async () => {
  const version = "0.1.0-alpha.4";
  const sourceCwd = makeTempWorkspace({
    "scripts/publish.mjs": `
import fs from "node:fs";

if (!fs.existsSync(process.env.BUILDCHAIN_SEALED_NPM_TARBALL)) {
  throw new Error("sealed tarball was not provided");
}
process.exitCode = 23;
`,
  });
  const tarballPath = ".buildchain/publication/npm-tarball/paper-0.1.0-alpha.4.tgz";
  const assetPath = "_build/main.pdf";
  const tarballBytes = Buffer.from([
    0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x7f, 0x80, 0xfe, 0x42,
  ]);
  const assetBytes = Buffer.from("%PDF-1.7\nsealed paper\n", "utf8");
  for (const [relativePath, bytes] of [
    [tarballPath, tarballBytes],
    [assetPath, assetBytes],
  ]) {
    const target = path.join(sourceCwd, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const fileEntry = (relativePath) => {
    const bytes = fs.readFileSync(path.join(sourceCwd, relativePath));
    return {
      path: relativePath,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const candidatePayload = {
    schemaVersion: 1,
    contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
    repository: "kungfu-systems/paper",
    sourceSha: SHA,
    sourceTreeSha: "b".repeat(40),
    runtimeSha: "c".repeat(40),
    manifestDigest: "d".repeat(64),
    passportDigest: "e".repeat(64),
    controllerReceiptDigest: "f".repeat(64),
    files: [fileEntry(tarballPath), fileEntry(assetPath)]
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const candidate = {
    ...candidatePayload,
    candidateDigest: publicationArtifactCandidateDigest(candidatePayload),
  };
  const manifest = createPublicationSealedBundle({
    candidate,
    packageName: "@kungfu-tech/paper",
    packageVersion: version,
    npmTarballPath: tarballPath,
    npmIntegrity:
      `sha512-${crypto.createHash("sha512").update(tarballBytes).digest("base64")}`,
    releaseAssetPaths: [assetPath],
  });
  const manifestPath = path.join(
    sourceCwd,
    ".buildchain/admitted/sealed-bundle.json",
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const { octokit } = createGitMock();
  const transactionArgs = {
    octokit,
    owner: "kungfu-systems",
    repo: "paper",
    loadedConfig: { config: {} },
    targetRef: "alpha/v0/v0.1",
    sourceSha: SHA,
    releaseSha: OTHER_SHA,
    version,
    exactTag: `v${version}`,
    channel: "alpha",
    line: "v0.1",
    publishTransaction: true,
    publishCommand: "node scripts/publish.mjs",
    publishRequiredArtifactsJson: JSON.stringify([
      { kind: "npm", name: "@kungfu-tech/paper" },
    ]),
    releaseMaterialSha: OTHER_SHA,
    publishToolingSha: OTHER_SHA,
    actor: "codex",
    runId: "first-attempt",
  };

  await assert.rejects(
    runPublishTransaction({
      ...transactionArgs,
      cwd: sourceCwd,
      publishSealedBundleRoot: sourceCwd,
      publishSealedBundleManifest: manifestPath,
    }),
    /Command failed: node scripts\/publish\.mjs/,
  );
  const interruptedState = JSON.parse(
    fs.readFileSync(
      path.join(sourceCwd, `.buildchain/release-state/v${version}.json`),
      "utf8",
    ),
  );
  assert.equal(interruptedState.state, "publish_failed");
  assert.equal(interruptedState.sealed_bundle.root, manifest.root);

  const freshCwd = makeTempWorkspace({
    "scripts/publish.mjs": `
import crypto from "node:crypto";
import fs from "node:fs";

const tarball = fs.readFileSync(process.env.BUILDCHAIN_SEALED_NPM_TARBALL);
const sha256 = crypto.createHash("sha256").update(tarball).digest("hex");
if (sha256 !== process.env.BUILDCHAIN_SEALED_NPM_SHA256) {
  throw new Error("restored sealed tarball digest mismatch");
}
fs.writeFileSync("publish-input.json", JSON.stringify({
  tarballPath: process.env.BUILDCHAIN_SEALED_NPM_TARBALL,
  sha256,
  integrity: process.env.BUILDCHAIN_SEALED_NPM_INTEGRITY
}, null, 2) + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/paper",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + sha256
  }]
}, null, 2) + "\\n");
`,
  });
  const resumed = await runPublishTransaction({
    ...transactionArgs,
    cwd: freshCwd,
    runId: "fresh-runner-resume",
  });

  const recoveredRoot = path.join(
    freshCwd,
    ".buildchain/recovered-publication",
    version,
  );
  const recoveredTarball = path.join(recoveredRoot, tarballPath);
  const recoveredAsset = path.join(recoveredRoot, assetPath);
  assert.deepEqual(fs.readFileSync(recoveredTarball), tarballBytes);
  assert.deepEqual(fs.readFileSync(recoveredAsset), assetBytes);
  assert.equal(resumed.transaction.state, "published");
  assert.equal(resumed.transaction.publication_state, "package-published");
  assert.equal(resumed.transaction.sealed_bundle.root, manifest.root);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(freshCwd, "publish-input.json"), "utf8"),
    ).tarballPath,
    recoveredTarball,
  );

  const rematerializedCwd = makeTempWorkspace({
    "scripts/publish.mjs": `
import fs from "node:fs";

for (const name of [
  "BUILDCHAIN_SEALED_BUNDLE_ROOT",
  "BUILDCHAIN_SEALED_NPM_TARBALL",
  "BUILDCHAIN_SEALED_NPM_INTEGRITY",
  "BUILDCHAIN_SEALED_NPM_SHA256"
]) {
  if (process.env[name]) {
    throw new Error(name + " must not select restored alpha bytes during rematerialization");
  }
}
fs.writeFileSync("rematerialized-package.txt", process.env.BUILDCHAIN_VERSION + "\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/paper",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:" + "9".repeat(64)
  }]
}, null, 2) + "\\n");
`,
  });
  const rematerialized = await runPublishTransaction({
    ...transactionArgs,
    cwd: rematerializedCwd,
    runId: "fresh-runner-rematerialization",
    publishRematerializeOnResume: true,
  });

  assert.equal(rematerialized.validation.valid, true);
  assert.equal(
    fs.readFileSync(path.join(rematerializedCwd, "rematerialized-package.txt"), "utf8"),
    `${version}\n`,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(rematerialized.distTagEvidencePath, "utf8")).source,
    "resume-rematerialized:workflow-input",
  );
});

test("publish transaction durable ref updates when create races existing ref visibility", async () => {
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const baseTransaction = {
    schema: 1,
    id: "tx-visibility-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const orderFile = path.join(cwd, "order.log");
  const { octokit, refs, commits } = createGitMock({ orderFile });
  const originalUpdateRef = octokit.rest.git.updateRef;
  const updateForces = [];
  octokit.rest.git.updateRef = async (args) => {
    updateForces.push(args.force);
    return originalUpdateRef(args);
  };

  const first = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: baseTransaction,
    evidencePath: "",
  });

  const originalGetRef = octokit.rest.git.getRef;
  let hideStateRefOnce = true;
  octokit.rest.git.getRef = async (args) => {
    if (hideStateRefOnce && args.ref === "heads/buildchain/release-state/1-0-0") {
      hideStateRefOnce = false;
      throw notFound();
    }
    return originalGetRef(args);
  };

  const second = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      ...baseTransaction,
      state: "publishing",
      previous_state: "prepared",
      updated_at: "2026-07-01T00:00:01.000Z",
    },
    evidencePath: "",
  });

  assert.notEqual(second.sha, first.sha);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), second.sha);
  assert.deepEqual(fs.readFileSync(orderFile, "utf8").trim().split("\n"), [
    "create:refs/heads/buildchain/release-state/1-0-0",
    "create:refs/heads/buildchain/release-state/1-0-0",
    "update:heads/buildchain/release-state/1-0-0",
  ]);
  assert.deepEqual(updateForces, [false]);
  assert.deepEqual(
    commits.get(second.sha).parents.map((parent) => parent.sha),
    [first.sha],
  );
});

test("publish transaction durable ref waits out stale ref reads after non-fast-forward", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-update-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "published",
    previous_state: "publishing",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/buildchain/release-state/1-0-0", SHA]]),
  });
  const racingSha = "c".repeat(40);
  const originalUpdateRef = octokit.rest.git.updateRef;
  const originalGetRef = octokit.rest.git.getRef;
  const updateForces = [];
  let rejectOnce = true;
  let staleReadOnce = false;
  octokit.rest.git.updateRef = async (args) => {
    updateForces.push(args.force);
    if (rejectOnce) {
      rejectOnce = false;
      refs.set("heads/buildchain/release-state/1-0-0", racingSha);
      staleReadOnce = true;
      throw Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
        response: { data: { message: "Update is not a fast forward" } },
      });
    }
    return originalUpdateRef(args);
  };
  octokit.rest.git.getRef = async (args) => {
    if (staleReadOnce && args.ref === "heads/buildchain/release-state/1-0-0") {
      staleReadOnce = false;
      return { data: { object: { sha: SHA } } };
    }
    return originalGetRef(args);
  };

  try {
    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
    assert.deepEqual(updateForces, [false, false]);
    assert.deepEqual(
      commits.get(result.sha).parents.map((parent) => parent.sha),
      [racingSha],
    );
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries a non-fast-forward while the durable ref still reports its parent", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-parent-visible",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "publishing",
    previous_state: "prepared",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:01.000Z",
  };
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/buildchain/release-state/1-0-0", SHA]]),
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  let rejectOnce = true;
  let updateAttempts = 0;
  octokit.rest.git.updateRef = async (args) => {
    updateAttempts += 1;
    if (rejectOnce) {
      rejectOnce = false;
      throw Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
        response: { data: { message: "Update is not a fast forward" } },
      });
    }
    return originalUpdateRef(args);
  };

  try {
    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(updateAttempts, 2);
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries transient durable release-state writes", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-transient-write",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  try {
    const { octokit, refs } = createGitMock();
    const originalCreateRef = octokit.rest.git.createRef;
    let createRefCalls = 0;
    octokit.rest.git.createRef = async (args) => {
      createRefCalls += 1;
      if (createRefCalls === 1) {
        throw transientGitHubError();
      }
      return originalCreateRef(args);
    };

    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(createRefCalls, 2);
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries transient durable release-state reads", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const sourceCwd = makeTempWorkspace({});
  const freshCwd = makeTempWorkspace({});
  const statePath = path.join(sourceCwd, ".buildchain/release-state/1.0.0.json");
  const { octokit } = createGitMock();
  try {
    await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd: sourceCwd,
      transaction: {
        schema: 1,
        id: "tx-transient-read",
        repository: "kungfu-systems/buildchain",
        target_ref: "release/v1/v1.0",
        source_sha: SHA,
        release_sha: OTHER_SHA,
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        version: "1.0.0",
        exact_tag: "v1.0.0",
        channel: "release",
        line: "v1.0",
        version_strategy: "",
        lifecycle_identity: "lifecycle.publish",
        state_ref: "buildchain/release-state/1-0-0",
        state_path: statePath,
        evidence_path: "",
        state: "published",
        previous_state: "publishing",
        actor: "codex",
        run_id: "1",
        superseded_by: "",
        failure: "",
        artifacts: [],
        evidence: [],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      evidencePath: "",
    });

    const originalGetTree = octokit.rest.git.getTree;
    let getTreeCalls = 0;
    octokit.rest.git.getTree = async (args) => {
      getTreeCalls += 1;
      if (getTreeCalls === 1) {
        throw transientGitHubError("GitHub API 500: other side closed");
      }
      return originalGetTree(args);
    };

    const restored = await restoreDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      stateRef: "buildchain/release-state/1-0-0",
      statePath: path.join(freshCwd, ".buildchain/release-state/1.0.0.json"),
      evidencePath: path.join(freshCwd, ".buildchain/release-evidence/1.0.0/evidence.json"),
    });

    assert.equal(getTreeCalls >= 2, true);
    assert.equal(restored.id, "tx-transient-read");
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction fails closed when durable state cannot be persisted", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalCreateRef = octokit.rest.git.createRef;
  octokit.rest.git.createRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      throw new Error("durable state write denied");
    }
    return originalCreateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable state write denied/,
  );

  assert.equal(fs.existsSync(path.join(cwd, "order.log")), false);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("publish transaction preserves post-publish failures without publish_failed transition", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: [{
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:published"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  let stateUpdates = 0;
  octokit.rest.git.updateRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      stateUpdates += 1;
      if (stateUpdates >= 2) {
        throw new Error("durable published state write denied");
      }
    }
    return originalUpdateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable published state write denied/,
  );

  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8");
  assert.match(order, /publish/);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("anchored manual release verifies existing anchor state and does not prepare next alpha", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.0",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      nodeCommit: "abc123",
      libnodeRevision: "kf.0",
      npmVersion: "22.22.3-kf.0",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));
const fields = JSON.parse(process.env.BUILDCHAIN_ANCHOR_MANIFEST_JSON);

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(process.env.BUILDCHAIN_VERSION_STRATEGY, "anchored");
assert.equal(process.env.BUILDCHAIN_VERSION_NEXT, "manual");
assert.equal(pkg.version, "22.22.3-kf.0");
assert.equal(anchor.npmVersion, pkg.version);
assert.equal(fields.nodeTag, "v22.22.3");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const refs = new Map([["heads/release/v22/v22.22", SHA]]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        createBlob: async () => {
          throw new Error("anchored manual release should not create version blobs");
        },
        createTree: async () => {
          throw new Error("anchored manual release should not create version trees");
        },
        createCommit: async () => {
          throw new Error("anchored manual release should not create version commits");
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(result.nextAlphaSha, undefined);
  assert.equal(refs.get("heads/release/v22/v22.22"), SHA);
  assert.equal(refs.get("heads/alpha/v22/v22.22"), undefined);
  assert.equal(refs.get("heads/dev/v22/v22.22"), undefined);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22"), SHA);
  assert.equal(refs.get("tags/v22"), SHA);
  assert.equal(refs.get("tags/v22.22-alpha"), undefined);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "anchored-manual-version-state" || update.action === "next-anchor-required")
      .map((update) => [update.action, update.version || update.ref, update.manifest]),
    [
      ["anchored-manual-version-state", "22.22.0", "libnode.release.json"],
      ["next-anchor-required", "dev/v22/v22.22", "libnode.release.json"],
    ],
  );
});

test("publish-gate/major promotion publishes next major production and prepares next alpha", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[[version.files]]
type = "json"
path = "actions/promote-buildchain-ref/package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify-major-bootstrap.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.10",
      private: true,
    },
    "scripts/verify-major-bootstrap.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
assert.equal(process.env.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP, "true");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
assert.match(version, /^2\\.0\\.(?:0|1-alpha\\.0)$/);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ],
    cwd,
  );
  const refs = new Map([["heads/publish-gate/major", SHA]]);
  const blobs = [];
  const commits = [];
  const repoUpdates = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
        createBlob: async ({ content }) => {
          const sha = `blob-${blobs.length + 1}`;
          blobs.push({ sha, content });
          return { data: { sha } };
        },
        createTree: async ({ tree }) => ({
          data: {
            sha: `tree-created-${tree.map((item) => item.sha).join("-")}`,
          },
        }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        update: async (input) => {
          repoUpdates.push(input);
          return {};
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "publish-gate/major",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/publish-gate/major"), releaseSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2"), releaseSha);
  assert.equal(refs.get("heads/alpha/v2/v2.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v2/v2.0",
    },
  ]);
  assert.equal(refs.get("tags/v2.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      [signedGeneratedCommitMessage("chore(release): release v2.0.0"), [SHA]],
      [signedGeneratedCommitMessage("chore(release): prepare v2.0.1-alpha.0"), [releaseSha]],
    ],
  );
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "2.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "2.0.1-alpha.0"')),
  );
});

test("publish-gate/major resumes contained published finalization without selecting the next patch", async () => {
  const transactionSourceSha = "1".repeat(40);
  const transactionReleaseSha = "2".repeat(40);
  const channelMergeSha = "3".repeat(40);
  const version = "2.0.0";
  const exactTag = `v${version}`;
  const artifact = {
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: version,
    digest: "sha512:major0",
  };
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/unexpected-publish.mjs": `
import fs from "node:fs";
fs.writeFileSync("unexpected-publish.txt", "provider mutation reran\\n");
process.exitCode = 9;
`,
  });
  const evidencePath = path.join(
    cwd,
    ".buildchain/release-evidence",
    exactTag,
    "evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "major",
    source_sha: transactionSourceSha,
    release_sha: transactionReleaseSha,
    target_ref: "publish-gate/major",
    release_material_sha: transactionReleaseSha,
    publish_tooling_sha: transactionReleaseSha,
    artifacts: [artifact],
  }, null, 2) + "\n");
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/publish-gate/major", channelMergeSha]]),
  });
  commits.set(channelMergeSha, {
    sha: channelMergeSha,
    tree: { sha: `tree-${channelMergeSha}` },
    parents: [{ sha: transactionSourceSha }, { sha: transactionReleaseSha }],
  });
  const repoUpdates = [];
  octokit.rest.repos = {
    get: async () => ({
      data: { default_branch: "dev/v2/v2.0" },
    }),
    update: async (input) => {
      repoUpdates.push(input);
      return {};
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
      assert.equal(commit_sha, channelMergeSha);
      return {
        data: [
          {
            merged_at: "2026-07-25T00:00:00Z",
            base: { ref: "publish-gate/major" },
            head: {
              ref: "release/v1/v1.0",
              repo: { full_name: "kungfu-systems/buildchain" },
            },
          },
        ],
      };
    },
  };
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "contained-published-major",
      repository: "kungfu-systems/buildchain",
      target_ref: "publish-gate/major",
      source_sha: transactionSourceSha,
      release_sha: transactionReleaseSha,
      release_material_sha: transactionReleaseSha,
      publish_tooling_sha: transactionReleaseSha,
      version,
      exact_tag: exactTag,
      channel: "major",
      line: "v2.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/2-0-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/v2.0.0/evidence.json"],
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    },
    evidencePath,
  });
  fs.rmSync(path.join(cwd, ".buildchain/release-state"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(cwd, ".buildchain/release-evidence"), {
    recursive: true,
    force: true,
  });

  const plan = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
  });
  assert.deepEqual(
    plan.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version,
      tag: exactTag,
      publicTag: exactTag,
      sha: transactionReleaseSha,
      finalizationOnly: true,
    },
  );

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/unexpected-publish.mjs",
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
    requireVersionState: true,
    expectedPublicationVersion: version,
    releasePassport: false,
  });

  const nextAlphaSha = refs.get("heads/alpha/v2/v2.0");
  assert.equal(result.sha, transactionReleaseSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.releaseSha, transactionReleaseSha);
  assert.equal(refs.get("heads/publish-gate/major"), channelMergeSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), transactionReleaseSha);
  assert.equal(refs.get(`tags/${exactTag}`), transactionSourceSha);
  assert.equal(refs.get("tags/v2.0"), transactionReleaseSha);
  assert.equal(refs.get("tags/v2"), transactionReleaseSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0-alpha"), nextAlphaSha);
  assert.equal(refs.get("tags/v2-alpha"), nextAlphaSha);
  assert.equal(refs.has("tags/v2.0.1"), false);
  assert.equal(fs.existsSync(path.join(cwd, "unexpected-publish.txt")), false);
  assert.deepEqual(repoUpdates, []);
  assert.deepEqual(
    result.updates.find(
      (update) => update.action === "existing-default-branch",
    ),
    {
      ref: "dev/v2/v2.0",
      action: "existing-default-branch",
    },
  );

  for (const ref of [
    "heads/alpha/v2/v2.0",
    "heads/dev/v2/v2.0",
    "tags/v2.0.1-alpha.0",
    "tags/v2.0-alpha",
    "tags/v2-alpha",
  ]) {
    refs.delete(ref);
  }

  const completedPlan = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
  });
  assert.equal(
    completedPlan.updates.find((update) =>
      update.action === "dry-run-publish-transaction"
    )?.version,
    version,
  );

  const completedResume = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/unexpected-publish.mjs",
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
    requireVersionState: true,
    expectedPublicationVersion: version,
    releasePassport: false,
  });
  assert.equal(completedResume.publishTransaction.state, "complete");
  assert.equal(refs.get("tags/v2.0.1"), undefined);
  assert.equal(fs.existsSync(path.join(cwd, "unexpected-publish.txt")), false);
  assert.equal(refs.has("heads/alpha/v2/v2.0"), true);
  assert.equal(refs.has("heads/dev/v2/v2.0"), true);
});

test("publish-gate/major finalization opens next-alpha PR from current alpha head", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
  });
  const currentAlphaSha = OTHER_SHA;
  const refs = new Map([
    ["heads/publish-gate/major", SHA],
    ["heads/alpha/v2/v2.0", currentAlphaSha],
  ]);
  const commits = [];
  let createdPullRequest;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v2/v2.0") {
            const error = new Error("Update is not a fast forward");
            error.status = 422;
            error.response = {
              data: { message: "Update is not a fast forward" },
            };
            throw error;
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: "https://github.com/kungfu-systems/buildchain/pull/major-next-alpha",
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
      repos: {
        update: async () => ({}),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "publish-gate/major",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(refs.get("heads/publish-gate/major"), releaseSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v2/v2.0"), currentAlphaSha);
  assert.deepEqual(commits[1].parents, [currentAlphaSha]);
  assert.equal(
    refs.get(`heads/${versionStateBranchName("alpha/v2/v2.0", nextAlphaSha)}`),
    nextAlphaSha,
  );
  assert.equal(createdPullRequest.base, "alpha/v2/v2.0");
  assert.equal(createdPullRequest.head, versionStateBranchName("alpha/v2/v2.0", nextAlphaSha));
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
});

test("publish-gate/major settles a generated next-alpha commit already contained by the protected branch", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.10",
      packageManager: "pnpm@11.7.0",
    },
  });
  const generatedAlphaSha = "b".repeat(40);
  const currentAlphaSha = "c".repeat(40);
  const versionStateBranch = versionStateBranchName(
    "alpha/v2/v2.0",
    generatedAlphaSha,
  );
  const refs = new Map([
    ["heads/publish-gate/major", SHA],
    ["heads/alpha/v2/v2.0", currentAlphaSha],
    [`heads/${versionStateBranch}`, generatedAlphaSha],
    ["tags/v2.0.1-alpha.0", generatedAlphaSha],
  ]);
  const commits = [];
  const branchUpdates = [];
  const comparisons = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          branchUpdates.push({ ref, sha });
          if (ref === "heads/alpha/v2/v2.0") {
            const error = new Error("Update is not a fast forward");
            error.status = 422;
            throw error;
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => {
          assert.fail("contained generated commits should not need an open PR lookup");
        },
        create: async () => {
          assert.fail("contained generated commits should not create a duplicate PR");
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          comparisons.push(basehead);
          return {
            data: {
              status:
                basehead === `${generatedAlphaSha}...${currentAlphaSha}`
                  ? "ahead"
                  : "diverged",
            },
          };
        },
        update: async () => ({}),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-30T00:00:00Z",
                base: { ref: "publish-gate/major" },
                head: {
                  ref: "release/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "publish-gate/major",
    cwd,
  });

  assert.equal(refs.get("heads/alpha/v2/v2.0"), currentAlphaSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), generatedAlphaSha);
  assert.equal(
    branchUpdates.some(({ ref }) => ref === "heads/alpha/v2/v2.0"),
    false,
  );
  assert(comparisons.includes(`${generatedAlphaSha}...${currentAlphaSha}`));
  assert.deepEqual(
    result.updates.find(
      (update) => update.action === "existing-contained-version-state",
    ),
    {
      ref: "alpha/v2/v2.0",
      action: "existing-contained-version-state",
      sha: currentAlphaSha,
      sourceSha: generatedAlphaSha,
    },
  );
});

test("release promotion rerun reuses prepared next alpha version commit", async () => {
  const releaseSha = "c".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", releaseSha],
    ["tags/v1.0.0", releaseSha],
    ["tags/v1.0.1-alpha.0", nextAlphaSha],
  ]);
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref)) {
            return { data: { object: { sha: refs.get(ref) } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: [...refs.entries()]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, objectSha]) => ({
              ref: `refs/${name}`,
              object: { sha: objectSha },
            })),
        }),
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
        createCommit: async () => {
          throw new Error("createCommit should not be called on rerun");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseSha,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    result.updates
      .filter((update) => update.version)
      .map((update) => [update.version, update.action, update.sha]),
    [
      ["1.0.0", "existing-version-state", releaseSha],
      ["1.0.1-alpha.0", "existing-version-state", nextAlphaSha],
    ],
  );
});

test("release recovery reuses protected next-alpha state before exact tags exist", async () => {
  const sourceAlphaSha = "b".repeat(40);
  const releaseSha = "c".repeat(40);
  const preparedAlphaSha = "d".repeat(40);
  const preparedDevSha = "e".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, blobs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseSha],
      ["heads/alpha/v1/v1.0", preparedAlphaSha],
      ["heads/dev/v1/v1.0", preparedDevSha],
      ["tags/v1.0.0-alpha.0", sourceAlphaSha],
      ["tags/v1.0.0", releaseSha],
    ]),
  });
  const addPackageTree = (commitSha, treeSha, blobSha, version, parents = []) => {
    blobs.set(blobSha, {
      content: Buffer.from(JSON.stringify({
        name: "@kungfu-tech/buildchain",
        version,
        packageManager: "pnpm@11.7.0",
      }, null, 2) + "\n").toString("base64"),
      encoding: "base64",
    });
    trees.set(treeSha, [
      { path: "package.json", mode: "100644", type: "blob", sha: blobSha },
    ]);
    commits.set(commitSha, {
      sha: commitSha,
      tree: { sha: treeSha },
      parents: parents.map((sha) => ({ sha })),
    });
  };
  addPackageTree(sourceAlphaSha, "tree-source-alpha", "blob-source-alpha", "1.0.0-alpha.0");
  addPackageTree(releaseSha, "tree-release", "blob-release", "1.0.0", [sourceAlphaSha]);
  addPackageTree(
    preparedAlphaSha,
    "tree-prepared-alpha",
    "blob-prepared-alpha",
    "1.0.1-alpha.0",
    [releaseSha],
  );
  addPackageTree(
    preparedDevSha,
    "tree-prepared-dev",
    "blob-prepared-dev",
    "1.0.1-alpha.0",
    [preparedAlphaSha],
  );

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseSha,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  assert.equal(refs.get("heads/alpha/v1/v1.0"), preparedAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), preparedDevSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), preparedAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), preparedAlphaSha);
  assert.equal(result.nextAlphaSha, preparedAlphaSha);
  assert.deepEqual(
    result.updates.filter(
      (update) => update.action === "existing-compatible-version-state",
    ),
    [
      {
        ref: "alpha/v1/v1.0",
        action: "existing-compatible-version-state",
        sha: preparedAlphaSha,
        version: "1.0.1-alpha.0",
      },
      {
        ref: "dev/v1/v1.0",
        action: "existing-compatible-version-state",
        sha: preparedDevSha,
        version: "1.0.1-alpha.0",
      },
    ],
  );
});

test("release promotion rerun resumes durable stable transaction after alpha advanced", async () => {
  const sourceSha = "c".repeat(40);
  const alphaSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.1",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", sourceSha],
      ["heads/alpha/v1/v1.0", alphaSha],
      ["heads/dev/v1/v1.0", alphaSha],
      ["tags/v1.0.6-alpha.1", alphaSha],
      ["tags/v1.0-alpha", alphaSha],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      id: "tx-resume-stable",
      schema: 1,
      version: "1.0.6",
      exact_tag: "v1.0.6",
      channel: "release",
      source_sha: sourceSha,
      release_sha: "e".repeat(40),
      release_material_sha: "e".repeat(40),
      publish_tooling_sha: "e".repeat(40),
      target_ref: "release/v1/v1.0",
      state_ref: "buildchain/release-state/1-0-6",
      state_path: ".buildchain/release-state/1.0.6.json",
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: sourceSha,
    targetRef: "release/v1/v1.0",
    cwd,
  });

  assert.equal(refs.get("tags/v1.0.6"), sourceSha);
  assert.equal(refs.get("heads/release/v1/v1.0"), result.sha);
  assert.equal(refs.get("tags/v1"), result.sha);
  assert.equal(refs.get("tags/v1.0"), result.sha);
  assert.match(result.nextAlphaSha, /^commit-/);
  assert.equal(refs.get("tags/v1.0.7-alpha.0"), result.nextAlphaSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), result.nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), result.nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), result.nextAlphaSha);
});

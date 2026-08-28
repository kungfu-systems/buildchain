// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("release promotion uses frozen PR alpha evidence when a later same-patch alpha exists", async () => {
  const oldReleaseSha = "4".repeat(40);
  const alphaZeroSha = "5".repeat(40);
  const alphaOneSha = "6".repeat(40);
  const promotionHeadSha = "7".repeat(40);
  const releaseMergeSha = "8".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
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
    "package.json": packageManifest("1.0.0"),
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
    "package.json": packageManifest("1.0.1"),
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

test("stable recovery validates the receipt against the final publication version", async () => {
  const mergeSha = "6".repeat(40);
  const alphaSha = "7".repeat(40);
  const oldTagSha = "8".repeat(40);
  const candidateHash = "a".repeat(64);
  const treeSha = `tree-${mergeSha}`;
  const passportPath = ".buildchain/artifacts/release-candidate-passport.json";
  const recoveryReceiptPath = ".buildchain/artifacts/recovery-receipt.json";
  const passport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-passport",
    repository: "kungfu-systems/buildchain",
    target: {
      channel: "release",
      ref: "release/v1/v1.0",
      version: "22.22.3-kf.0",
    },
    source: { headSha: mergeSha, mergeRefSha: mergeSha, treeHash: treeSha },
    platformMatrix: [
      { platformId: "linux-x64", artifactName: "buildchain-linux-x64" },
    ],
    diagnostics: {},
    candidateHash,
  };
  const recoveryReceipt = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-recovery/v1",
    action: "reused",
    repository: "kungfu-systems/buildchain",
    originalCandidate: { sourceSha: mergeSha, tree: treeSha },
    target: {
      channel: "release",
      ref: "release/v1/v1.0",
      sha: mergeSha,
      tree: treeSha,
      version: "1.0.1",
    },
    recovered: { candidateRoot: `sha256:${candidateHash}` },
    skippedBuildStages: ["install", "build", "verify", "platform-matrix"],
    payloadBytes: "unchanged",
  };
  recoveryReceipt.root = `sha256:${sha256Json(recoveryReceipt)}`;
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.1-alpha.0"),
    [passportPath]: passport,
    [recoveryReceiptPath]: recoveryReceipt,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", mergeSha],
      ["tags/v1.0.0", oldTagSha],
      ["tags/v1.0.1-alpha.0", alphaSha],
    ]),
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: treeSha },
    parents: [],
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
    publishRematerializeOnResume: true,
    requireVersionState: true,
    expectedPublicationVersion: "1.0.1",
    promoteOnlyReleaseCandidate: true,
    releaseCandidatePassportPath: passportPath,
    releaseCandidateRecoveryReceiptPath: recoveryReceiptPath,
    releaseCandidateVersion: "1.0.1-alpha.0",
    releasePassport: false,
  });

  assert.equal(
    result.updates.some(
      (update) =>
        update.action === "verified-release-candidate" &&
        update.publicationVersionBinding === "recovery-receipt",
    ),
    true,
  );
  assert.deepEqual(
    result.updates.find((update) => update.action === "dry-run-version-state"),
    {
      version: "1.0.1",
      action: "dry-run-version-state",
      packageManager: "pnpm",
      files: ["package.json"],
      sha: mergeSha,
    },
  );
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

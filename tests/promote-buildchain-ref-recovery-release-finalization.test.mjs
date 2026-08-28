// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("completed alpha transaction advances once and bounds recovery reads to the current version", async () => {
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
    "package.json": packageManifest("1.0.0-alpha.100"),
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
      ["tags/v1.0.0-alpha.100", previousFinalizedSha],
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
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.100.json");
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
      version: "1.0.0-alpha.100",
      exact_tag: "v1.0.0-alpha.100",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-100",
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

  for (let prerelease = 0; prerelease < 100; prerelease += 1) {
    refs.set(`heads/buildchain/release-state/1-0-0-alpha-${prerelease}`, `state-${prerelease}`);
  }
  const originalGetRef = octokit.rest.git.getRef;
  const durableStateReadRefs = [];
  octokit.rest.git.getRef = async (args) => {
    if (args.ref.startsWith("heads/buildchain/release-state/")) durableStateReadRefs.push(args.ref);
    return originalGetRef(args);
  };

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
        ref: "1.0.0-alpha.101",
        digest: "sha256:alpha-next",
      },
    ]),
  });

  assert.notEqual(result.sha, mergeSha);
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.101");
  assert.equal(refs.get("tags/v1.0.0-alpha.100"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.101"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), result.sha);
  assert.deepEqual([...new Set(durableStateReadRefs)], [
    "heads/buildchain/release-state/1-0-0-alpha-100",
    "heads/buildchain/release-state/1-0-0-alpha-101",
  ]);
});

test("publish transaction finalizes current release version-state merge commits", async () => {
  const oldReleaseSha = "d".repeat(40);
  const alphaSha = "e".repeat(40);
  const versionHeadSha = "f".repeat(40);
  const mergeSha = "1".repeat(40);
  const toolingMergeSha = "2".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0"),
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
    "package.json": packageManifest("1.0.0"),
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

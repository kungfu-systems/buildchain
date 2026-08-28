// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("release existing-version promotion fails before transaction side effects without npm token", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    npm_config__authToken: process.env.npm_config__authToken,
  };
  delete process.env.NODE_AUTH_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.npm_config__authToken;
  try {
    await assert.rejects(
      () =>
        promoteBuildchainRefs({
          octokit,
          owner: "kungfu-systems",
          repo: "buildchain",
          sha: SHA,
          targetRef: "release/v1/v1.0",
          cwd,
          publishTransaction: true,
          publishRequiredArtifactsJson: JSON.stringify([
            {
              kind: "npm",
              name: "@kungfu-tech/buildchain",
              ref: "1.0.0",
              digest: "sha512-existing",
            },
          ]),
        }),
      /requires npm token auth before dist-tag promotion/,
    );
    assert.equal(refs.has("heads/buildchain/release-state/1-0-0"), false);
    assert.equal(refs.has("tags/v1.0.0"), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release final-version trusted publishing rejects alpha package refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "release/v1/v1.0",
        cwd,
        publishTransaction: true,
        publishRequiredArtifactsJson: JSON.stringify([
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0-alpha.0",
            digest: "sha512-alpha",
          },
        ]),
      }),
    /must publish final package refs, not alpha refs/,
  );
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0"), false);
  assert.equal(refs.has("tags/v1.0.0"), false);
});

test("explicit override replaces an unpublished stale alpha transaction identity", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
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
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-alpha-1",
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
      state: "published",
      previous_state: "",
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

  const options = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    tags: ["v1.0.0-alpha.1"],
    cwd,
    requireVersionState: false,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.1",
        digest: "sha256:alpha1",
      },
    ]),
  };

  const result = await promoteBuildchainRefs({
    ...options,
    publishTransactionOverride: true,
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-1");
  assert.equal(refs.get("tags/v1.0.0-alpha.1"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0-alpha-1") !== OTHER_SHA, true);
  const recovered = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0-alpha-1",
    statePath: path.join(cwd, ".buildchain", "release-state.json"),
    evidencePath: path.join(cwd, ".buildchain", "publish-evidence.json"),
  });
  assert.equal(recovered.source_sha, SHA);
  assert.equal(recovered.release_sha, SHA);
  assert.equal(recovered.state, "complete");
});

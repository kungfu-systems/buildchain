// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("strict release promotion rejects code changes after alpha", async () => {
  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", alphaSha],
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
        getCommit: async ({ commit_sha }) => ({
          data: {
            tree: { sha: commit_sha === SHA ? "release-tree" : "alpha-tree" },
            parents: [],
          },
        }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must have the same tree as v1\.0\.2-alpha\.0/,
  );
});


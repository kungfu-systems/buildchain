// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("strict alpha promotion can advance from a generated version-state merge commit", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const nextVersionSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", oldAlphaSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
    ["tags/v1.0.6-alpha.0", oldAlphaSha],
    ["heads/buildchain/release-state/1-0-6-alpha-0", "e".repeat(40)],
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
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: nextVersionSha } }),
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
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, nextVersionSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextVersionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextVersionSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.1"), nextVersionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextVersionSha);
});

test("strict alpha promotion fails closed when dev advanced without an exact reconciliation checkout", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const advancedDevSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", advancedDevSha],
    ["heads/buildchain/release-state/1-0-6-alpha-0", "e".repeat(40)],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
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
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/dev/v1/v1.0") {
            throw Object.assign(new Error("Update is not a fast forward"), {
              status: 422,
              response: { data: { message: "Update is not a fast forward" } },
            });
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: mergeSha,
        targetRef: "alpha/v1/v1.0",
        cwd,
        requireGovernance: true,
        requireVersionState: true,
      }),
    /requires an exact checkout workspace/u,
  );

  assert.equal(refs.get("heads/dev/v1/v1.0"), advancedDevSha);
  assert.equal(refs.has("tags/v1.0.6-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("strict release promotion requires a matching alpha tree and alpha-to-release PR", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
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
            tree: {
              sha: commit_sha === OTHER_SHA ? "old-release-tree" : "alpha-tree",
            },
            parents: [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "d".repeat(40) } }),
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
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "release/v1/v1.0" },
              head: {
                ref: "alpha/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, "d".repeat(40));
  assert.equal(refs.get("tags/v1.0.2"), "d".repeat(40));
});

test("strict release promotion accepts line-scoped buildchain recovery PRs", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2",
      packageManager: "pnpm@11.7.0",
    },
  });
  const alphaSha = "c".repeat(40);
  const nextAlphaSha = "d".repeat(40);
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
            tree: {
              sha: commit_sha === alphaSha ? "alpha-tree" : "recovery-tree",
            },
            parents: [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: nextAlphaSha } }),
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
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.equal(basehead, `${alphaSha}...${SHA}`);
          return {
            data: {
              files: [
                { filename: "package.json" },
                { filename: "actions/promote-buildchain-ref/lib.js" },
                { filename: "actions/promote-buildchain-ref/dist/index.js" },
                { filename: "packages/core/self-dogfood-version.js" },
                { filename: "scripts/check-inventory.mjs" },
                { filename: "scripts/release-line-policy.mjs" },
                { filename: "tests/build-surface.test.mjs" },
                { filename: "tests/promote-buildchain-ref.test.mjs" },
                { filename: "tests/release-line-policy.test.mjs" },
              ],
            },
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-07-01T00:00:00Z",
                    base: {
                      ref: "release/v1/v1.0",
                      sha: alphaSha,
                    },
                    head: {
                      ref: "fix/release-line-v1-v1.0-finalization-recovery",
                      sha: SHA,
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(refs.get("tags/v1.0.2"), SHA);
  assert.equal(refs.get("tags/v1.0.3-alpha.0"), nextAlphaSha);
});

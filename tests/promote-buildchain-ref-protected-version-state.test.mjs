// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("strict alpha promotion uses generated ref update token for protected version-state sync", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "d".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const bypassWrites = [];
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
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref, sha }) => {
          if (ref.startsWith("heads/")) {
            const error = new Error(
              "At least 1 approving review is required by reviewers with write access.",
            );
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
      checks: {
        create: async () => ({ data: { id: 1 } }),
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "release-bot" } }),
      },
      apps: {
        getAuthenticated: async () => ({
          data: { slug: "buildchain-promotion" },
        }),
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        updateBranchProtection: async () => ({ data: {} }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };
  const refUpdateOctokit = {
    rest: {
      git: {
        updateRef: async ({ ref, sha }) => {
          bypassWrites.push(["updateRef", ref, sha]);
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          bypassWrites.push(["createRef", ref, sha]);
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  await promoteBuildchainRefs({
    octokit,
    refUpdateOctokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.deepEqual(
    bypassWrites.filter((write) => write[1].startsWith("heads/")),
    [
      ["updateRef", "heads/dev/v1/v1.0", SHA],
    ],
  );
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
  assert.equal(refs.get("heads/dev/v1/v1.0"), SHA);
});

test("strict alpha promotion protects created dev branches with one required approval", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "d".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const protections = [];
  const checkRuns = [];
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
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            for (const name of ["Build", "security"]) {
              assert.ok(
                checkRuns.find((check) => check.head_sha === sha && check.name === name),
                `generated alpha version-state check ${name} should be created before ref PATCH`,
              );
            }
          }
          if (ref === "heads/dev/v1/v1.0") {
            assert.ok(
              protections.find((protection) => protection.branch === "dev/v1/v1.0"),
              "managed dev branch protection should be updated before ref PATCH",
            );
            for (const name of ["Build", "security"]) {
              assert.ok(
                checkRuns.find((check) => check.head_sha === sha && check.name === name),
                `generated dev version-state check ${name} should be created before ref PATCH`,
              );
            }
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      checks: {
        create: async (request) => {
          checkRuns.push(request);
          return { data: { id: checkRuns.length } };
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({
            required_status_checks: { strict: true, contexts: ["Build", "security"] },
          }),
        }),
        updateBranchProtection: async (request) => {
          protections.push(request);
          return { data: {} };
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
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
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
    requiredStatusCheck: "Build",
    branchProtectionBypassApps: "github-actions",
  });

  const devProtection = protections.find(
    (protection) => protection.branch === "dev/v1/v1.0",
  );
  assert.ok(devProtection);
  assert.deepEqual(devProtection.required_status_checks, {
    strict: true,
    checks: [{ context: "Build", app_id: 15368 }, { context: "security", app_id: 15368 }],
  });
  assert.deepEqual(devProtection.required_pull_request_reviews, {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 1,
    require_last_push_approval: true,
    bypass_pull_request_allowances: {
      apps: ["github-actions"],
      users: [],
      teams: [],
    },
  });
  assert.equal(devProtection.enforce_admins, true);
  assert.equal(devProtection.allow_force_pushes, false);
  assert.equal(devProtection.allow_deletions, false);
  assert.equal(devProtection.required_conversation_resolution, true);
  const policyEvidence = result.updates.find((update) => update.action === "branch-protection-policy" && update.ref === "dev/v1/v1.0");
  assert.deepEqual(policyEvidence.before.requiredStatusChecks, ["Build", "security"]);
  assert.deepEqual(policyEvidence.after.requiredStatusChecks, ["Build", "security"]);
  assert.equal(policyEvidence.policySource, "release-governance-required-status-check");
  assert.equal(checkRuns.length, 2);
  assert.deepEqual(
    checkRuns.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
    [
      {
        name: "Build",
        status: "completed",
        conclusion: "success",
      },
      {
        name: "security",
        status: "completed",
        conclusion: "success",
      },
    ],
  );
});

test("managed channel protection rejects actors outside the exact GitHub Actions App", async () => {
  await assert.rejects(
    () => ensureManagedChannelBranchProtection({
      octokit: {
        rest: {
          repos: {
            getBranchProtection: async () => ({ data: protectedChannel() }),
            updateBranchProtection: async () => ({ data: {} }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "buildchain",
      branch: "dev/v2/v2.14",
      branchProtectionBypassUsers: "release-owner",
    }),
    /permits only the descriptor-bound github-actions App bypass actor/,
  );
  await assert.rejects(
    () => ensureManagedChannelBranchProtection({
      octokit: {
        rest: {
          repos: {
            getBranchProtection: async () => ({ data: protectedChannel() }),
            updateBranchProtection: async () => ({ data: {} }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "buildchain",
      branch: "dev/v2/v2.14",
      branchProtectionBypassApps: "buildchain-promotion",
    }),
    /permits only the descriptor-bound github-actions App bypass actor/,
  );
});

test("strict alpha promotion accepts reviewed version-state PRs from a legal parent", async () => {
  const versionSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.1-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", versionSha],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
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
            parents: commit_sha === versionSha ? [{ sha: SHA }] : [],
          },
        }),
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
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "dev/v1/v1.0",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/cccccccccccc",
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
    sha: versionSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, versionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), versionSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), versionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), versionSha);
});

test("strict alpha promotion accepts merged generated version-state PR commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
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

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
});


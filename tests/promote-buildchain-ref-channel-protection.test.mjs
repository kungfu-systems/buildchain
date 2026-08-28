// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("promote-only RC passport tolerates legacy unbound target channel", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "none", ref: "", version: "source-aaaaaaaaaaaa" },
      source: { headSha: SHA, mergeRefSha: SHA, treeHash: `tree-${SHA}` },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  try {
    const result = validatePromotionReleaseCandidate({
      cwd,
      repository: "kungfu-systems/buildchain",
      targetChannel: "alpha",
      sourceHeadSha: SHA,
      sourceTreeSha: `tree-${SHA}`,
    });
    assert.equal(result.platformCount, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("strict alpha promotion requires a protected dev-to-alpha PR", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        createRef: async () => ({}),
        updateRef: async () => ({}),
      },
      repos: {
        getBranchProtection: async ({ branch }) => {
          assert.equal(branch, "alpha/v1/v1.0");
          return {
            data: protectedChannel(),
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
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
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(calls.slice(0, 2), [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["getRef", "tags/v1.0.0-alpha.0"],
  ]);
});

test("strict alpha promotion uses provider transaction evidence when protection details are unreadable", async () => {
  let reviewState = "APPROVED";
  let protectionReadStatus = 403;
  let observedHeadSha = SHA;
  const pullRequestHeadSha = "b".repeat(40);
  const checkedQueries = [];
  const octokit = {
    rest: {
      repos: {
        getBranchProtection: async () => {
          const error = new Error(
            protectionReadStatus === 404
              ? "Not Found"
              : "Resource not accessible by integration",
          );
          error.status = protectionReadStatus;
          throw error;
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              number: 42,
              merged_at: "2026-06-29T00:00:00Z",
              user: { login: "author" },
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                sha: pullRequestHeadSha,
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
        getBranch: async ({ branch }) => {
          assert.equal(branch, "alpha/v1/v1.0");
          return {
            data: {
              protected: true,
              commit: { sha: observedHeadSha },
              protection: {
                required_status_checks: {
                  enforcement_level: "everyone",
                  contexts: ["check"],
                  checks: [{ context: "check", app_id: 15368 }],
                },
              },
            },
          };
        },
      },
      pulls: {
        listReviews: async ({ pull_number }) => {
          assert.equal(pull_number, 42);
          return {
            data: [{ state: reviewState, user: { login: "reviewer" } }],
          };
        },
      },
      checks: {
        listForRef: async ({ ref, check_name: checkName, filter, per_page: perPage }) => {
          checkedQueries.push({ ref, checkName, filter, perPage });
          assert.equal(ref, pullRequestHeadSha);
          return {
            data: {
              total_count: checkName === "check" ? 1 : 226,
              check_runs: checkName === "check"
                ? [{ name: "check", conclusion: "success", app: { id: 15368 } }]
                : Array.from({ length: 100 }, (_, index) => ({
                    name: `decoy-${index}`,
                    conclusion: "success",
                    app: { id: 15368 },
                  })),
            },
          };
        },
      },
    },
  };

  for (const status of [403, 404]) {
    protectionReadStatus = status;
    const resolvedStatusCheck = await assertProtectedChannel({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sourceSha: SHA,
      targetRef: "alpha/v1/v1.0",
      requiredStatusCheck: "check",
    });
    assert.equal(resolvedStatusCheck, "check");
  }
  assert.deepEqual(checkedQueries, [
    { ref: pullRequestHeadSha, checkName: "check", filter: "latest", perPage: 100 },
    { ref: pullRequestHeadSha, checkName: "check", filter: "latest", perPage: 100 },
  ]);

  observedHeadSha = OTHER_SHA;
  const recoveredStatusCheck = await assertProtectedChannel({ octokit, owner: "kungfu-systems", repo: "buildchain", sourceSha: SHA, expectedChannelSha: OTHER_SHA, targetRef: "alpha/v1/v1.0", requiredStatusCheck: "check" });
  assert.equal(recoveredStatusCheck, "check");
  await assert.rejects(assertProtectedChannel({ octokit, owner: "kungfu-systems", repo: "buildchain", sourceSha: SHA, targetRef: "alpha/v1/v1.0", requiredStatusCheck: "check" }), /must still point at the exact admitted channel head/);

  reviewState = "CHANGES_REQUESTED";
  await assert.rejects(
    assertProtectedChannel({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sourceSha: SHA,
      targetRef: "alpha/v1/v1.0",
      requiredStatusCheck: "check",
    }),
    /must have an independent approving review/,
  );
});

test("managed channels reuse provider-enforced policy when protection details are unreadable", async () => {
  let requiredContexts = ["check"];
  let protectionReadStatus = 403;
  const octokit = {
    rest: {
      repos: {
        getBranchProtection: async () => {
          const error = new Error(
            protectionReadStatus === 404
              ? "Not Found"
              : "Resource not accessible by integration",
          );
          error.status = protectionReadStatus;
          throw error;
        },
        getBranch: async () => ({
          data: {
            protected: true,
            protection: {
              required_status_checks: {
                enforcement_level: "everyone",
                contexts: requiredContexts,
                checks: requiredContexts.map((context) => ({
                  context,
                  app_id: 15368,
                })),
              },
            },
          },
        }),
        updateBranchProtection: async () => {
          assert.fail("provider-enforced existing policy must not be rewritten");
        },
      },
    },
  };

  const evidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "alpha/v1/v1.0",
    requiredStatusCheck: "check",
  });
  assert.equal(evidence.action, "branch-protection-policy-observed");
  assert.equal(evidence.policySource, "provider-enforced-existing-policy");
  assert.deepEqual(evidence.after.requiredStatusChecks, ["check"]);

  protectionReadStatus = 404;
  const hiddenEvidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "alpha/v1/v1.0",
    requiredStatusCheck: "check",
  });
  assert.equal(hiddenEvidence.action, "branch-protection-policy-observed");
  assert.deepEqual(hiddenEvidence.after.requiredStatusChecks, ["check"]);

  requiredContexts = ["security"];
  await assert.rejects(
    ensureManagedChannelBranchProtection({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      branch: "alpha/v1/v1.0",
      requiredStatusCheck: "check",
    }),
    /must require a check status check using the exact context/,
  );
});

test("strict alpha promotion rejects protection without admin enforcement", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({ enforce_admins: { enabled: false } }),
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must enforce branch protection for administrators/,
  );
});

test("strict alpha promotion reports all missing protected channel settings", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({
            enforce_admins: { enabled: false },
            allow_force_pushes: { enabled: true },
            allow_deletions: { enabled: true },
            required_conversation_resolution: { enabled: false },
            required_pull_request_reviews: {
              required_approving_review_count: 0,
            },
            required_status_checks: { strict: false, contexts: [] },
          }),
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    (error) => {
      assert.match(error.message, /missing required protection settings/);
      assert.match(error.message, /must enforce branch protection for administrators/);
      assert.match(error.message, /must disallow force pushes/);
      assert.match(error.message, /must disallow branch deletion/);
      assert.match(error.message, /must require conversation resolution/);
      assert.match(error.message, /must require at least one approving review/);
      assert.match(error.message, /must require a check status check/);
      return true;
    },
  );
});

test("managed release channels keep required checks without an impossible source-up-to-date loop", async () => {
  const updates = [];
  const protection = protectedChannel({
    required_status_checks: {
      strict: true,
      checks: [
        { context: "check", app_id: 15368 },
        { context: "verify", app_id: 15368 },
      ],
    },
  });
  const octokit = {
    rest: {
      repos: {
        getBranchProtection: async () => ({ data: protection }),
        updateBranchProtection: async (request) => {
          updates.push(request);
          return { data: {} };
        },
      },
    },
  };

  const alphaEvidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "alpha/v2/v2.14",
    requiredStatusCheck: "check",
  });
  assert.equal(updates[0].required_status_checks.strict, false);
  assert.deepEqual(updates[0].required_status_checks.checks, protection.required_status_checks.checks);
  assert.equal(alphaEvidence.after.strict, false);

  protection.required_status_checks.strict = false;
  const devEvidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "dev/v2/v2.14",
    requiredStatusCheck: "check",
  });
  assert.equal(updates[1].required_status_checks.strict, false);
  assert.equal(devEvidence.after.strict, false);
});

test("strict alpha promotion rejects protection bypass surfaces", async () => {
  for (const [override, pattern] of [
    [
      { allow_force_pushes: { enabled: true } },
      /must disallow force pushes/,
    ],
    [
      { allow_deletions: { enabled: true } },
      /must disallow branch deletion/,
    ],
    [
      { required_conversation_resolution: { enabled: false } },
      /must require conversation resolution/,
    ],
  ]) {
    const octokit = {
      rest: {
        git: {
          getRef: async ({ ref }) => {
            if (ref === "heads/alpha/v1/v1.0") {
              return { data: { object: { sha: SHA } } };
            }
            throw notFound();
          },
          listMatchingRefs: async () => ({ data: [] }),
        },
        repos: {
          getBranchProtection: async () => ({
            data: protectedChannel(override),
          }),
        },
      },
    };

    await assert.rejects(
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        versionState: false,
        requireGovernance: true,
      }),
      pattern,
    );
  }
});

test("strict alpha promotion rejects missing PR lineage", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "feature/direct",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must come from a merged same-repository PR dev\/v1\/v1\.0 -> alpha\/v1\/v1\.0/,
  );
});

test("strict alpha promotion accepts same-line version-state PR lineage", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
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
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "state-sha" } }),
        listMatchingRefs: async ({ ref }) => {
          if (ref === "tags/v1.0.") {
            return {
              data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
            };
          }
          return { data: [] };
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
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
              merged_at: "2026-07-07T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "buildchain/version-state/alpha-v1-v1.0/123456789abc",
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
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
});


// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("publish-gate/major finalization opens next-alpha PR from current alpha head", async () => {
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.10"),
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
    "package.json": packageManifest("1.0.10"),
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
    "package.json": packageManifest("1.0.0"),
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
    "package.json": packageManifest("1.0.0"),
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
    "package.json": packageManifest("1.0.6-alpha.1"),
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

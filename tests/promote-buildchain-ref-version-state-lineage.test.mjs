// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("strict alpha promotion accepts same-line publish-gate PR lineage", async () => {
  const pullRequest = await assertChannelPromotionPr({
    octokit: {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
            assert.equal(commit_sha, SHA);
            return {
              data: [
                {
                  merged_at: "2026-07-08T00:00:00Z",
                  base: { ref: "alpha/v22/v22.22" },
                  head: {
                    ref: "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.15",
                    repo: { full_name: "kungfu-systems/libnode" },
                  },
                },
              ],
            };
          },
        },
      },
    },
    owner: "kungfu-systems",
    repo: "libnode",
    sha: SHA,
    targetRef: "alpha/v22/v22.22",
  });

  assert.equal(pullRequest.head.ref, "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.15");
});

test("strict alpha promotion rejects publish-gate PR lineage for a different line", async () => {
  await assert.rejects(
    assertChannelPromotionPr({
      octokit: {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({
              data: [
                {
                  merged_at: "2026-07-08T00:00:00Z",
                  base: { ref: "alpha/v22/v22.22" },
                  head: {
                    ref: "publish-gate/alpha/v22/v22.23/22.23.0-alpha.0",
                    repo: { full_name: "kungfu-systems/libnode" },
                  },
                },
              ],
            }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "libnode",
      sha: SHA,
      targetRef: "alpha/v22/v22.22",
    }),
    /publish-gate\/alpha\/\.\.\. -> alpha\/v22\/v22\.22/,
  );
});

test("release channel admission accepts only an exact line-scoped recovery PR", async () => {
  const pullRequest = await assertChannelPromotionPr({
    octokit: {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async () => ({
            data: [
              {
                merged_at: "2026-07-24T00:00:00Z",
                base: { ref: "release/v2/v2.14" },
                head: {
                  ref: "fix/release-line-v2-v2.14-finalization-recovery",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          }),
        },
      },
    },
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v2/v2.14",
  });

  assert.equal(
    pullRequest.head.ref,
    "fix/release-line-v2-v2.14-finalization-recovery",
  );
});

test("release channel admission rejects a recovery PR for another line", async () => {
  await assert.rejects(
    assertChannelPromotionPr({
      octokit: {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({
              data: [
                {
                  merged_at: "2026-07-24T00:00:00Z",
                  base: { ref: "release/v2/v2.14" },
                  head: {
                    ref: "fix/release-line-v2-v2.13-finalization-recovery",
                    repo: { full_name: "kungfu-systems/buildchain" },
                  },
                },
              ],
            }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v2/v2.14",
    }),
    /exact line-scoped channel recovery PR/,
  );
});

test("strict alpha promotion no-ops settled generated version-state commits", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.4-alpha.0", SHA],
    ["tags/v1.0-alpha", SHA],
    ["tags/v1-alpha", SHA],
  ]);
  const writes = [];
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
        createRef: async (args) => {
          writes.push(["createRef", args.ref]);
          return {};
        },
        updateRef: async (args) => {
          writes.push(["updateRef", args.ref]);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => {
          assert.fail("settled alpha version-state commits should not need PR lookup");
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
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.updates, [
    { ref: "alpha/v1/v1.0", action: "already-promoted", sha: SHA },
    { ref: "dev/v1/v1.0", action: "already-promoted", sha: SHA },
    { tag: "v1.0.4-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "existing", sha: SHA },
    { tag: "v1-alpha", action: "existing", sha: SHA },
  ]);
});

test("settled anchored alpha dry-run preserves the exact publication identity", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/kfd",
      version: "1.0.0-alpha.41",
    },
    "release.json": {
      version: "1.0.0-alpha.41",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", SHA],
    ["heads/buildchain/release-state/1-0-0-alpha-41", OTHER_SHA],
    ["tags/v1.0.0-alpha.41", SHA],
    ["tags/v1.0-alpha", SHA],
    ["tags/v1-alpha", SHA],
  ]);
  const { octokit } = createGitMock({ refs });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "kfd",
    allowRepository: "kungfu-systems/kfd",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version: "1.0.0-alpha.41",
      tag: "v1.0.0-alpha.41",
      publicTag: "v1.0.0-alpha.41",
      sha: SHA,
    },
  );
});

test("settled anchored alpha rerun restores its complete transaction without republishing", async () => {
  const version = "1.0.0-alpha.41";
  const exactTag = `v${version}`;
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "alpha"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/kfd",
      version,
    },
    "release.json": { version },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.writeFileSync("publish-must-not-run", "unexpected\n");
`,
  });
  const evidencePath = path.join(
    cwd,
    ".buildchain",
    "release-evidence",
    exactTag,
    "evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "alpha",
    source_sha: SHA,
    release_sha: SHA,
    target_ref: "alpha/v1/v1.0",
    release_material_sha: SHA,
    publish_tooling_sha: SHA,
    artifacts: [{
      kind: "npm",
      name: "@kungfu-tech/kfd",
      ref: version,
      digest: "sha512:kfd-alpha-41",
    }],
  }, null, 2) + "\n");
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.41", SHA],
      ["tags/v1.0-alpha", SHA],
      ["tags/v1-alpha", SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "kfd",
    cwd,
    transaction: {
      schema: 1,
      id: "kfd-alpha-41",
      repository: "kungfu-systems/kfd",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: SHA,
      release_material_sha: SHA,
      publish_tooling_sha: SHA,
      version,
      exact_tag: exactTag,
      channel: "alpha",
      line: "v1.0",
      version_strategy: "anchored",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-41",
      state_path: "",
      evidence_path: "",
      state: "complete",
      previous_state: "finalizing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [{
        kind: "npm",
        name: "@kungfu-tech/kfd",
        ref: version,
        digest: "sha512:kfd-alpha-41",
      }],
      evidence: [],
      created_at: "2026-07-22T00:00:00.000Z",
      updated_at: "2026-07-22T00:00:00.000Z",
    },
    evidencePath,
  });
  fs.rmSync(path.join(cwd, ".buildchain", "release-state"), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, ".buildchain", "release-evidence"), { recursive: true, force: true });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "kfd",
    allowRepository: "kungfu-systems/kfd",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([{
      kind: "npm",
      name: "@kungfu-tech/kfd",
      ref: version,
      digest: "sha512:kfd-alpha-41",
    }]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, exactTag);
  assert.equal(result.publishTransaction.releaseSha, SHA);
  assert.equal(fs.existsSync(path.join(cwd, "publish-must-not-run")), false);
  assert.equal(fs.existsSync(path.join(cwd, result.publishTransaction.evidencePath)), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.41"), SHA);
});

test("strict alpha promotion opens a protected version-state PR when direct sync is rejected", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "c".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  let createdPullRequest;
  const pullRequestOctokit = {
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: "https://github.com/kungfu-systems/buildchain/pull/alpha-version-state",
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
    },
  };
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
        updateRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            const error = new Error(
              "At least 1 approving review is required by reviewers with write access.",
            );
            error.status = 422;
            throw error;
          }
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
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
    pullRequestOctokit,
  });

  const versionStateBranch = versionStateBranchName("alpha/v1/v1.0", versionSha);
  assert.equal(refs.get(`heads/${versionStateBranch}`), versionSha);
  assert.equal(createdPullRequest.base, "alpha/v1/v1.0");
  assert.equal(createdPullRequest.head, versionStateBranch);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
  assert.equal(refs.has("tags/v1.0.1-alpha.0"), false);
});

test("strict alpha promotion returns a pending dev version-state PR after alpha finalization", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
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
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "e".repeat(40) } }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/dev/v1/v1.0") {
            const error = new Error("Changes must be made through a pull request.");
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
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: "https://github.com/kungfu-systems/buildchain/pull/dev-version-state",
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
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
  });

  const versionStateBranch = versionStateBranchName("dev/v1/v1.0", SHA);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
  assert.equal(refs.get(`heads/${versionStateBranch}`), SHA);
  assert.equal(createdPullRequest.base, "dev/v1/v1.0");
  assert.equal(createdPullRequest.head, versionStateBranch);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
  assert.equal(refs.has("tags/v1.0.1-alpha.0"), false);
});

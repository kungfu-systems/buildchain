// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("rerunning the same release SHA reuses exact tags", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (
            ref === "heads/release/v1/v1.0" ||
            ref === "tags/v1.0.0" ||
            ref === "tags/v1.0.1-alpha.0"
          ) {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({
          data: [
            { ref: "refs/tags/v1.0.0", object: { sha: SHA } },
            { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } },
          ],
        }),
        updateRef: async () => ({}),
        createRef: async () => {
          throw new Error("createRef should not be called for exact tags");
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "existing", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
    { tag: "v1-alpha", action: "updated", sha: SHA },
  ]);
});

test("release promotion creates source version commits and points refs at them", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.0-alpha.0",
      private: true,
    },
  });
  const refs = new Map([["heads/release/v1/v1.0", SHA]]);
  const blobs = [];
  const commits = [];
  const repoUpdates = [];
  let getCommitCalls = 0;
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
        getCommit: async ({ commit_sha }) => {
          getCommitCalls += 1;
          if (getCommitCalls === 1) {
            throw Object.assign(new Error("other side closed"), {
              status: 500,
            });
          }
          return { data: { tree: { sha: `tree-${commit_sha}` } } };
        },
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
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(getCommitCalls, 3);
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v1/v1.0",
    },
  ]);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      [signedGeneratedCommitMessage("chore(release): release v1.0.0"), [SHA]],
      [signedGeneratedCommitMessage("chore(release): prepare v1.0.1-alpha.0"), [releaseSha]],
    ],
  );
  assert.equal(blobs.length, 4);
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "1.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "1.0.1-alpha.0"')),
  );
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "created-version-state")
      .map((update) => [update.version, update.packageManager]),
    [
      ["1.0.0", "pnpm"],
      ["1.0.1-alpha.0", "pnpm"],
    ],
  );
});

test("release promotion updates default branch before direct next-alpha sync", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["heads/alpha/v1/v1.0", SHA],
  ]);
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
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
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
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(result.pendingPullRequest, undefined);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v1/v1.0",
    },
  ]);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "updated-default-branch" || update.ref === "alpha/v1/v1.0")
      .map((update) => [update.ref, update.action]),
    [
      ["dev/v1/v1.0", "updated-default-branch"],
      ["alpha/v1/v1.0", "updated"],
    ],
  );
});

test("release finalization merges protected alpha next-alpha ancestry", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["heads/alpha/v1/v1.0", OTHER_SHA],
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
          data: {
            tree: { sha: `tree-${commit_sha}` },
            parents: commit_sha.startsWith("commit-2")
              ? [{ sha: commits[0]?.sha }]
              : [],
          },
        }),
        getTree: async () => ({
          data: { tree: [] },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v1/v1.0" && sha.startsWith("commit-2")) {
            const error = new Error("Update is not a fast forward");
            error.status = 422;
            error.response = {
              data: { message: "Update is not a fast forward" },
            };
            throw error;
          }
          if (ref === "heads/alpha/v1/v1.0" && sha.startsWith("commit-3")) {
            const error = new Error("Repository rule violations found");
            error.status = 422;
            error.response = {
              data: {
                message:
                  "Repository rule violations found: Changes must be made through a pull request.",
              },
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
            html_url: `https://github.com/kungfu-systems/buildchain/pull/test`,
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
    targetRef: "release/v1/v1.0",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  const nextAlphaMergeSha = commits[2].sha;
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), OTHER_SHA);
  assert.deepEqual(commits[1].parents, [releaseSha]);
  assert.deepEqual(commits[2].parents, [OTHER_SHA, nextAlphaSha]);
  assert.deepEqual(createdPullRequest, {
    html_url: "https://github.com/kungfu-systems/buildchain/pull/test",
    head: versionStateBranchName("alpha/v1/v1.0", nextAlphaMergeSha),
    base: "alpha/v1/v1.0",
    title: "Prepare v1.0.1-alpha.0",
  });
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
  assert.equal(
    result.updates.some(
      (update) =>
        update.ref === "alpha/v1/v1.0" &&
        update.action === "created-version-state-merge" &&
        update.sha === nextAlphaMergeSha,
    ),
    true,
  );
  assert.equal(
    result.updates.some(
      (update) =>
        update.ref === "alpha/v1/v1.0" &&
        update.action === "pending-version-state-pr" &&
        update.sha === nextAlphaMergeSha,
    ),
    true,
  );
});

test("publish transaction gates alpha final refs on lifecycle.publish evidence", async () => {
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
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.appendFileSync("order.log", "publish\\n");
fs.writeFileSync("required-artifacts.json", process.env.BUILDCHAIN_REQUIRED_ARTIFACTS + "\\n");
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
    digest: "sha256:alpha"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commitLog } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });

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
      },
    ]),
  });

  const alphaSha = commitLog[0].sha;
  assert.equal(result.sha, alphaSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.failure, "");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-0");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(cwd, "required-artifacts.json"), "utf8")),
    [{
      group: "",
      kind: "npm",
      name: "@kungfu-tech/buildchain",
      ref: "1.0.0-alpha.0",
      digest: "",
      role: "",
      required: true,
    }],
  );
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-0"), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaSha);
  assert.equal(refs.get("tags/v1-alpha"), alphaSha);
  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8").trim().split("\n");
  assert.equal(order[0], "create:refs/heads/buildchain/release-state/1-0-0-alpha-0");
  assert.equal(order.filter((entry) => entry.includes("buildchain/release-state")).length >= 4, true);
  assert.deepEqual(order.filter((entry) => !entry.includes("buildchain/release-state")), [
    "publish",
    "update:heads/alpha/v1/v1.0",
    "create:refs/heads/dev/v1/v1.0",
    "create:refs/tags/v1.0.0-alpha.0",
    "update:tags/v1.0-alpha",
    "update:tags/v1-alpha",
  ]);
});

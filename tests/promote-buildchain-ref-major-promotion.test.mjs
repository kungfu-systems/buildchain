// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("anchored manual release verifies existing anchor state and does not prepare next alpha", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.0",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      nodeCommit: "abc123",
      libnodeRevision: "kf.0",
      npmVersion: "22.22.3-kf.0",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));
const fields = JSON.parse(process.env.BUILDCHAIN_ANCHOR_MANIFEST_JSON);

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(process.env.BUILDCHAIN_VERSION_STRATEGY, "anchored");
assert.equal(process.env.BUILDCHAIN_VERSION_NEXT, "manual");
assert.equal(pkg.version, "22.22.3-kf.0");
assert.equal(anchor.npmVersion, pkg.version);
assert.equal(fields.nodeTag, "v22.22.3");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const refs = new Map([["heads/release/v22/v22.22", SHA]]);
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
        createBlob: async () => {
          throw new Error("anchored manual release should not create version blobs");
        },
        createTree: async () => {
          throw new Error("anchored manual release should not create version trees");
        },
        createCommit: async () => {
          throw new Error("anchored manual release should not create version commits");
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
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(result.nextAlphaSha, undefined);
  assert.equal(refs.get("heads/release/v22/v22.22"), SHA);
  assert.equal(refs.get("heads/alpha/v22/v22.22"), undefined);
  assert.equal(refs.get("heads/dev/v22/v22.22"), undefined);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22"), SHA);
  assert.equal(refs.get("tags/v22"), SHA);
  assert.equal(refs.get("tags/v22.22-alpha"), undefined);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "anchored-manual-version-state" || update.action === "next-anchor-required")
      .map((update) => [update.action, update.version || update.ref, update.manifest]),
    [
      ["anchored-manual-version-state", "22.22.0", "libnode.release.json"],
      ["next-anchor-required", "dev/v22/v22.22", "libnode.release.json"],
    ],
  );
});

test("publish-gate/major promotion publishes next major production and prepares next alpha", async () => {
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
path = "actions/promote-buildchain-ref/package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify-major-bootstrap.mjs"
`,
    "package.json": packageManifest("1.0.10"),
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.10",
      private: true,
    },
    "scripts/verify-major-bootstrap.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
assert.equal(process.env.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP, "true");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
assert.match(version, /^2\\.0\\.(?:0|1-alpha\\.0)$/);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "init",
    ],
    cwd,
  );
  const refs = new Map([["heads/publish-gate/major", SHA]]);
  const blobs = [];
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
          data: { tree: { sha: `tree-${commit_sha}` }, parents: [] },
        }),
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
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/publish-gate/major"), releaseSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0.0"), releaseSha);
  assert.equal(refs.get("tags/v2.0"), releaseSha);
  assert.equal(refs.get("tags/v2"), releaseSha);
  assert.equal(refs.get("heads/alpha/v2/v2.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v2/v2.0",
    },
  ]);
  assert.equal(refs.get("tags/v2.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0-alpha"), nextAlphaSha);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      [signedGeneratedCommitMessage("chore(release): release v2.0.0"), [SHA]],
      [signedGeneratedCommitMessage("chore(release): prepare v2.0.1-alpha.0"), [releaseSha]],
    ],
  );
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "2.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "2.0.1-alpha.0"')),
  );
});

test("publish-gate/major resumes contained published finalization without selecting the next patch", async () => {
  const transactionSourceSha = "1".repeat(40);
  const transactionReleaseSha = "2".repeat(40);
  const channelMergeSha = "3".repeat(40);
  const version = "2.0.0";
  const exactTag = `v${version}`;
  const artifact = {
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: version,
    digest: "sha512:major0",
  };
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.10"),
    "scripts/unexpected-publish.mjs": `
import fs from "node:fs";
fs.writeFileSync("unexpected-publish.txt", "provider mutation reran\\n");
process.exitCode = 9;
`,
  });
  const evidencePath = path.join(
    cwd,
    ".buildchain/release-evidence",
    exactTag,
    "evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "major",
    source_sha: transactionSourceSha,
    release_sha: transactionReleaseSha,
    target_ref: "publish-gate/major",
    release_material_sha: transactionReleaseSha,
    publish_tooling_sha: transactionReleaseSha,
    artifacts: [artifact],
  }, null, 2) + "\n");
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/publish-gate/major", channelMergeSha]]),
  });
  commits.set(channelMergeSha, {
    sha: channelMergeSha,
    tree: { sha: `tree-${channelMergeSha}` },
    parents: [{ sha: transactionSourceSha }, { sha: transactionReleaseSha }],
  });
  const repoUpdates = [];
  octokit.rest.repos = {
    get: async () => ({
      data: { default_branch: "dev/v2/v2.0" },
    }),
    update: async (input) => {
      repoUpdates.push(input);
      return {};
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
      assert.equal(commit_sha, channelMergeSha);
      return {
        data: [
          {
            merged_at: "2026-07-25T00:00:00Z",
            base: { ref: "publish-gate/major" },
            head: {
              ref: "release/v1/v1.0",
              repo: { full_name: "kungfu-systems/buildchain" },
            },
          },
        ],
      };
    },
  };
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "contained-published-major",
      repository: "kungfu-systems/buildchain",
      target_ref: "publish-gate/major",
      source_sha: transactionSourceSha,
      release_sha: transactionReleaseSha,
      release_material_sha: transactionReleaseSha,
      publish_tooling_sha: transactionReleaseSha,
      version,
      exact_tag: exactTag,
      channel: "major",
      line: "v2.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/2-0-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/v2.0.0/evidence.json"],
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    },
    evidencePath,
  });
  fs.rmSync(path.join(cwd, ".buildchain/release-state"), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(cwd, ".buildchain/release-evidence"), {
    recursive: true,
    force: true,
  });

  const plan = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
  });
  assert.deepEqual(
    plan.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version,
      tag: exactTag,
      publicTag: exactTag,
      sha: transactionReleaseSha,
      finalizationOnly: true,
    },
  );

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/unexpected-publish.mjs",
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
    requireVersionState: true,
    expectedPublicationVersion: version,
    releasePassport: false,
  });

  const nextAlphaSha = refs.get("heads/alpha/v2/v2.0");
  assert.equal(result.sha, transactionReleaseSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.releaseSha, transactionReleaseSha);
  assert.equal(refs.get("heads/publish-gate/major"), channelMergeSha);
  assert.equal(refs.get("heads/release/v2/v2.0"), transactionReleaseSha);
  assert.equal(refs.get(`tags/${exactTag}`), transactionSourceSha);
  assert.equal(refs.get("tags/v2.0"), transactionReleaseSha);
  assert.equal(refs.get("tags/v2"), transactionReleaseSha);
  assert.equal(refs.get("heads/dev/v2/v2.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v2.0-alpha"), nextAlphaSha);
  assert.equal(refs.get("tags/v2-alpha"), nextAlphaSha);
  assert.equal(refs.has("tags/v2.0.1"), false);
  assert.equal(fs.existsSync(path.join(cwd, "unexpected-publish.txt")), false);
  assert.deepEqual(repoUpdates, []);
  assert.deepEqual(
    result.updates.find(
      (update) => update.action === "existing-default-branch",
    ),
    {
      ref: "dev/v2/v2.0",
      action: "existing-default-branch",
    },
  );

  for (const ref of [
    "heads/alpha/v2/v2.0",
    "heads/dev/v2/v2.0",
    "tags/v2.0.1-alpha.0",
    "tags/v2.0-alpha",
    "tags/v2-alpha",
  ]) {
    refs.delete(ref);
  }

  const completedPlan = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    dryRun: true,
    publishTransaction: true,
    requireVersionState: true,
  });
  assert.equal(
    completedPlan.updates.find((update) =>
      update.action === "dry-run-publish-transaction"
    )?.version,
    version,
  );

  const completedResume = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: channelMergeSha,
    targetRef: "publish-gate/major",
    cwd,
    publishTransaction: true,
    publishCommand: "node scripts/unexpected-publish.mjs",
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
    requireVersionState: true,
    expectedPublicationVersion: version,
    releasePassport: false,
  });
  assert.equal(completedResume.publishTransaction.state, "complete");
  assert.equal(refs.get("tags/v2.0.1"), undefined);
  assert.equal(fs.existsSync(path.join(cwd, "unexpected-publish.txt")), false);
  assert.equal(refs.has("heads/alpha/v2/v2.0"), true);
  assert.equal(refs.has("heads/dev/v2/v2.0"), true);
});

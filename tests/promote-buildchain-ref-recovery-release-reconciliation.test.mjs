// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("release finalization merges generated next-alpha state into diverged dev", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "a".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const reconciliationWorkspace = makeTempWorkspace({
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
path = "dist/site/buildchain-contract.json"
key = "product.version"

[lifecycle.version-state]
command = "node scripts/generate-site-contract.mjs"

[lifecycle.verify]
command = "node scripts/check-site-contract.mjs"
`,
    "package.json": packageManifest("1.0.0-alpha.0"),
    "feature.json": { capability: "oci-family-provenance" },
    "dist/site/buildchain-contract.json": {
      product: { version: "1.0.0-alpha.0" },
      capabilities: [],
    },
    "scripts/generate-site-contract.mjs": `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const feature = JSON.parse(fs.readFileSync("feature.json", "utf8"));
fs.writeFileSync("dist/site/buildchain-contract.json", JSON.stringify({
  product: { version: pkg.version },
  capabilities: [feature.capability]
}, null, 2) + "\\n");
`,
    "scripts/check-site-contract.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const feature = JSON.parse(fs.readFileSync("feature.json", "utf8"));
const contract = JSON.parse(fs.readFileSync("dist/site/buildchain-contract.json", "utf8"));
assert.equal(contract.product.version, pkg.version);
assert.deepEqual(contract.capabilities, [feature.capability]);
`,
  });
  run(["git", "init"], reconciliationWorkspace);
  run(["git", "add", "."], reconciliationWorkspace);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ], reconciliationWorkspace);
  const devHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: reconciliationWorkspace,
    encoding: "utf8",
  }).trim();
  const { octokit, refs, blobs, commits, trees, commitLog } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const originalPackageBlob = "blob-package-alpha-0";
  const sharedActionBlob = "blob-action-current";
  const devRetrospectiveBlob = "blob-dev-retrospective";
  const devContractBlob = "blob-dev-contract";
  trees.set("alpha-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("dev-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
    {
      path: ".github/retrospectives/release.md",
      mode: "100644",
      type: "blob",
      sha: devRetrospectiveBlob,
    },
    {
      path: "dist/site/buildchain-contract.json",
      mode: "100644",
      type: "blob",
      sha: devContractBlob,
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaHeadSha }],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });
  const checkRuns = [];
  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/dev/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = {
    create: async (request) => {
      checkRuns.push(request);
      return { data: { id: checkRuns.length } };
    },
  };
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      assert.match(basehead, new RegExp(`^${devHeadSha}\\.\\.\\.commit-\\d+0+$`));
      return {
        data: {
          files: [
            { filename: "package.json" },
            { filename: "actions/promote-buildchain-ref/lib.js" },
          ],
        },
      };
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    reconciliationWorkspace,
    requiredStatusCheck: "check",
  });

  const releaseVersionCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): release v1.0.0"),
  );
  const nextAlphaCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): prepare v1.0.1-alpha.0"),
  );
  const devMergeCommit = commitLog.find((commit) =>
    commit.parents.length === 2 &&
    commit.parents[0] === devHeadSha &&
    commit.parents[1] === nextAlphaCommit.sha,
  );
  assert.ok(releaseVersionCommit);
  assert.ok(nextAlphaCommit);
  assert.ok(devMergeCommit);
  assert.match(devMergeCommit.message, new RegExp(`${GENERATED_COMMIT_SIGN_OFF}$`));
  const reconciledContractEntry = trees.get(devMergeCommit.tree).find(
    (entry) => entry.path === "dist/site/buildchain-contract.json",
  );
  const reconciledContract = JSON.parse(
    Buffer.from(blobs.get(reconciledContractEntry.sha).content, "base64").toString("utf8"),
  );
  assert.deepEqual(reconciledContract, {
    product: { version: "1.0.1-alpha.0" },
    capabilities: ["oci-family-provenance"],
  });
  assert.ok(
    trees.get(devMergeCommit.tree).some(
      (entry) =>
        entry.path === ".github/retrospectives/release.md" &&
        entry.sha === devRetrospectiveBlob,
    ),
  );
  assert.equal(result.sha, releaseVersionCommit.sha);
  assert.equal(result.nextAlphaSha, nextAlphaCommit.sha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaCommit.sha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), devMergeCommit.sha);
  assert.ok(
    checkRuns.some(
      (check) => check.name === "check" && check.head_sha === nextAlphaCommit.sha,
    ),
  );
  assert.ok(
    checkRuns.some(
      (check) => check.name === "check" && check.head_sha === devMergeCommit.sha,
    ),
  );
  assert.ok(
    result.updates.some(
      (update) =>
        update.ref === "dev/v1/v1.0" &&
        update.action === "created-version-state-merge" &&
        update.sha === devMergeCommit.sha &&
        update.sourceSha === nextAlphaCommit.sha &&
        update.currentSha === devHeadSha &&
        update.regenerated === true,
    ),
  );
});

test("completed stable release fails closed when the dev reconciliation checkout moved", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "c".repeat(40);
  const devHeadSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const reconciliationWorkspace = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  run(["git", "init"], reconciliationWorkspace);
  run(["git", "add", "."], reconciliationWorkspace);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "stale checkout",
  ], reconciliationWorkspace);
  const { octokit, refs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const packageBlob = "blob-package-alpha-0";
  trees.set("alpha-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: packageBlob },
  ]);
  trees.set("dev-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: packageBlob },
    {
      path: "docs/concurrent.md",
      mode: "100644",
      type: "blob",
      sha: "blob-concurrent",
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaHeadSha }],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });

  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/dev/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = { create: async () => ({ data: { id: 1 } }) };
  octokit.rest.repos = {
    getBranchProtection: async () => ({ data: protectedChannel() }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    reconciliationWorkspace,
  });

  assert.equal(result.nextAlphaRequired, true);
  assert.match(
    result.updates.find((update) => update.action === "deferred-post-release-bookkeeping")?.reason || "",
    /reconciliation workspace .* does not match current dev\/v1\/v1\.0/,
  );
  assert.ok(refs.has("tags/v1.0.0"));
  assert.equal(refs.get("tags/v1.0"), refs.get("tags/v1.0.0"));
  assert.equal(refs.get("tags/v1"), refs.get("tags/v1.0.0"));
});

test("release finalization merges release ancestry into generated next-alpha", async () => {
  const releaseHeadSha = SHA;
  const alphaHeadSha = "a".repeat(40);
  const devHeadSha = "b".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const { octokit, refs, commits, trees, commitLog } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseHeadSha],
      ["heads/alpha/v1/v1.0", alphaHeadSha],
      ["heads/dev/v1/v1.0", devHeadSha],
      ["tags/v1.0.0-alpha.0", alphaHeadSha],
      ["tags/v1.0-alpha", alphaHeadSha],
    ]),
  });
  const originalPackageBlob = "blob-package-alpha-0";
  const sharedActionBlob = "blob-action-current";
  trees.set("alpha-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("release-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  trees.set("dev-tree", [
    {
      path: "package.json",
      mode: "100644",
      type: "blob",
      sha: originalPackageBlob,
    },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: sharedActionBlob,
    },
  ]);
  commits.set(releaseHeadSha, {
    sha: releaseHeadSha,
    tree: { sha: "release-tree" },
    parents: [],
  });
  commits.set(alphaHeadSha, {
    sha: alphaHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(devHeadSha, {
    sha: devHeadSha,
    tree: { sha: "dev-tree" },
    parents: [],
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  octokit.rest.git.updateRef = async (request) => {
    if (request.ref === "heads/alpha/v1/v1.0") {
      const commit = commits.get(request.sha);
      if (commit?.parents?.length === 1) {
        throw Object.assign(new Error("Update is not a fast forward"), {
          status: 422,
          response: { data: { message: "Update is not a fast forward" } },
        });
      }
    }
    return originalUpdateRef(request);
  };
  octokit.rest.checks = {
    create: async () => ({ data: { id: 1 } }),
  };
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseHeadSha,
    targetRef: "release/v1/v1.0",
    cwd,
    requiredStatusCheck: "check",
  });

  const releaseVersionCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): release v1.0.0"),
  );
  const nextAlphaCommit = commitLog.find((commit) =>
    commit.message === signedGeneratedCommitMessage("chore(release): prepare v1.0.1-alpha.0"),
  );
  const alphaMergeCommit = commitLog.find((commit) =>
    commit.parents.length === 2 &&
    commit.parents[0] === alphaHeadSha &&
    commit.parents[1] === nextAlphaCommit.sha,
  );
  assert.ok(releaseVersionCommit);
  assert.ok(nextAlphaCommit);
  assert.ok(alphaMergeCommit);
  assert.match(alphaMergeCommit.message, new RegExp(`${GENERATED_COMMIT_SIGN_OFF}$`));
  assert.equal(nextAlphaCommit.parents[0], releaseVersionCommit.sha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), alphaMergeCommit.sha);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaMergeCommit.sha);
  assert.equal(result.nextAlphaSha, alphaMergeCommit.sha);
});

test("strict release promotion accepts a tree-equivalent release-line recovery trigger", async () => {
  const alphaSha = "a".repeat(40);
  const recoveryHeadSha = "b".repeat(40);
  const releaseTriggerSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const { octokit, refs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", releaseTriggerSha],
      ["heads/alpha/v1/v1.0", alphaSha],
      ["heads/dev/v1/v1.0", alphaSha],
      ["tags/v1.0.0-alpha.0", alphaSha],
      ["tags/v1.0-alpha", alphaSha],
    ]),
  });
  const packageBlob = "blob-package-alpha";
  const actionBlob = "blob-action-current";
  trees.set("alpha-tree", [
    { path: "package.json", mode: "100644", type: "blob", sha: packageBlob },
    {
      path: "actions/promote-buildchain-ref/lib.js",
      mode: "100644",
      type: "blob",
      sha: actionBlob,
    },
  ]);
  commits.set(alphaSha, {
    sha: alphaSha,
    tree: { sha: "alpha-tree" },
    parents: [],
  });
  commits.set(recoveryHeadSha, {
    sha: recoveryHeadSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaSha }],
  });
  commits.set(releaseTriggerSha, {
    sha: releaseTriggerSha,
    tree: { sha: "alpha-tree" },
    parents: [{ sha: alphaSha }, { sha: recoveryHeadSha }],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({ data: protectedChannel() }),
    compareCommitsWithBasehead: async () => {
      throw new Error("tree-equivalent recovery trigger must not use commit-range file checks");
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === releaseTriggerSha
          ? [
              {
                merged_at: "2026-07-09T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "fix/release-line-v1-v1.0-stable-trigger",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ]
          : [],
    }),
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: releaseTriggerSha,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
    requiredStatusCheck: "check",
  });

  assert.equal(refs.get("tags/v1.0.0"), result.sha);
  assert.ok(
    result.updates.some(
      (update) =>
        update.action === "accepted-release-recovery-tree-equivalent-source" &&
        update.sha === releaseTriggerSha &&
        update.alphaTag === "v1.0.0-alpha.0",
    ),
  );
});

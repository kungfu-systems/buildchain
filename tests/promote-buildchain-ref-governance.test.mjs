// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");

test("strict anchored release promotion accepts declared version file and anchor manifest changes", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "libnode.release.json"
derived_files = ["version-witness.json"]

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.version-state]
command = "node scripts/derive.mjs"

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
      npmVersion: "22.22.3-kf.0",
    },
    "version-witness.json": {
      version: "22.22.3-kf.0",
    },
    "scripts/derive.mjs": `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.writeFileSync("version-witness.json", JSON.stringify({ version: pkg.version }, null, 2) + "\\n");
`,
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));
const witness = JSON.parse(fs.readFileSync("version-witness.json", "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(process.env.BUILDCHAIN_VERSION_STRATEGY, "anchored");
assert.equal(process.env.BUILDCHAIN_VERSION_NEXT, "manual");
assert.equal(anchor.npmVersion, "22.22.3-kf.0");
assert.equal(pkg.version, anchor.npmVersion);
assert.equal(witness.version, pkg.version);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v22/v22.22", SHA],
    ["tags/v22.22.0-alpha.0", alphaSha],
  ]);
  const trees = new Map([
    ["alpha-tree", [
      { path: "package.json", mode: "100644", type: "blob", sha: "blob-package-alpha" },
      { path: "libnode.release.json", mode: "100644", type: "blob", sha: "blob-anchor-alpha" },
      { path: "version-witness.json", mode: "100644", type: "blob", sha: "blob-witness-alpha" },
    ]],
    ["release-tree", [
      { path: "package.json", mode: "100644", type: "blob", sha: "blob-package-release" },
      { path: "libnode.release.json", mode: "100644", type: "blob", sha: "blob-anchor-release" },
      { path: "version-witness.json", mode: "100644", type: "blob", sha: "blob-witness-release" },
    ]],
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
              sha: commit_sha === alphaSha ? "alpha-tree" : "release-tree",
            },
            parents: commit_sha === SHA ? [{ sha: alphaSha }] : [],
          },
        }),
        getTree: async ({ tree_sha }) => ({
          data: { tree: trees.get(tree_sha) || [] },
        }),
        getBlob: async ({ file_sha }) => ({
          data: {
            encoding: "base64",
            content: Buffer.from(file_sha).toString("base64"),
          },
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
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data: commit_sha === SHA
            ? [
                {
                  merged_at: "2026-07-02T00:00:00Z",
                  base: { ref: "release/v22/v22.22" },
                  head: {
                    ref: "alpha/v22/v22.22",
                    repo: { full_name: "kungfu-systems/buildchain" },
                  },
                },
              ]
            : [],
        }),
        compareCommitsWithBasehead: async () => {
          return {
            data: {
              files: [
                { filename: "package.json" },
                { filename: "libnode.release.json" },
                { filename: "version-witness.json" },
              ],
            },
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
    targetRef: "release/v22/v22.22",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22"), SHA);
  assert.equal(refs.get("tags/v22"), SHA);
  assert.equal(
    result.versionMaterial.contract,
    "kungfu-buildchain-anchored-version-material/v1",
  );
  assert.deepEqual(
    result.versionMaterial.derivedFiles.map((file) => file.path),
    ["version-witness.json"],
  );
  assert.deepEqual(
    result.versionMaterial.alpha.material.map((file) => file.path),
    ["package.json", "libnode.release.json", "version-witness.json"],
  );
  assert.match(
    result.versionMaterial.release.material[0].sha256,
    /^sha256:[0-9a-f]{64}$/,
  );
});

test("strict anchored release promotion accepts reviewed target PR with only version material changes", async () => {
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
      version: "22.22.3-kf.3",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: "22.22.3-kf.3",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(anchor.npmVersion, "22.22.3-kf.3");
assert.equal(pkg.version, anchor.npmVersion);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const releaseBaseSha = "d".repeat(40);
  const featureParentSha = "e".repeat(40);
  const refs = new Map([
    ["heads/release/v22/v22.22", SHA],
    ["tags/v22.22.0-alpha.2", alphaSha],
  ]);
  const trees = new Map([
    [
      "alpha-tree",
      [
        {
          path: "package.json",
          mode: "100644",
          type: "blob",
          sha: "blob-package-alpha",
        },
        {
          path: "libnode.release.json",
          mode: "100644",
          type: "blob",
          sha: "blob-anchor-alpha",
        },
      ],
    ],
    [
      "release-tree",
      [
        {
          path: "package.json",
          mode: "100644",
          type: "blob",
          sha: "blob-package-release",
        },
        {
          path: "libnode.release.json",
          mode: "100644",
          type: "blob",
          sha: "blob-anchor-release",
        },
      ],
    ],
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
              sha: commit_sha === alphaSha ? "alpha-tree" : "release-tree",
            },
            parents: commit_sha === SHA ? [{ sha: releaseBaseSha }, { sha: featureParentSha }] : [],
          },
        }),
        getTree: async ({ tree_sha }) => ({
          data: { tree: trees.get(tree_sha) || [] },
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
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-07-02T00:00:00Z",
                    base: { ref: "release/v22/v22.22" },
                    head: {
                      ref: "feature/release-kf3-final-v2",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
        compareCommitsWithBasehead: async () => {
          return {
            data: {
              files: [
                { filename: "package.json" },
                { filename: "libnode.release.json" },
              ],
            },
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
    targetRef: "release/v22/v22.22",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(result.nextAlphaRequired, true);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
});

test("promote-only stable release accepts an exact RC tree from a reviewed target PR", async () => {
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
      version: "22.22.3-kf.4",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: "22.22.3-kf.4",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(anchor.npmVersion, "22.22.3-kf.4");
assert.equal(pkg.version, anchor.npmVersion);
`,
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/libnode",
      target: {
        channel: "release",
        ref: "release/v22/v22.22",
        version: "22.22.3-kf.4",
      },
      source: {
        headSha: OTHER_SHA,
        mergeRefSha: OTHER_SHA,
        treeHash: "release-tree",
      },
      platformMatrix: [
        { platformId: "linux-x64", artifactName: "libnode-linux-x64" },
      ],
      diagnostics: {},
    },
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const refs = new Map([
    ["heads/release/v22/v22.22", SHA],
    ["tags/v22.22.0-alpha.0", alphaSha],
  ]);
  const releasePullRequest = {
    html_url: "https://github.com/kungfu-systems/libnode/pull/112",
    merged_at: "2026-07-21T00:00:00Z",
    base: { ref: "release/v22/v22.22" },
    head: {
      ref: "release/libnode-kf4",
      repo: { full_name: "kungfu-systems/libnode" },
    },
  };
  let exposeReleasePullRequest = false;
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
            tree: { sha: commit_sha === alphaSha ? "alpha-tree" : "release-tree" },
            parents: [],
          },
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
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            exposeReleasePullRequest && commit_sha === SHA
              ? [releasePullRequest]
              : [],
        }),
        compareCommitsWithBasehead: async () => ({
          data: {
            files: [
              { filename: "package.json" },
              { filename: "libnode.release.json" },
              { filename: "src/node_api.cc" },
              { filename: "tools/dep_updaters/update-v8.sh" },
            ],
          },
        }),
      },
    },
  };

  try {
    const promotionInput = {
      octokit,
      owner: "kungfu-systems",
      repo: "libnode",
      sha: SHA,
      targetRef: "release/v22/v22.22",
      cwd,
      requireGovernance: true,
      requireVersionState: true,
      promoteOnlyReleaseCandidate: true,
      allowRepository: "kungfu-systems/libnode",
    };
    await assert.rejects(
      promoteBuildchainRefs(promotionInput),
      /merged same-repository PR/,
    );

    exposeReleasePullRequest = true;
    const result = await promoteBuildchainRefs(promotionInput);

    assert.equal(result.sha, SHA);
    assert.equal(refs.get("tags/v22.22.0"), SHA);
    assert.deepEqual(
      result.updates.find(
        (update) => update.action === "accepted-exact-release-candidate-source",
      ),
      {
        action: "accepted-exact-release-candidate-source",
        sha: SHA,
        treeSha: "release-tree",
        builtSourceSha: OTHER_SHA,
        builtSourceTreeSha: "release-tree",
        alphaTag: "v22.22.0-alpha.0",
        alphaSha,
        targetRef: "release/v22/v22.22",
        pullRequest: releasePullRequest.html_url,
      },
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("anchored manual publish transactions use declared package version for durable state", async () => {
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

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"

[lifecycle.verify]
command = "node scripts/verify.mjs"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: "22.22.3-kf.3",
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: "22.22.3-kf.3",
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const anchor = JSON.parse(fs.readFileSync(process.env.BUILDCHAIN_ANCHOR_MANIFEST, "utf8"));

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.0");
assert.equal(pkg.version, anchor.npmVersion);
`,
    "scripts/publish.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.3-kf.3");
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
    group: "libnode",
    kind: "npm",
    name: "@kungfu-tech/libnode",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha512:libnode"
  }]
}, null, 2) + "\\n");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const alphaSha = "c".repeat(40);
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v22/v22.22", SHA],
      ["tags/v22.22.0-alpha.2", alphaSha],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "libnode",
    allowRepository: "kungfu-systems/libnode",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
    publishTransaction: true,
    releasePassportImpactJson: productionImpactJson({
      tag: "v22.22.0",
      line: "v22.22",
      rationale: "Production libnode promotion preserves the anchored Node-compatible surface.",
    }),
    publishRequiredArtifactsJson: JSON.stringify([
      {
        group: "libnode",
        kind: "npm",
        name: "@kungfu-tech/libnode",
        ref: "22.22.3-kf.3",
        digest: "sha512:libnode",
      },
    ]),
  });

  assert.equal(result.nextAlphaRequired, true);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v22.22.0");
  assert.equal(result.publishTransaction.publicReleaseTag, "v22.22.3-kf.3");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/22-22-3-kf-3");
  assert.equal(result.publishTransaction.releasePassportPath, ".buildchain/release-passport/buildchain.release.json");
  const passport = JSON.parse(fs.readFileSync(path.join(cwd, result.publishTransaction.releasePassportPath), "utf8"));
  assert.equal(passport.release.tag, "v22.22.3-kf.3");
  assert.equal(passport.release.publicTag, "v22.22.3-kf.3");
  assert.equal(passport.release.internalTag, "v22.22.0");
  assert.equal(passport.release.internalVersion, "22.22.0");
  assert.equal(passport.release.publishedVersion, "22.22.3-kf.3");
  assert.equal(passport.transaction.exactTag, "v22.22.0");
  assert.equal(passport.transaction.version, "22.22.3-kf.3");
  assert.equal(passport.release.releaseStateRef, "refs/heads/buildchain/release-state/22-22-3-kf-3");
  assert.equal(refs.has("heads/buildchain/release-state/22-22-3-kf-3"), true);
  assert.equal(refs.has("heads/buildchain/release-state/22-22-0"), false);
  assert.equal(refs.get("tags/v22.22.0"), SHA);
  assert.equal(refs.get("tags/v22.22.3-kf.3"), SHA);
});

test("anchored retry safely rebinds a published package transaction from a stale internal tag", async () => {
  const packageVersion = "22.22.3-kf.4";
  const staleTag = "v22.22.0";
  const requestedTag = "v22.22.1";
  const alphaSha = SHA;
  const staleTagSha = "d".repeat(40);
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

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"

[lifecycle.verify]
command = "node scripts/verify.mjs"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/libnode",
      version: packageVersion,
    },
    "libnode.release.json": {
      nodeVersion: "22.22.3",
      nodeTag: "v22.22.3",
      npmVersion: packageVersion,
    },
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/libnode",
      target: {
        channel: "release",
        ref: "release/v22/v22.22",
        version: packageVersion,
      },
      source: {
        headSha: SHA,
        mergeRefSha: SHA,
        treeHash: `tree-${SHA}`,
      },
      platformMatrix: [
        { platformId: "linux-x64", artifactName: "libnode-linux-x64" },
      ],
      diagnostics: {},
    },
    "scripts/verify.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.equal(process.env.BUILDCHAIN_VERSION, "22.22.1");
assert.equal(pkg.version, "${packageVersion}");
`,
    "scripts/publish.mjs": `
throw new Error("validated durable evidence must prevent a second registry publish");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "release material"], cwd);

  const artifact = {
    group: "libnode",
    kind: "npm",
    name: "@kungfu-tech/libnode",
    ref: packageVersion,
    digest: "sha512:libnode",
    role: "main",
    required: true,
  };
  const staleEvidencePath = path.join(
    cwd,
    ".buildchain/release-evidence/v22.22.0/evidence.json",
  );
  fs.mkdirSync(path.dirname(staleEvidencePath), { recursive: true });
  fs.writeFileSync(staleEvidencePath, JSON.stringify({
    schema: 1,
    version: packageVersion,
    channel: "release",
    source_sha: SHA,
    release_sha: SHA,
    target_ref: "release/v22/v22.22",
    release_material_sha: SHA,
    publish_tooling_sha: SHA,
    artifacts: [artifact],
  }, null, 2) + "\n");

  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v22/v22.22", SHA],
      [`tags/${staleTag}`, staleTagSha],
      ["tags/v22.22.1-alpha.0", alphaSha],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "libnode",
    cwd,
    transaction: {
      schema: 1,
      id: "anchored-stale-internal-tag",
      repository: "kungfu-systems/libnode",
      target_ref: "release/v22/v22.22",
      source_sha: SHA,
      release_sha: SHA,
      release_material_sha: SHA,
      publish_tooling_sha: SHA,
      version: packageVersion,
      exact_tag: staleTag,
      channel: "release",
      line: "v22.22",
      version_strategy: "anchored",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/22-22-3-kf-4",
      state_path: ".buildchain/release-state/v22.22.0.json",
      evidence_path: ".buildchain/release-evidence/v22.22.0/evidence.json",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/v22.22.0/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: staleEvidencePath,
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "libnode",
    allowRepository: "kungfu-systems/libnode",
    sha: SHA,
    targetRef: "release/v22/v22.22",
    cwd,
    publishTransaction: true,
    promoteOnlyReleaseCandidate: true,
    expectedPublicationVersion: packageVersion,
    releasePassport: true,
    releasePassportProductName: "Libnode",
    publishRequiredArtifactsJson: JSON.stringify([artifact]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, requestedTag);
  assert.equal(result.publishTransaction.publicReleaseTag, `v${packageVersion}`);
  assert.equal(refs.get(`tags/${staleTag}`), staleTagSha);
  assert.equal(refs.get(`tags/${requestedTag}`), SHA);
  assert.equal(refs.get(`tags/v${packageVersion}`), SHA);
  const recoveredImpact = JSON.parse(
    fs.readFileSync(path.join(cwd, ".buildchain/release-passport/impact.json"), "utf8"),
  );
  assert.equal(recoveredImpact.versionImpact.source, "release-candidate-tree-equivalence");
  assert.equal(
    recoveredImpact.surfaceImpacts[0].id,
    "release-candidate-stable-finalization",
  );

  const recovered = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "libnode",
    stateRef: "buildchain/release-state/22-22-3-kf-4",
    statePath: path.join(cwd, ".buildchain/release-state/recovered.json"),
    evidencePath: path.join(cwd, ".buildchain/release-evidence/recovered.json"),
  });
  assert.equal(recovered.exact_tag, requestedTag);
  assert.equal(recovered.state, "complete");
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

test("release recovery bootstrap scope stays exact outside the promotion action directory", () => {
  for (const file of [
    ".github/workflows/buildchain-ref-promotion.yml",
    "packages/core/self-dogfood-version.js",
    "scripts/check-inventory.mjs",
    "tests/build-surface.test.mjs",
  ]) {
    assert.equal(isAllowedReleaseLineRecoveryPath(file), true);
  }
  for (const file of [
    "packages/core/buildchain-contract.js",
    "scripts/generate-site-bundle.mjs",
    "tests/buildchain-contract.test.mjs",
  ]) {
    assert.equal(isAllowedReleaseLineRecoveryPath(file), false);
  }
  assert.equal(isAllowedReleaseLineRecoveryPath("package.json", ["package.json"]), true);
});

test("strict release promotion binds a generated version commit to the exact recovery RC parent", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: {
        channel: "release",
        ref: "release/v1/v1.0",
        version: "1.0.2",
      },
      source: {
        headSha: OTHER_SHA,
        mergeRefSha: SHA,
        treeHash: "recovery-tree",
      },
      platformMatrix: [
        { platformId: "linux-x64", artifactName: "buildchain-linux-x64" },
      ],
      diagnostics: {},
    },
  });
  const alphaSha = "c".repeat(40);
  const recoveryBaseSha = "b".repeat(40);
  const generatedReleaseSha = "e".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", recoveryBaseSha],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
  let createCommitCount = 0;
  let transientMissingRefAttempts = 0;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (
            ref === "tags/v1.1" &&
            transientMissingRefAttempts++ === 0
          ) {
            throw transientGitHubError();
          }
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
              sha:
                commit_sha === alphaSha
                  ? "alpha-tree"
                  : commit_sha === generatedReleaseSha
                    ? "generated-release-tree"
                    : "recovery-tree",
            },
            parents:
              commit_sha === generatedReleaseSha
                ? [{ sha: SHA }]
                : [],
          },
        }),
        getTree: async ({ tree_sha }) => ({
          data: {
            tree: [
              {
                path: "package.json",
                type: "blob",
                sha:
                  tree_sha === "generated-release-tree"
                    ? "stable-package-blob"
                    : "alpha-package-blob",
                mode: "100644",
              },
              {
                path: "actions/promote-buildchain-ref/lib.js",
                type: "blob",
                sha: "shared-lib-blob",
                mode: "100644",
              },
            ],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({
          data: {
            sha:
              createCommitCount++ === 0
                ? generatedReleaseSha
                : nextAlphaSha,
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
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        compareCommitsWithBasehead: async ({ basehead }) => {
          if (basehead === `${recoveryBaseSha}...${OTHER_SHA}`) {
            return {
              data: {
                files: [
                  { filename: "actions/promote-buildchain-ref/lib.js" },
                  { filename: "actions/promote-buildchain-ref/dist/index.js" },
                  { filename: "tests/promote-buildchain-ref.test.mjs" },
                ],
              },
            };
          }
          if (basehead === `${SHA}...${generatedReleaseSha}`) {
            return {
              data: {
                files: [{ filename: "package.json" }],
              },
            };
          }
          throw new Error(`unexpected comparison ${basehead}`);
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-07-24T00:00:00Z",
                    base: {
                      ref: "release/v1/v1.0",
                      sha: recoveryBaseSha,
                    },
                    head: {
                      ref: "fix/release-line-v1-v1.0-finalization-recovery",
                      sha: OTHER_SHA,
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      requireGovernance: true,
      requireVersionState: true,
      promoteOnlyReleaseCandidate: true,
      allowRepository: "kungfu-systems/buildchain",
    });

    assert.equal(result.sha, generatedReleaseSha);
    assert.equal(refs.get("tags/v1.0.2"), generatedReleaseSha);
    assert.equal(refs.get("tags/v1.0.3-alpha.0"), nextAlphaSha);
    assert.equal(transientMissingRefAttempts, 2);
    assert.equal(
      result.updates.some(
        (update) =>
          update.action === "accepted-exact-release-recovery-parent" &&
          update.sha === SHA &&
          update.recoveryBaseSha === recoveryBaseSha &&
          update.recoveryHeadSha === OTHER_SHA,
      ),
      true,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("strict release promotion accepts a generated version commit whose parent is the exact tree-equivalent RC", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: {
        channel: "release",
        ref: "release/v1/v1.0",
        version: "1.0.2",
      },
      source: {
        headSha: OTHER_SHA,
        mergeRefSha: SHA,
        treeHash: "candidate-tree",
      },
      platformMatrix: [
        { platformId: "linux-x64", artifactName: "buildchain-linux-x64" },
      ],
      diagnostics: {},
    },
  });
  const alphaSha = "c".repeat(40);
  const previousReleaseSha = "b".repeat(40);
  const generatedReleaseSha = "e".repeat(40);
  const nextAlphaSha = "d".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", previousReleaseSha],
    ["tags/v1.0.2-alpha.0", alphaSha],
  ]);
  let createCommitCount = 0;
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
              sha:
                commit_sha === alphaSha
                  ? "alpha-tree"
                  : commit_sha === generatedReleaseSha
                    ? "generated-release-tree"
                    : "candidate-tree",
            },
            parents:
              commit_sha === generatedReleaseSha
                ? [{ sha: SHA }]
                : [],
          },
        }),
        getTree: async ({ tree_sha }) => ({
          data: {
            tree: [
              {
                path: "package.json",
                type: "blob",
                sha:
                  tree_sha === "generated-release-tree"
                    ? "stable-package-blob"
                    : "candidate-package-blob",
                mode: "100644",
              },
              {
                path: "actions/promote-buildchain-ref/lib.js",
                type: "blob",
                sha: "shared-lib-blob",
                mode: "100644",
              },
            ],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({
          data: {
            sha:
              createCommitCount++ === 0
                ? generatedReleaseSha
                : nextAlphaSha,
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
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        compareCommitsWithBasehead: async ({ basehead }) => {
          assert.equal(basehead, `${SHA}...${generatedReleaseSha}`);
          return {
            data: {
              files: [{ filename: "package.json" }],
            },
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-07-24T00:00:00Z",
                    html_url:
                      "https://github.com/kungfu-systems/buildchain/pull/1693",
                    base: {
                      ref: "release/v1/v1.0",
                      sha: previousReleaseSha,
                    },
                    head: {
                      ref: "buildchain/version-state/release-v1-v1.0/example",
                      sha: OTHER_SHA,
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [],
        }),
      },
    },
  };

  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      requireGovernance: true,
      requireVersionState: true,
      promoteOnlyReleaseCandidate: true,
      allowRepository: "kungfu-systems/buildchain",
    });

    assert.equal(result.sha, generatedReleaseSha);
    assert.equal(refs.get("tags/v1.0.2"), generatedReleaseSha);
    assert.equal(refs.get("tags/v1.0.3-alpha.0"), nextAlphaSha);
    assert.equal(
      result.updates.some(
        (update) =>
          update.action === "accepted-exact-release-candidate-parent" &&
          update.sha === SHA &&
          update.treeSha === "candidate-tree",
      ),
      true,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("strict release promotion accepts recovery from floating alpha material after exact alpha", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const exactAlphaSha = "c".repeat(40);
  const floatingAlphaSha = "d".repeat(40);
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["tags/v1.0.1", OTHER_SHA],
    ["tags/v1.0.2-alpha.0", exactAlphaSha],
    ["tags/v1.0-alpha", floatingAlphaSha],
  ]);
  const { octokit, commits } = createGitMock({ refs });
  commits.set(exactAlphaSha, {
    sha: exactAlphaSha,
    tree: { sha: "exact-alpha-tree" },
    parents: [],
  });
  commits.set(floatingAlphaSha, {
    sha: floatingAlphaSha,
    tree: { sha: "floating-alpha-tree" },
    parents: [{ sha: exactAlphaSha }],
  });
  commits.set(SHA, {
    sha: SHA,
    tree: { sha: "release-recovery-tree" },
    parents: [{ sha: OTHER_SHA }, { sha: floatingAlphaSha }],
  });
  octokit.rest.repos = {
    getBranchProtection: async () => ({
      data: protectedChannel(),
    }),
    compareCommitsWithBasehead: async ({ basehead }) => {
      if (basehead === `${floatingAlphaSha}...${SHA}`) {
        return {
          data: {
            files: [
              { filename: "actions/promote-buildchain-ref/lib.js" },
              { filename: "actions/promote-buildchain-ref/dist/index.js" },
              { filename: "tests/promote-buildchain-ref.test.mjs" },
            ],
          },
        };
      }
      if (basehead.startsWith(`${SHA}...commit-`)) {
        return { data: { files: [{ filename: "package.json" }] } };
      }
      throw new Error(`unexpected comparison ${basehead}`);
    },
    listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
      data:
        commit_sha === SHA
          ? [
              {
                merged_at: "2026-07-01T00:00:00Z",
                base: { ref: "release/v1/v1.0" },
                head: {
                  ref: "fix/release-line-v1-v1.0-finalization-recovery",
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
    sha: SHA,
    targetRef: "release/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.match(result.sha, /^commit-/);
  assert.equal(refs.get("tags/v1.0.2"), result.sha);
  assert.match(refs.get("tags/v1.0.3-alpha.0"), /^commit-/);
});

// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("dry-run version planning records derived files without writing Git objects", async () => {
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
path = "dist/site/buildchain-contract.json"
key = "product.version"

[lifecycle.version-state]
command = "node scripts/generate-site-contract.mjs"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "dist/site/buildchain-contract.json": {
      product: { version: "1.0.0-alpha.0" },
      generated: false,
    },
    "scripts/generate-site-contract.mjs": `
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
fs.writeFileSync("dist/site/buildchain-contract.json", JSON.stringify({
  product: { version: pkg.version },
  generated: true
}, null, 2) + "\\n");
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

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
        createBlob: async () => assert.fail("dry-run must not create a blob"),
        createTree: async () => assert.fail("dry-run must not create a tree"),
        createCommit: async () => assert.fail("dry-run must not create a commit"),
        createRef: async () => assert.fail("dry-run must not create a ref"),
        updateRef: async () => assert.fail("dry-run must not update a ref"),
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
    dryRun: true,
    requireVersionState: true,
    publishTransaction: true,
    releasePassport: false,
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "dry-run-version-state").files,
    ["dist/site/buildchain-contract.json"],
  );
  assert.deepEqual(
    result.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version: "1.0.0-alpha.0",
      tag: "v1.0.0-alpha.0",
      publicTag: "v1.0.0-alpha.0",
      sha: SHA,
    },
  );
});

test("publication plan exposes an anchored package version as the exact public tag", () => {
  const plannedPublication = {
    action: "dry-run-publish-transaction",
    version: "22.22.3-kf.3-alpha.19",
    tag: "v22.22.1-alpha.12",
    publicTag: "v22.22.3-kf.3-alpha.19",
    sha: SHA,
  };

  assert.equal(plannedPublicationExactTag(plannedPublication), "v22.22.3-kf.3-alpha.19");
  assert.equal(plannedPublication.tag, "v22.22.1-alpha.12");
});

test("release promotion creates v-prefixed release tag and prepares next alpha tag", async () => {
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          if (ref === "heads/release/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return { data: [] };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          calls.push(["createRef", ref, sha]);
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
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.0", action: "created", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
    { tag: "v1-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/release/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
    ["listMatchingRefs", "heads/buildchain/release-state/1-0-"],
    ["getRef", "tags/v1.0.0"],
    ["createRef", "refs/tags/v1.0.0", SHA],
    ["getRef", "tags/v1.0"],
    ["updateRef", "tags/v1.0", SHA, true],
    ["getRef", "tags/v1.1"],
    ["getRef", "tags/v1"],
    ["updateRef", "tags/v1", SHA, true],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["getRef", "tags/v1.0-alpha"],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
    ["listMatchingRefs", "tags/v1."],
    ["getRef", "tags/v1-alpha"],
    ["updateRef", "tags/v1-alpha", SHA, true],
  ]);
});

test("release promotion does not move v1 when the next minor line exists", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/release/v1/v1.0" || ref === "tags/v1.1") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({ data: [] }),
        updateRef: async () => ({}),
        createRef: async () => ({}),
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
    { tag: "v1.0.0", action: "created", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "skipped-next-minor-exists", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
    { tag: "v1-alpha", action: "updated", sha: SHA },
  ]);
});

test("alpha promotion creates exact prerelease tag and moves minor and major alpha tags", async () => {
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
        listMatchingRefs: async ({ ref }) => {
          calls.push(["listMatchingRefs", ref]);
          return {
            data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
          };
        },
        updateRef: async ({ ref, sha, force }) => {
          calls.push(["updateRef", ref, sha, force]);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          calls.push(["createRef", ref, sha]);
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
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
  });

  assert.deepEqual(result.updates, [
    { tag: "v1.0.1-alpha.0", action: "created", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
    { tag: "v1-alpha", action: "updated", sha: SHA },
  ]);
  assert.deepEqual(calls, [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["listMatchingRefs", "tags/v1.0."],
    ["listMatchingRefs", "heads/buildchain/release-state/1-0-"],
    ["listMatchingRefs", "tags/v1."],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["getRef", "tags/v1.0-alpha"],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
    ["getRef", "tags/v1-alpha"],
    ["updateRef", "tags/v1-alpha", SHA, true],
  ]);
});

test("older minor alpha promotion cannot move the major alpha channel backwards", async () => {
  const writes = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data:
            ref === "tags/v1.0."
              ? [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }]
              : ref === "tags/v1."
                ? [
                    {
                      ref: "refs/tags/v1.1-alpha",
                      object: { sha: "c".repeat(40) },
                    },
                  ]
                : [],
        }),
        updateRef: async ({ ref, sha, force }) => {
          writes.push(["updateRef", ref, sha, force]);
        },
        createRef: async ({ ref, sha }) => {
          writes.push(["createRef", ref, sha]);
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
  });

  assert.equal(writes.some((write) => write[1] === "tags/v1-alpha"), false);
  assert.deepEqual(result.updates.at(-1), {
    tag: "v1-alpha",
    action: "skipped-newer-minor-alpha-exists",
    sha: SHA,
  });
});

test("major alpha ownership scans the full matching-ref response beyond 100 tags", async () => {
  const writes = [];
  let majorScans = 0;
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => {
          if (ref === "tags/v1.0.") {
            return {
              data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
            };
          }
          if (ref === "tags/v1.") {
            majorScans += 1;
            return {
              data: [
                ...Array.from({ length: 100 }, (_, index) => ({
                  ref: `refs/tags/v1.0.${index}`,
                  object: { sha: OTHER_SHA },
                })),
                {
                  ref: "refs/tags/v1.1-alpha",
                  object: { sha: "c".repeat(40) },
                },
              ],
            };
          }
          return { data: [] };
        },
        updateRef: async ({ ref, sha, force }) => {
          writes.push(["updateRef", ref, sha, force]);
        },
        createRef: async ({ ref, sha }) => {
          writes.push(["createRef", ref, sha]);
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
  });

  assert.equal(writes.some((write) => write[1] === "tags/v1-alpha"), false);
  assert.equal(majorScans, 1);
  assert.deepEqual(result.updates.at(-1), {
    tag: "v1-alpha",
    action: "skipped-newer-minor-alpha-exists",
    sha: SHA,
  });
});

test("paper alpha promotion does not create a formatter-only version-state commit", async () => {
  const cwd = makeTempWorkspace({
    ".buildchain/buildchain.toml": `schema = 1

[project]
type = "publication-artifact"
name = "paper-fixture"

[publication]
kind = "paper"
title = "Paper fixture"
version = "1.0.1-alpha.0"
authors = ["Keren Dong"]
primary_artifact = "_build/main.pdf"
artifact_paths = ["_build/main.pdf"]
metadata_paths = ["README.md"]
source_paths = ["paper"]

[version]
required = true

[[version.files]]
type = "toml"
path = ".buildchain/buildchain.toml"
key = "publication.version"
`,
  });
  const writes = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0" || ref === "heads/dev/v1/v1.0") {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async ({ ref }) => ({
          data: ref === "tags/v1.0."
            ? [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }]
            : [],
        }),
        createBlob: async () => assert.fail("semantic version no-op must not create a blob"),
        createTree: async () => assert.fail("semantic version no-op must not create a tree"),
        createCommit: async () => assert.fail("semantic version no-op must not create a commit"),
        createRef: async ({ ref, sha }) => {
          writes.push(["createRef", ref, sha]);
          return {};
        },
        updateRef: async ({ ref, sha, force }) => {
          writes.push(["updateRef", ref, sha, force]);
          return {};
        },
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "paper-fixture",
    allowRepository: "kungfu-systems/paper-fixture",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
  });

  assert.deepEqual(
    result.updates
      .filter((update) => update.version)
      .map((update) => [update.version, update.action, update.sha]),
    [["1.0.1-alpha.0", "existing-version-state", SHA]],
  );
  assert.deepEqual(writes, [
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
    ["updateRef", "tags/v1-alpha", SHA, true],
  ]);
});

test("no-op dry-run version planning does not require product build artifacts", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.verify]
command = "node scripts/verify-built-product.mjs"
`,
    "package.json": {
      name: "@kungfu-systems/artifactless-planning-fixture",
      version: "1.0.1-alpha.0",
    },
    "scripts/verify-built-product.mjs": `
import fs from "node:fs";
if (!fs.existsSync("dist/product")) {
  throw new Error("product build artifacts are unavailable");
}
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run([
    "git",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ], cwd);

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
        createRef: async () => assert.fail("dry-run must not create a ref"),
        updateRef: async () => assert.fail("dry-run must not update a ref"),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "artifactless-planning-fixture",
    allowRepository: "kungfu-systems/artifactless-planning-fixture",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    tags: ["v1.0.1-alpha.0"],
    cwd,
    dryRun: true,
    requireVersionState: true,
  });

  assert.deepEqual(
    result.updates
      .filter((update) => update.version)
      .map((update) => [update.version, update.action, update.sha]),
    [["1.0.1-alpha.0", "existing-version-state", SHA]],
  );
});

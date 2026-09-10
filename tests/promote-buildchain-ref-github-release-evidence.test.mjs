import { fakeGitHub } from "./helpers/github-publication-provider.mjs";
// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("promote action collects GitHub Release evidence assets fail-closed", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.0/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": {
      release: { tag: "v1.0.0" },
    },
    ".buildchain/release-passport/evidence.json": { ok: true },
    "dist/paper.pdf": "paper bytes",
  });

  assert.deepEqual(
    collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
      additionalAssetPaths: [path.join(cwd, "dist/paper.pdf")],
    }).map((entry) => path.relative(cwd, entry).split(path.sep).join("/")),
    [
      ".buildchain/release-evidence/v1.0.0/evidence.json",
      ".buildchain/release-passport/buildchain.release.json",
      "dist/paper.pdf",
    ],
  );

  assert.throws(
    () => collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/missing.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    }),
    /requires a publish evidence file/,
  );

  assert.throws(
    () => collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
      additionalAssetPaths: [path.join(cwd, "dist/missing.pdf")],
    }),
    /requires a declared GitHub Release artifact/,
  );

  assert.throws(
    () => collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
      additionalAssetPaths: [path.join(cwd, ".buildchain/release-passport/buildchain.release.json")],
    }),
    /duplicate asset basename 'buildchain\.release\.json'/,
  );

  fs.writeFileSync(path.join(cwd, ".buildchain/release-passport/evidence.json"), '{"passport":true}\n');
  assert.throws(
    () => collectGitHubReleaseEvidenceAssets({
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.0/evidence.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    }),
    /conflicting duplicate evidence asset basename 'evidence\.json'/,
  );
});

test("promote action publishes semver GitHub Release evidence assets", async () => {
  const { github, options } = publicationFixture();
  const result = await publishGitHubReleaseEvidence(options);
  assert.equal(result.transaction.state, "complete");
  assert.equal(result.assetCount, 4);
  assert.equal(github.state.releaseRequests.length, 1);
  assert.equal(github.state.releaseRequests[0].prerelease, true);
  assert.equal(github.state.releaseRequests[0].make_latest, "false");
  assert.deepEqual(github.state.uploads.sort(), ["buildchain.release.json", "evidence.json", "kfd-2.json", "paper.pdf"]);
});

test("promote action publishes anchored stable tags from release intent", async () => {
  const { github, options } = publicationFixture({ tag: "v22.22.3-kf.4", channel: "release" });
  const result = await publishGitHubReleaseEvidence(options);
  assert.equal(result.transaction.state, "complete");
  assert.equal(github.state.releaseRequests[0].prerelease, false);
  assert.equal(github.state.releaseRequests[0].make_latest, "true");
});

test("promote action preserves byte-identical GitHub Release assets on duplicate delivery", async () => {
  const { github, options } = publicationFixture({ existing: true });
  const original = structuredClone(github.state.assets);
  const first = await publishGitHubReleaseEvidence(options);
  const writes = github.state.mutations;
  const second = await publishGitHubReleaseEvidence(options);
  assert.equal(first.transaction.state, "complete");
  assert.equal(second.transaction.state, "complete");
  assert.deepEqual(github.state.assets, original);
  assert.deepEqual(github.state.uploads, []);
  assert.equal(github.state.mutations, writes);
});

test("complete candidate recovery reuses verified public evidence and preserves product payload bytes", async () => {
  const cwd = makeTempWorkspace({
    "dist/package.tgz": "sealed product bytes",
  });
  const passport = {
    release: {
      tag: "v1.0.1-alpha.0",
      publicTag: "v1.0.1-alpha.0",
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
      releaseSha: SHA,
    },
    product: { repository: "kungfu-systems/buildchain" },
  };
  const payloadPath = path.join(cwd, "dist/package.tgz");
  const payload = fs.readFileSync(payloadPath);
  const assets = [
    {
      id: 1,
      name: "buildchain.release.json",
      digest: `sha256:${crypto.createHash("sha256").update(JSON.stringify(passport)).digest("hex")}`,
    },
    {
      id: 2,
      name: "artifact-evidence.json",
      digest: `sha256:${"a".repeat(64)}`,
    },
    {
      id: 3,
      name: "package.tgz",
      digest: `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`,
    },
  ];
  const downloaded = new Map([
    [1, Buffer.from(JSON.stringify(passport))],
    [2, Buffer.from("{}")],
  ]);
  const uploaded = [];
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: assets }),
        getReleaseAsset: async ({ asset_id }) => ({ data: downloaded.get(asset_id) }),
        uploadReleaseAsset: async ({ name }) => uploaded.push(name),
      },
    },
  };

  const result = await reuseCompleteGitHubReleaseEvidence({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    release: { id: 123, html_url: "https://github.test/release" },
    tag: "v1.0.1-alpha.0",
    target: SHA,
    channel: "alpha",
    targetRef: "alpha/v1/v1.0",
    additionalAssetPaths: [payloadPath],
    verifyPassport: async () => ({ ok: true, issues: [] }),
  });

  assert.equal(result.action, "reused");
  assert.equal(result.passportVerified, true);
  assert.equal(result.uploadedAssetCount, 0);
  assert.deepEqual(uploaded, []);
});

test("explicit complete recovery repairs a missing public Passport from the verified local evidence closure", async () => {
  const cwd = makeTempWorkspace({
    "publish/evidence.json": "published evidence",
    "release/buildchain.release.json": JSON.stringify({
      release: {
        tag: "v1.0.1-alpha.0",
        publicTag: "v1.0.1-alpha.0",
        channel: "alpha",
        targetRef: "alpha/v1/v1.0",
        releaseSha: SHA,
      },
      product: { repository: "kungfu-systems/buildchain" },
    }),
    "release/evidence.json": "published evidence",
  });
  const repairAssetPaths = [
    path.join(cwd, "publish/evidence.json"),
    path.join(cwd, "release/buildchain.release.json"),
    path.join(cwd, "release/evidence.json"),
  ];
  const uploaded = [];
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: [] }),
        uploadReleaseAsset: async ({ name, data }) =>
          uploaded.push({ name, data: Buffer.from(data) }),
      },
    },
  };

  const request = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    release: { id: 123, html_url: "https://github.test/release" },
    tag: "v1.0.1-alpha.0",
    target: SHA,
    channel: "alpha",
    targetRef: "alpha/v1/v1.0",
    repairAssetPaths,
    verifyPassport: async () => ({ ok: true, issues: [] }),
  };
  const result = await reuseCompleteGitHubReleaseEvidence(request);

  assert.equal(result.action, "repaired");
  assert.equal(result.passportVerified, true);
  assert.equal(result.uploadedAssetCount, 2);
  assert.deepEqual(
    uploaded.map(({ name }) => name),
    ["evidence.json", "buildchain.release.json"],
  );
  fs.writeFileSync(repairAssetPaths[0], "conflicting evidence");
  await assert.rejects(() => reuseCompleteGitHubReleaseEvidence(request), /conflicting asset basename 'evidence\.json'/);
  assert.equal(uploaded.length, 2);
});

test("complete recovery repair preflights every remote digest before uploading missing evidence", async () => {
  const cwd = makeTempWorkspace({
    "release/buildchain.release.json": JSON.stringify({
      release: {
        tag: "v1.0.1-alpha.0",
        channel: "alpha",
        targetRef: "alpha/v1/v1.0",
        releaseSha: SHA,
      },
      product: { repository: "kungfu-systems/buildchain" },
    }),
    "release/evidence.json": "expected evidence",
  });
  const uploaded = [];
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({
          data: [
            {
              id: 9,
              name: "evidence.json",
              digest: `sha256:${"0".repeat(64)}`,
            },
          ],
        }),
        uploadReleaseAsset: async ({ name }) => uploaded.push(name),
      },
    },
  };

  await assert.rejects(
    () =>
      reuseCompleteGitHubReleaseEvidence({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        release: { id: 123 },
        tag: "v1.0.1-alpha.0",
        target: SHA,
        channel: "alpha",
        targetRef: "alpha/v1/v1.0",
        repairAssetPaths: [
          path.join(cwd, "release/buildchain.release.json"),
          path.join(cwd, "release/evidence.json"),
        ],
        verifyPassport: async () => ({ ok: true, issues: [] }),
      }),
    /immutable GitHub Release evidence collision/,
  );
  assert.deepEqual(uploaded, []);
});

test("complete candidate recovery rejects a conflicting public product payload", async () => {
  const cwd = makeTempWorkspace({
    "dist/package.tgz": "sealed product bytes",
  });
  const passport = {
    release: {
      tag: "v1.0.1-alpha.0",
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
      releaseSha: SHA,
    },
    product: { repository: "kungfu-systems/buildchain" },
  };
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: [
          { id: 1, name: "buildchain.release.json", digest: `sha256:${"a".repeat(64)}` },
          { id: 2, name: "package.tgz", digest: `sha256:${"0".repeat(64)}` },
        ] }),
        getReleaseAsset: async () => ({ data: Buffer.from(JSON.stringify(passport)) }),
        uploadReleaseAsset: async () => {
          throw new Error("must not replace an immutable product payload");
        },
      },
    },
  };

  await assert.rejects(
    () => reuseCompleteGitHubReleaseEvidence({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      release: { id: 123 },
      tag: "v1.0.1-alpha.0",
      target: SHA,
      channel: "alpha",
      targetRef: "alpha/v1/v1.0",
      additionalAssetPaths: [path.join(cwd, "dist/package.tgz")],
      verifyPassport: async () => ({ ok: true, issues: [] }),
    }),
    /immutable GitHub Release product payload collision/,
  );
});

test("promote action rejects immutable GitHub Release collisions before writing assets", async () => {
  const { github, options } = publicationFixture({ existing: true });
  github.state.assets.find(asset => asset.name === "evidence.json").digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(() => publishGitHubReleaseEvidence(options), /GitHub Release stopped in|collision|mismatch/);
  assert.deepEqual(github.state.uploads, []);
});

test("partial GitHub Release with a later collision uploads no missing assets", async () => {
  const { github, options } = publicationFixture({ existing: true });
  github.state.assets = github.state.assets.filter(asset => asset.name === "paper.pdf");
  github.state.assets[0].digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(() => publishGitHubReleaseEvidence(options), /GitHub Release stopped in|collision|mismatch/);
  assert.deepEqual(github.state.uploads, []);
});

function publicationFixture({ tag = "v1.0.1-alpha.0", channel = "alpha", existing = false } = {}) {
  const cwd = makeTempWorkspace({
    "evidence.json": { ok: true },
    "passport/buildchain.release.json": { release: { tag } },
    "passport/kfd-2.json": { ok: true },
    "paper.pdf": "paper bytes",
  });
  const github = fakeGitHub();
  const files = ["evidence.json", "passport/buildchain.release.json", "passport/kfd-2.json", "paper.pdf"].map(file => path.join(cwd, file));
  if (existing) {
    github.state.release = { id: 123, html_url: "https://github.test/release", tag_name: tag };
    github.state.assets = files.map((file, index) => ({ id: index + 1, name: path.basename(file), digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}` }));
  }
  return { github, options: {
    octokit: github.octokit, repository: "kungfu-systems/buildchain", sourceSha: SHA,
    version: tag.slice(1), tag, channel,
    publishEvidencePath: files[0], releasePassportPath: files[1],
    releasePassportOutputDir: path.dirname(files[1]), additionalAssetPaths: [files[3]],
    statePath: path.join(cwd, "release-tail-state.json"),
  } };
}

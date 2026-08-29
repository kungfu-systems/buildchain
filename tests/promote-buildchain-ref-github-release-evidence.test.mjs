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

test("promote action publishes semver GitHub Release evidence assets", async (t) => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": {
      release: { tag: "v1.0.1-alpha.0" },
    },
    ".buildchain/release-passport/kfd-2.json": { ok: true },
    "dist/paper.pdf": "paper bytes",
  });
  const uploaded = [];
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/releases/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
      });
    }
    if (String(url).endsWith("/git/ref/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({ object: { sha: SHA } }), {
        status: 200,
      });
    }
    if (String(url).endsWith("/releases") && options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.prerelease, true);
      assert.equal(body.make_latest, "false");
      assert.equal("target_commitish" in body, false);
      return new Response(JSON.stringify({ id: 123, html_url: "https://github.test/release" }), { status: 201 });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: [] }),
        uploadReleaseAsset: async ({ name, data }) => {
          uploaded.push({ name, size: data.length });
          return {};
        },
      },
    },
  };

  const result = await publishGitHubReleaseEvidence({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    token: "token",
    apiUrl: "https://api.github.test",
    tag: "v1.0.1-alpha.0",
    target: SHA,
    publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json"),
    releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    additionalAssetPaths: [path.join(cwd, "dist/paper.pdf")],
  });

  assert.equal(result.action, "created");
  assert.equal(result.assetCount, 4);
  assert.equal(result.uploadedAssetCount, 4);
  assert.equal(result.preservedAssetCount, 0);
  assert.deepEqual(uploaded.map((asset) => asset.name), [
    "evidence.json",
    "buildchain.release.json",
    "kfd-2.json",
    "paper.pdf",
  ]);
});

test("promote action publishes anchored stable tags from release intent", async (t) => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v22.22.3-kf.4/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": { release: { tag: "v22.22.3-kf.4" } },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/releases/tags/v22.22.3-kf.4")) {
      return new Response(JSON.stringify({ id: 456, name: "v22.22.3-kf.4" }), { status: 200 });
    }
    if (String(url).endsWith("/releases/456") && options.method === "PATCH") {
      const body = JSON.parse(options.body);
      assert.equal(body.prerelease, false);
      assert.equal(body.make_latest, "true");
      return new Response(JSON.stringify({ id: 456, html_url: "https://github.test/stable" }), { status: 200 });
    }
    throw new Error(`unexpected request: ${options.method || "GET"} ${url}`);
  };
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: [] }),
        uploadReleaseAsset: async () => ({}),
      },
    },
  };

  const result = await publishGitHubReleaseEvidence({
    octokit,
    owner: "kungfu-systems",
    repo: "libnode",
    token: "token",
    apiUrl: "https://api.github.test",
    tag: "v22.22.3-kf.4",
    target: SHA,
    channel: "release",
    publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v22.22.3-kf.4/evidence.json"),
    releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
  });

  assert.equal(result.action, "updated");
  assert.equal(result.assetCount, 2);
});

test("promote action preserves byte-identical GitHub Release assets on duplicate delivery", async (t) => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": { release: { tag: "v1.0.1-alpha.0" } },
    ".buildchain/release-passport/kfd-2.json": { ok: true },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/releases/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({
        id: 123,
        tag_name: "v1.0.1-alpha.0",
        html_url: "https://github.test/release",
        name: "v1.0.1-alpha.0",
        body: "Buildchain release passport assets for v1.0.1-alpha.0.",
        prerelease: true,
        make_latest: "false",
        target_commitish: SHA,
      }), { status: 200 });
    }
    if (String(url).endsWith("/git/ref/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({ object: { sha: SHA } }), { status: 200 });
    }
    if (String(url).endsWith("/releases/123") && options.method === "PATCH") {
      return new Response(JSON.stringify({ id: 123, html_url: "https://github.test/release" }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const files = [
    path.join(cwd, ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json"),
    path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    path.join(cwd, ".buildchain/release-passport/kfd-2.json"),
  ];
  const assets = files.map((filePath, index) => ({
    id: index + 1,
    name: path.basename(filePath),
    digest: `sha256:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`,
  }));
  const uploaded = [];
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: assets }),
        uploadReleaseAsset: async ({ name }) => uploaded.push(name),
      },
    },
  };

  const result = await publishGitHubReleaseEvidence({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    token: "token",
    apiUrl: "https://api.github.test",
    tag: "v1.0.1-alpha.0",
    target: SHA,
    publishEvidencePath: files[0],
    releasePassportPath: files[1],
    releasePassportOutputDir: path.dirname(files[1]),
  });

  assert.equal(result.action, "existing");
  assert.equal(result.assetCount, 3);
  assert.equal(result.uploadedAssetCount, 0);
  assert.equal(result.preservedAssetCount, 3);
  assert.deepEqual(uploaded, []);
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

test("promote action rejects time-drifted evidence on duplicate delivery", async (t) => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json": { generatedAt: "2026-07-16T09:00:57Z" },
    ".buildchain/release-passport/buildchain.release.json": { release: { tag: "v1.0.1-alpha.0" } },
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/releases/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({
        id: 123,
        html_url: "https://github.test/release",
        name: "v1.0.1-alpha.0",
        body: "Buildchain release passport assets for v1.0.1-alpha.0.",
        prerelease: true,
        make_latest: "false",
        target_commitish: SHA,
      }), { status: 200 });
    }
    if (String(url).endsWith("/git/ref/tags/v1.0.1-alpha.0")) {
      return new Response(JSON.stringify({ object: { sha: SHA } }), { status: 200 });
    }
    if (String(url).endsWith("/releases/123") && options.method === "PATCH") {
      return new Response(JSON.stringify({ id: 123, html_url: "https://github.test/release" }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({
          data: [{ id: 7, name: "evidence.json", digest: `sha256:${"0".repeat(64)}` }],
        }),
        uploadReleaseAsset: async () => {
          throw new Error("must not upload over an immutable asset");
        },
      },
    },
  };

  await assert.rejects(
    () => publishGitHubReleaseEvidence({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      token: "token",
      apiUrl: "https://api.github.test",
      tag: "v1.0.1-alpha.0",
      target: SHA,
      publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json"),
      releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
      releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    }),
    /immutable GitHub Release asset collision: 'evidence\.json'/,
  );
});

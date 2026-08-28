// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("promoteBuildchainRefs rejects stale target SHA", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: OTHER_SHA } } }),
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
    }),
    /not requested SHA/,
  );
});

test("every direct provider path fails before mutation when opted-in qualification is omitted", async () => {
  const providerCalls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async (request) => {
          providerCalls.push(["getRef", request]);
          return { data: { object: { sha: SHA } } };
        },
        createRef: async (request) => providerCalls.push(["createRef", request]),
        updateRef: async (request) => providerCalls.push(["updateRef", request]),
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
      requirePublicationQualification: true,
    }),
    /publication-qualification-receipt-json is required before provider mutation/,
  );
  assert.deepEqual(providerCalls, []);
});

test("governed promotion treats a superseded target as an auditable no-op", async () => {
  const mutationCalls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: OTHER_SHA } } }),
        createRef: async (request) => mutationCalls.push(["createRef", request]),
        updateRef: async (request) => mutationCalls.push(["updateRef", request]),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
        update: async (request) => mutationCalls.push(["repos.update", request]),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.superseded, true);
  assert.equal(result.sourceSha, SHA);
  assert.equal(result.sha, OTHER_SHA);
  assert.deepEqual(result.updates, [
    {
      action: "superseded-promotion",
      ref: "alpha/v1/v1.0",
      requestedSha: SHA,
      currentSha: OTHER_SHA,
      comparisonStatus: "ahead",
      reason: "target-ref-advanced",
      sha: OTHER_SHA,
    },
  ]);
  assert.deepEqual(mutationCalls, []);
});

test("governed promotion resumes its exact durable transaction after the target ref advanced", async () => {
  const releaseSha = "c".repeat(40); const advancedSha = "d".repeat(40); const staleFloatingSha = "e".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "alpha", ref: "alpha/v1/v1.0", version: "1.0.0-alpha.0" },
      source: { headSha: OTHER_SHA, mergeRefSha: OTHER_SHA, treeHash: `tree-${SHA}` },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", advancedSha],
      ["heads/dev/v1/v1.0", advancedSha],
      ["tags/v1.0-alpha", staleFloatingSha],
      ["tags/v1-alpha", staleFloatingSha],
    ]),
  });
  commits.set(releaseSha, {
    sha: releaseSha,
    tree: { sha: `tree-${releaseSha}` },
    parents: [{ sha: SHA }],
  });
  commits.set(advancedSha, { sha: advancedSha, tree: { sha: `tree-${advancedSha}` }, parents: [{ sha: releaseSha }] });
  octokit.rest.repos = {
    compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
    getBranchProtection: async () => ({ data: protectedChannel() }),
    listPullRequestsAssociatedWithCommit: async () => ({
      data: [{
        merged_at: "2026-07-17T00:00:00Z",
        base: { ref: "alpha/v1/v1.0" },
        head: {
          ref: "dev/v1/v1.0",
          repo: { full_name: "kungfu-systems/buildchain" },
        },
      }],
    }),
  };
  const evidencePath = path.join(cwd, "durable-evidence.json");
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version: "1.0.0-alpha.0",
    channel: "alpha",
    source_sha: SHA,
    release_sha: releaseSha,
    target_ref: "alpha/v1/v1.0",
    release_material_sha: releaseSha,
    publish_tooling_sha: releaseSha,
    artifacts: [],
  }, null, 2) + "\n");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "tx-advanced-alpha",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: releaseSha,
      release_material_sha: releaseSha,
      publish_tooling_sha: releaseSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: ["durable-evidence.json"],
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:00:00.000Z",
    },
    evidencePath,
  });
  fs.unlinkSync(evidencePath);

  const plan = await promoteBuildchainRefs({ octokit, owner: "kungfu-systems", repo: "buildchain", sha: SHA, targetRef: "alpha/v1/v1.0", cwd, dryRun: true, publishTransaction: true, publishTransactionOverride: true, requireVersionState: false, releasePassport: false }); assert.equal(plan.updates.find((update) => update.action === "dry-run-publish-transaction")?.version, "1.0.0-alpha.0"); assert.equal(plan.updates[0].action, "resumed-advanced-publication");
  const recovery = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    versionState: true,
    requireGovernance: true,
    publishTransaction: true,
    publishTransactionOverride: true,
    expectedPublicationVersion: "1.0.0-alpha.0",
    releasePassport: false,
    promoteOnlyReleaseCandidate: true,
    releaseCandidateVersion: "1.0.0-alpha.0",
  };
  const result = await promoteBuildchainRefs(recovery);

  assert.equal(result.superseded, undefined);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(result.sha, advancedSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), advancedSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), advancedSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), advancedSha);
  assert.equal(refs.get("tags/v1-alpha"), advancedSha);
  assert.equal(fs.existsSync(path.join(cwd, result.publishTransaction.evidencePath)), true);
  assert.equal(result.updates[0].action, "resumed-advanced-publication");
  assert.equal(
    result.updates.some(
      (update) =>
        update.action === "verified-release-candidate" &&
        update.sha === SHA,
    ),
    true,
  );
  assert.equal(result.updates.at(-1).action, "finalized-advanced-publication");

  const repeated = await promoteBuildchainRefs(recovery);
  assert.equal(repeated.publishTransaction.state, "complete");
  assert.equal(repeated.publishTransaction.id, "tx-advanced-alpha");
  assert.equal(repeated.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(repeated.sha, advancedSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), advancedSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(repeated.updates[0].action, "resumed-advanced-publication");
});

test("a queued duplicate promotion adds no mutation after the protected target advances", async () => {
  const refs = new Map([["heads/alpha/v1/v1.0", SHA]]);
  const mutationCalls = [];
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
          data: ref === "tags/v1.0."
            ? [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }]
            : [],
        }),
        createRef: async ({ ref, sha }) => {
          mutationCalls.push(["createRef", ref, sha]);
          refs.set(ref.replace(/^refs\//, ""), sha);
        },
        updateRef: async ({ ref, sha, force }) => {
          mutationCalls.push(["updateRef", ref, sha, force]);
          refs.set(ref, sha);
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-07-10T00:00:00Z",
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

  const first = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });
  assert.equal(first.superseded, undefined);
  assert.equal(mutationCalls.length, 3);

  refs.set("heads/alpha/v1/v1.0", OTHER_SHA);
  const mutationsAfterFirstIntent = mutationCalls.length;
  const duplicate = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(duplicate.superseded, true);
  assert.equal(duplicate.updates[0].reason, "target-ref-advanced");
  assert.equal(mutationCalls.length, mutationsAfterFirstIntent);
});

test("governed promotion fails closed when a mismatched target is not ahead", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async () => ({ data: { object: { sha: OTHER_SHA } } }),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({
          data: { status: "diverged" },
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
    /moved incompatibly.*diverged/,
  );
});

test("promoteBuildchainRefs fails fast when promote-only RC passport source is stale", async () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: {
        channel: "alpha",
        ref: "alpha/v1/v1.0",
        version: "1.0.0-alpha.0",
      },
      source: { headSha: OTHER_SHA, mergeRefSha: OTHER_SHA },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  const calls = [];
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          calls.push(["getRef", ref]);
          return { data: { object: { sha: SHA } } };
        },
        getCommit: async ({ commit_sha }) => {
          calls.push(["getCommit", commit_sha]);
          return { data: { tree: { sha: `tree-${commit_sha}` }, parents: [] } };
        },
        listMatchingRefs: async () => {
          calls.push(["listMatchingRefs"]);
          return { data: [] };
        },
      },
    },
  };

  try {
    await assert.rejects(
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        versionState: false,
        promoteOnlyReleaseCandidate: true,
      }),
      /release candidate passport validation failed: source identity mismatch/,
    );
    assert.deepEqual(calls, [["getRef", "heads/alpha/v1/v1.0"], ["getCommit", SHA]]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("promote-only RC passport accepts channel merge commit with matching source tree", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: {
        channel: "alpha",
        ref: "alpha/v1/v1.0",
        version: "1.0.0-alpha.0",
      },
      source: {
        headSha: OTHER_SHA,
        mergeRefSha: OTHER_SHA,
        treeHash: `tree-${SHA}`,
      },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      gateProfileEvidence: {
        contract: "buildchain.shifu-gate-aggregate/v1",
        digest: `sha256:${"a".repeat(64)}`,
        profile: "alpha-pr",
        sourceSha: OTHER_SHA,
        registry: { projectId: "fixture", digest: `sha256:${"b".repeat(64)}` },
        matrixDigest: `sha256:${"c".repeat(64)}`,
        status: "pass",
        qualifying: true,
        receiptCount: 1,
        gateResultCount: 2,
      },
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
    assert.equal(result.gateProfileEvidence.profile, "alpha-pr");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("promote-only recovery binds publication version through the immutable recovery receipt", () => {
  const candidateHash = "a".repeat(64);
  const passportPath = ".buildchain/artifacts/release-candidate-passport.json";
  const receiptPath = ".buildchain/artifacts/recovery-receipt.json";
  const passport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-passport",
    repository: "kungfu-systems/buildchain",
    target: { channel: "alpha", ref: "alpha/v1/v1.0", version: "22.22.3-kf.0" },
    source: { headSha: OTHER_SHA, mergeRefSha: OTHER_SHA, treeHash: `tree-${SHA}` },
    platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
    diagnostics: {},
    candidateHash,
  };
  const receipt = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-recovery/v1",
    action: "reused",
    repository: "kungfu-systems/buildchain",
    originalCandidate: { sourceSha: OTHER_SHA, tree: `tree-${SHA}` },
    target: { channel: "alpha", ref: "alpha/v1/v1.0", sha: SHA, tree: `tree-${SHA}`, version: "3.0.6-alpha.4" },
    recovered: { candidateRoot: `sha256:${candidateHash}` },
    skippedBuildStages: ["install", "build", "verify", "platform-matrix"],
    payloadBytes: "unchanged",
  };
  receipt.root = `sha256:${sha256Json(receipt)}`;
  const cwd = makeTempWorkspace({ [passportPath]: passport, [receiptPath]: receipt });
  try {
    const result = validatePromotionReleaseCandidate({
      cwd,
      passportPath,
      recoveryReceiptPath: receiptPath,
      repository: "kungfu-systems/buildchain",
      targetChannel: "alpha",
      targetRef: "alpha/v1/v1.0",
      version: "3.0.6-alpha.4",
      sourceHeadSha: SHA,
      sourceTreeSha: `tree-${SHA}`,
    });
    assert.equal(result.publicationVersionBinding, "recovery-receipt");
    assert.equal(result.recoveredCandidate, true);
    assert.throws(
      () => validatePromotionReleaseCandidate({
        cwd,
        passportPath,
        repository: "kungfu-systems/buildchain",
        targetChannel: "alpha",
        targetRef: "alpha/v1/v1.0",
        version: "3.0.6-alpha.4",
        sourceHeadSha: SHA,
        sourceTreeSha: `tree-${SHA}`,
      }),
      /version mismatch: expected 3\.0\.6-alpha\.4, got 22\.22\.3-kf\.0/,
    );
    const drifted = { ...receipt, recovered: { candidateRoot: `sha256:${"b".repeat(64)}` } };
    delete drifted.root;
    drifted.root = `sha256:${sha256Json(drifted)}`;
    fs.writeFileSync(path.join(cwd, receiptPath), `${JSON.stringify(drifted)}\n`);
    assert.throws(
      () => validatePromotionReleaseCandidate({
        cwd,
        passportPath,
        recoveryReceiptPath: receiptPath,
        repository: "kungfu-systems/buildchain",
        targetChannel: "alpha",
        targetRef: "alpha/v1/v1.0",
        version: "3.0.6-alpha.4",
        sourceHeadSha: SHA,
        sourceTreeSha: `tree-${SHA}`,
      }),
      /recovery receipt: candidate root mismatch/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});


test("recovered no-op version state skips lifecycle verification", async () => {
  const updates = [];
  const result = await resolveExistingVersionState({
    changedFiles: [],
    recoveredCandidate: true,
    version: "3.0.6-alpha.5",
    dryRun: false,
    workspaceCwd: "/unused",
    verificationCommand: "",
    discovered: { config: {}, packageManager: { name: "pnpm" } },
    discoveredPaths: ["package.json"],
    versionStateAllowedPaths: ["package.json"],
    strategyEnv: {},
    baseSha: SHA,
    publishVersion: "3.0.6-alpha.5",
    hasVersionVerification: true,
    versionStrategy: { strategy: "semver", next: "auto" },
    anchorManifest: undefined,
    updates,
    runVersionVerification: () =>
      assert.fail("recovery must not execute lifecycle verification"),
    createVerifiedVersionStateCommit: () =>
      assert.fail("recovery must not rematerialize version state"),
  });
  assert.equal(result.action, "existing");
  assert.equal(updates[0].action, "existing-recovered-version-state");
});

test("major promotion requires a release passport with the matching source tree", () => {
  const passportPath = ".buildchain/artifacts/release-candidate-passport.json";
  const cwd = makeTempWorkspace({
    [passportPath]: {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "release", ref: "release/v2/v2.14", version: "22.22.3-kf.0" },
      source: { headSha: OTHER_SHA, mergeRefSha: OTHER_SHA, treeHash: `tree-${SHA}` },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
      diagnostics: {},
    },
  });
  try {
    const result = validatePromotionReleaseCandidate({
      cwd,
      passportPath,
      repository: "kungfu-systems/buildchain",
      targetChannel: "major",
      sourceHeadSha: SHA,
      sourceTreeSha: `tree-${SHA}`,
    });
    assert.equal(result.treeEquivalent, true);

    const passport = JSON.parse(fs.readFileSync(path.join(cwd, passportPath), "utf8"));
    passport.target.channel = "alpha";
    fs.writeFileSync(path.join(cwd, passportPath), `${JSON.stringify(passport)}\n`);
    assert.throws(
      () => validatePromotionReleaseCandidate({
        cwd,
        passportPath,
        repository: "kungfu-systems/buildchain",
        targetChannel: "major",
        sourceHeadSha: SHA,
        sourceTreeSha: `tree-${SHA}`,
      }),
      /target channel mismatch: expected release, got alpha/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});


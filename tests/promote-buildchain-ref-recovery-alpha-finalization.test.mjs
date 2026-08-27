// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("published alpha finalization stays bound to its exact transaction after the protected version-state PR merges", async () => {
  const transactionSourceSha = "1".repeat(40);
  const transactionReleaseSha = "2".repeat(40);
  const channelMergeSha = "3".repeat(40);
  const version = "1.0.0-alpha.0";
  const exactTag = `v${version}`;
  const durableTarballPath = ".buildchain/sealed/durable-alpha.tgz";
  const requestedTarballPath = ".buildchain/sealed/version-state-rebuild.tgz";
  const durableAssetPath = ".buildchain/sealed/durable-passport.json";
  const requestedAssetPath = ".buildchain/sealed/version-state-passport.json";
  const durableTarballBytes = Buffer.from("durable published alpha bytes", "utf8");
  const requestedTarballBytes = Buffer.from("rebuilt version-state alpha bytes", "utf8");
  const durableAssetBytes = Buffer.from('{"source":"durable"}\n', "utf8");
  const requestedAssetBytes = Buffer.from('{"source":"version-state"}\n', "utf8");
  const durableIntegrity =
    `sha512-${crypto.createHash("sha512").update(durableTarballBytes).digest("base64")}`;
  const artifact = {
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: version,
    digest: durableIntegrity,
    integrity: durableIntegrity,
  };
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version,
      packageManager: "pnpm@11.7.0",
    },
  });
  for (const [relativePath, bytes] of [
    [durableTarballPath, durableTarballBytes],
    [requestedTarballPath, requestedTarballBytes],
    [durableAssetPath, durableAssetBytes],
    [requestedAssetPath, requestedAssetBytes],
  ]) {
    const target = path.join(cwd, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  const createCandidate = ({ relativePath, bytes, assetPath, assetBytes, sourceSha }) => {
    const payload = {
      schemaVersion: 1,
      contract: PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
      repository: "kungfu-systems/buildchain",
      sourceSha,
      sourceTreeSha: crypto.createHash("sha1").update(bytes).digest("hex"),
      runtimeSha: "4".repeat(40),
      manifestDigest: "5".repeat(64),
      passportDigest: "6".repeat(64),
      controllerReceiptDigest: "7".repeat(64),
      files: [
        { path: relativePath, bytes },
        { path: assetPath, bytes: assetBytes },
      ]
        .map((entry) => ({
          path: entry.path,
          size: entry.bytes.length,
          sha256: crypto.createHash("sha256").update(entry.bytes).digest("hex"),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    return {
      ...payload,
      candidateDigest: publicationArtifactCandidateDigest(payload),
    };
  };
  const durableManifest = createPublicationSealedBundle({
    candidate: createCandidate({
      relativePath: durableTarballPath,
      bytes: durableTarballBytes,
      assetPath: durableAssetPath,
      assetBytes: durableAssetBytes,
      sourceSha: transactionSourceSha,
    }),
    packageName: "@kungfu-tech/buildchain",
    packageVersion: version,
    npmTarballPath: durableTarballPath,
    npmIntegrity: durableIntegrity,
    releaseAssetPaths: [durableAssetPath],
  });
  const requestedIntegrity =
    `sha512-${crypto.createHash("sha512").update(requestedTarballBytes).digest("base64")}`;
  const requestedManifest = createPublicationSealedBundle({
    candidate: createCandidate({
      relativePath: requestedTarballPath,
      bytes: requestedTarballBytes,
      assetPath: requestedAssetPath,
      assetBytes: requestedAssetBytes,
      sourceSha: channelMergeSha,
    }),
    packageName: "@kungfu-tech/buildchain",
    packageVersion: version,
    npmTarballPath: requestedTarballPath,
    npmIntegrity: requestedIntegrity,
    releaseAssetPaths: [requestedAssetPath],
  });
  const requestedManifestPath = path.join(
    cwd,
    ".buildchain/admitted/version-state-sealed-bundle.json",
  );
  fs.mkdirSync(path.dirname(requestedManifestPath), { recursive: true });
  fs.writeFileSync(
    requestedManifestPath,
    `${JSON.stringify(requestedManifest, null, 2)}\n`,
  );
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
    channel: "alpha",
    source_sha: transactionSourceSha,
    release_sha: transactionReleaseSha,
    target_ref: "alpha/v1/v1.0",
    release_material_sha: transactionReleaseSha,
    publish_tooling_sha: transactionReleaseSha,
    artifacts: [artifact],
  }, null, 2) + "\n");
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", channelMergeSha],
      ["heads/dev/v1/v1.0", channelMergeSha],
      [`tags/${exactTag}`, transactionSourceSha],
    ]),
  });
  commits.set(channelMergeSha, {
    sha: channelMergeSha,
    tree: { sha: `tree-${channelMergeSha}` },
    parents: [{ sha: transactionSourceSha }, { sha: transactionReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "contained-published-alpha",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: transactionSourceSha,
      release_sha: transactionReleaseSha,
      release_material_sha: transactionReleaseSha,
      publish_tooling_sha: transactionReleaseSha,
      version,
      exact_tag: exactTag,
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
      artifacts: [artifact],
      evidence: [".buildchain/release-evidence/v1.0.0-alpha.0/evidence.json"],
      sealed_bundle: durableManifest,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath,
    extraFiles: durableManifest.files.map((entry) => ({
      path: `${durableManifest.durablePath}/files/${entry.path}`,
      sourcePath: entry.path,
    })),
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
    targetRef: "alpha/v1/v1.0",
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
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishSealedBundleRoot: cwd,
    publishSealedBundleManifest: requestedManifestPath,
    publishRequiredArtifactsJson: JSON.stringify([{
      ...artifact,
      digest: requestedIntegrity,
      integrity: requestedIntegrity,
    }]),
    requireVersionState: true,
    expectedPublicationVersion: version,
    releasePassport: false,
  });

  assert.equal(result.sha, channelMergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.releaseSha, transactionReleaseSha);
  assert.equal(
    result.publishTransaction.sealedBundleRoot,
    durableManifest.root,
  );
  const finalizedTransaction = JSON.parse(
    fs.readFileSync(path.join(cwd, result.publishTransaction.statePath), "utf8"),
  );
  assert.equal(finalizedTransaction.artifacts.length, 1);
  assert.equal(finalizedTransaction.artifacts[0].digest, durableIntegrity);
  assert.notEqual(finalizedTransaction.artifacts[0].digest, requestedIntegrity);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), channelMergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), channelMergeSha);
  assert.equal(refs.get(`tags/${exactTag}`), transactionSourceSha);
  assert.equal(refs.get("tags/v1.0-alpha"), transactionReleaseSha);
  assert.equal(refs.get("tags/v1-alpha"), transactionReleaseSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
  assert.deepEqual(
    result.updates.find(
      (update) => update.action === "finalized-contained-published-transaction",
    ),
    {
      action: "finalized-contained-published-transaction",
      tag: exactTag,
      sourceSha: transactionSourceSha,
      releaseSha: transactionReleaseSha,
      currentChannelSha: channelMergeSha,
      sha: transactionReleaseSha,
    },
  );
});

test("publish transaction resumes partial alpha finalization with exact tag on release material", async () => {
  const oldAlphaSha = "3".repeat(40);
  const versionHeadSha = "4".repeat(40);
  const mergeSha = "5".repeat(40);
  const previousFinalizedSha = "6".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", mergeSha],
      ["heads/dev/v1/v1.0", mergeSha],
      ["tags/v1.0.0-alpha.0", previousFinalizedSha],
    ]),
  });
  commits.set(previousFinalizedSha, {
    sha: previousFinalizedSha,
    tree: { sha: `tree-${previousFinalizedSha}` },
    parents: [{ sha: oldAlphaSha }, { sha: versionHeadSha }],
  });
  commits.set(mergeSha, {
    sha: mergeSha,
    tree: { sha: `tree-${mergeSha}` },
    parents: [{ sha: previousFinalizedSha }, { sha: "7".repeat(40) }],
  });
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0-alpha.0.json");
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "alpha-partial-finalization",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: oldAlphaSha,
      release_sha: versionHeadSha,
      release_material_sha: versionHeadSha,
      publish_tooling_sha: versionHeadSha,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: statePath,
      evidence_path: "",
      state: "finalizing",
      previous_state: "published",
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
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("heads/alpha/v1/v1.0"), mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), previousFinalizedSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), false);
});

test("published alpha recovery accepts the exact protected merge tree after the channel advances", async () => {
  const transactionSourceSha = "3".repeat(40);
  const transactionReleaseSha = "4".repeat(40);
  const requestedMergeSha = "5".repeat(40);
  const currentChannelSha = "6".repeat(40);
  const materialTreeSha = "tree-published-alpha-material";
  const cwd = makeTempWorkspace({
    "package.json": packageManifest("1.0.0-alpha.0"),
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", currentChannelSha],
      ["heads/dev/v1/v1.0", currentChannelSha],
      ["tags/v1.0.0-alpha.0", transactionSourceSha],
    ]),
  });
  octokit.rest.repos = {
    compareCommitsWithBasehead: async () => ({ data: { status: "ahead" } }),
  };
  commits.set(transactionReleaseSha, {
    sha: transactionReleaseSha,
    tree: { sha: materialTreeSha },
    parents: [{ sha: transactionSourceSha }],
  });
  commits.set(requestedMergeSha, {
    sha: requestedMergeSha,
    tree: { sha: materialTreeSha },
    parents: [
      { sha: transactionSourceSha },
      { sha: transactionReleaseSha },
    ],
  });
  commits.set(currentChannelSha, {
    sha: currentChannelSha,
    tree: { sha: `tree-${currentChannelSha}` },
    parents: [{ sha: requestedMergeSha }],
  });
  const differentTreeMergeSha = "7".repeat(40);
  commits.set(differentTreeMergeSha, {
    sha: differentTreeMergeSha,
    tree: { sha: "tree-with-additional-content" },
    parents: [
      { sha: transactionSourceSha },
      { sha: transactionReleaseSha },
    ],
  });
  assert.equal(
    await testReleaseCommitMatchesTransactionMaterial({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      releaseSha: requestedMergeSha,
      transactionReleaseShas: [transactionReleaseSha],
    }),
    true,
  );
  assert.equal(
    await testReleaseCommitMatchesTransactionMaterial({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      releaseSha: differentTreeMergeSha,
      transactionReleaseShas: [transactionReleaseSha],
    }),
    false,
  );
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "published-alpha-protected-merge",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: transactionSourceSha,
      release_sha: transactionReleaseSha,
      release_material_sha: transactionReleaseSha,
      publish_tooling_sha: transactionReleaseSha,
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
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  for (let prerelease = 1; prerelease <= 100; prerelease += 1) {
    refs.set(`heads/buildchain/release-state/1-0-0-alpha-${prerelease}`, `state-${prerelease}`);
  }
  const originalGetRef = octokit.rest.git.getRef;
  const durableStateReadRefs = [];
  octokit.rest.git.getRef = async (args) => {
    if (args.ref.startsWith("heads/buildchain/release-state/")) durableStateReadRefs.push(args.ref);
    return originalGetRef(args);
  };
  const candidateHash = "a".repeat(64);
  const passportPath = ".buildchain/artifacts/release-candidate-passport.json";
  const recoveryReceiptPath = ".buildchain/artifacts/recovery-receipt.json";
  const passport = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-passport",
    repository: "kungfu-systems/buildchain",
    target: { channel: "alpha", ref: "alpha/v1/v1.0", version: "22.22.3-kf.0" },
    source: { headSha: transactionReleaseSha, mergeRefSha: transactionReleaseSha, treeHash: materialTreeSha },
    platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
    diagnostics: {},
    candidateHash,
  };
  const recoveryReceipt = {
    schemaVersion: 1,
    contract: "kungfu-buildchain-release-candidate-recovery/v1",
    action: "reused",
    repository: "kungfu-systems/buildchain",
    originalCandidate: { sourceSha: transactionReleaseSha, tree: materialTreeSha },
    target: { channel: "alpha", ref: "alpha/v1/v1.0", sha: requestedMergeSha, tree: materialTreeSha, version: "1.0.0-alpha.0" },
    recovered: { candidateRoot: `sha256:${candidateHash}` },
    skippedBuildStages: ["install", "build", "verify", "platform-matrix"],
    payloadBytes: "unchanged",
  };
  recoveryReceipt.root = `sha256:${sha256Json(recoveryReceipt)}`;
  fs.mkdirSync(path.join(cwd, ".buildchain/artifacts"), { recursive: true });
  fs.writeFileSync(path.join(cwd, passportPath), `${JSON.stringify(passport, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, recoveryReceiptPath), `${JSON.stringify(recoveryReceipt, null, 2)}\n`);

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: requestedMergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
    publishTransactionOverride: true,
    requireVersionState: true,
    expectedPublicationVersion: "1.0.0-alpha.0",
    promoteOnlyReleaseCandidate: true,
    releaseCandidatePassportPath: passportPath,
    releaseCandidateRecoveryReceiptPath: recoveryReceiptPath,
    releaseCandidateVersion: "1.0.0-alpha.0",
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "resumed-advanced-publication"),
    {
      action: "resumed-advanced-publication",
      ref: "alpha/v1/v1.0",
      requestedSha: requestedMergeSha,
      currentSha: currentChannelSha,
      transactionId: "published-alpha-protected-merge",
      transactionState: "finalizing",
      sha: currentChannelSha,
    },
  );
  assert.deepEqual([...new Set(durableStateReadRefs)], ["heads/buildchain/release-state/1-0-0-alpha-0"]);
  assert.equal(result.updates.some((update) => update.action === "verified-release-candidate" && update.publicationVersionBinding === "recovery-receipt"), true);
});

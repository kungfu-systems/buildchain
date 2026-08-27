// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("publish transaction durable ref updates when create races existing ref visibility", async () => {
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const baseTransaction = {
    schema: 1,
    id: "tx-visibility-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const orderFile = path.join(cwd, "order.log");
  const { octokit, refs, commits } = createGitMock({ orderFile });
  const originalUpdateRef = octokit.rest.git.updateRef;
  const updateForces = [];
  octokit.rest.git.updateRef = async (args) => {
    updateForces.push(args.force);
    return originalUpdateRef(args);
  };

  const first = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: baseTransaction,
    evidencePath: "",
  });

  const originalGetRef = octokit.rest.git.getRef;
  let hideStateRefOnce = true;
  octokit.rest.git.getRef = async (args) => {
    if (hideStateRefOnce && args.ref === "heads/buildchain/release-state/1-0-0") {
      hideStateRefOnce = false;
      throw notFound();
    }
    return originalGetRef(args);
  };

  const second = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      ...baseTransaction,
      state: "publishing",
      previous_state: "prepared",
      updated_at: "2026-07-01T00:00:01.000Z",
    },
    evidencePath: "",
  });

  assert.notEqual(second.sha, first.sha);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), second.sha);
  assert.deepEqual(fs.readFileSync(orderFile, "utf8").trim().split("\n"), [
    "create:refs/heads/buildchain/release-state/1-0-0",
    "create:refs/heads/buildchain/release-state/1-0-0",
    "update:heads/buildchain/release-state/1-0-0",
  ]);
  assert.deepEqual(updateForces, [false]);
  assert.deepEqual(
    commits.get(second.sha).parents.map((parent) => parent.sha),
    [first.sha],
  );
});

test("publish transaction durable ref waits out stale ref reads after non-fast-forward", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-update-race",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "published",
    previous_state: "publishing",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([["heads/buildchain/release-state/1-0-0", SHA]]),
  });
  const racingSha = "c".repeat(40);
  const originalUpdateRef = octokit.rest.git.updateRef;
  const originalGetRef = octokit.rest.git.getRef;
  const updateForces = [];
  let rejectOnce = true;
  let staleReadOnce = false;
  octokit.rest.git.updateRef = async (args) => {
    updateForces.push(args.force);
    if (rejectOnce) {
      rejectOnce = false;
      refs.set("heads/buildchain/release-state/1-0-0", racingSha);
      staleReadOnce = true;
      throw Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
        response: { data: { message: "Update is not a fast forward" } },
      });
    }
    return originalUpdateRef(args);
  };
  octokit.rest.git.getRef = async (args) => {
    if (staleReadOnce && args.ref === "heads/buildchain/release-state/1-0-0") {
      staleReadOnce = false;
      return { data: { object: { sha: SHA } } };
    }
    return originalGetRef(args);
  };

  try {
    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
    assert.deepEqual(updateForces, [false, false]);
    assert.deepEqual(
      commits.get(result.sha).parents.map((parent) => parent.sha),
      [racingSha],
    );
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries a non-fast-forward while the durable ref still reports its parent", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-parent-visible",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "publishing",
    previous_state: "prepared",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:01.000Z",
  };
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/buildchain/release-state/1-0-0", SHA]]),
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  let rejectOnce = true;
  let updateAttempts = 0;
  octokit.rest.git.updateRef = async (args) => {
    updateAttempts += 1;
    if (rejectOnce) {
      rejectOnce = false;
      throw Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
        response: { data: { message: "Update is not a fast forward" } },
      });
    }
    return originalUpdateRef(args);
  };

  try {
    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(updateAttempts, 2);
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries transient durable release-state writes", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const cwd = makeTempWorkspace({});
  const statePath = path.join(cwd, ".buildchain/release-state/1.0.0.json");
  const transaction = {
    schema: 1,
    id: "tx-transient-write",
    repository: "kungfu-systems/buildchain",
    target_ref: "release/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
    version: "1.0.0",
    exact_tag: "v1.0.0",
    channel: "release",
    line: "v1.0",
    version_strategy: "",
    lifecycle_identity: "lifecycle.publish",
    state_ref: "buildchain/release-state/1-0-0",
    state_path: statePath,
    evidence_path: "",
    state: "prepared",
    previous_state: "",
    actor: "codex",
    run_id: "1",
    superseded_by: "",
    failure: "",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
  try {
    const { octokit, refs } = createGitMock();
    const originalCreateRef = octokit.rest.git.createRef;
    let createRefCalls = 0;
    octokit.rest.git.createRef = async (args) => {
      createRefCalls += 1;
      if (createRefCalls === 1) {
        throw transientGitHubError();
      }
      return originalCreateRef(args);
    };

    const result = await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd,
      transaction,
      evidencePath: "",
    });

    assert.equal(createRefCalls, 2);
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.sha);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction retries transient durable release-state reads", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  const sourceCwd = makeTempWorkspace({});
  const freshCwd = makeTempWorkspace({});
  const statePath = path.join(sourceCwd, ".buildchain/release-state/1.0.0.json");
  const { octokit } = createGitMock();
  try {
    await persistDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      cwd: sourceCwd,
      transaction: {
        schema: 1,
        id: "tx-transient-read",
        repository: "kungfu-systems/buildchain",
        target_ref: "release/v1/v1.0",
        source_sha: SHA,
        release_sha: OTHER_SHA,
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        version: "1.0.0",
        exact_tag: "v1.0.0",
        channel: "release",
        line: "v1.0",
        version_strategy: "",
        lifecycle_identity: "lifecycle.publish",
        state_ref: "buildchain/release-state/1-0-0",
        state_path: statePath,
        evidence_path: "",
        state: "published",
        previous_state: "publishing",
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

    const originalGetTree = octokit.rest.git.getTree;
    let getTreeCalls = 0;
    octokit.rest.git.getTree = async (args) => {
      getTreeCalls += 1;
      if (getTreeCalls === 1) {
        throw transientGitHubError("GitHub API 500: other side closed");
      }
      return originalGetTree(args);
    };

    const restored = await restoreDurableReleaseTransaction({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      stateRef: "buildchain/release-state/1-0-0",
      statePath: path.join(freshCwd, ".buildchain/release-state/1.0.0.json"),
      evidencePath: path.join(freshCwd, ".buildchain/release-evidence/1.0.0/evidence.json"),
    });

    assert.equal(getTreeCalls >= 2, true);
    assert.equal(restored.id, "tx-transient-read");
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("publish transaction fails closed when durable state cannot be persisted", async () => {
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
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalCreateRef = octokit.rest.git.createRef;
  octokit.rest.git.createRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      throw new Error("durable state write denied");
    }
    return originalCreateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable state write denied/,
  );

  assert.equal(fs.existsSync(path.join(cwd, "order.log")), false);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

test("publish transaction preserves post-publish failures without publish_failed transition", async () => {
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
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.appendFileSync("order.log", "publish\\n");
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
    kind: "npm",
    name: "@kungfu-tech/buildchain",
    ref: process.env.BUILDCHAIN_VERSION,
    digest: "sha256:published"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  let stateUpdates = 0;
  octokit.rest.git.updateRef = async (args) => {
    if (args.ref.includes("buildchain/release-state")) {
      stateUpdates += 1;
      if (stateUpdates >= 2) {
        throw new Error("durable published state write denied");
      }
    }
    return originalUpdateRef(args);
  };

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
      }),
    /durable published state write denied/,
  );

  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8");
  assert.match(order, /publish/);
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.has("tags/v1.0-alpha"), false);
});

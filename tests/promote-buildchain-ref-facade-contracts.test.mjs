// prettier-ignore
const { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, signedGeneratedCommitMessage, test, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion } = await import("./promote-buildchain-ref-recovery-harness.mjs");
test("product release attachment command receives final coordinates and returns retained files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-attachment-command-"));
  try {
    const script = path.join(cwd, "generate.mjs");
    fs.writeFileSync(
      script,
      [
        'import fs from "node:fs";',
        'const file = "product-evidence.json";',
        'fs.writeFileSync(file, JSON.stringify({',
        '  sourceSha: process.env.BUILDCHAIN_RELEASE_SOURCE_SHA,',
        '  tag: process.env.BUILDCHAIN_RELEASE_TAG,',
        '  channel: process.env.BUILDCHAIN_RELEASE_CHANNEL,',
        '  version: process.env.BUILDCHAIN_RELEASE_VERSION,',
        '  deploymentCoordinate: process.env.BUILDCHAIN_RELEASE_DEPLOYMENT_COORDINATE,',
        '  targetRef: process.env.BUILDCHAIN_RELEASE_TARGET_REF,',
        '  outputDir: process.env.BUILDCHAIN_RELEASE_PASSPORT_OUTPUT_DIR',
        '}));',
        'process.stdout.write(JSON.stringify({ files: [file] }));',
      ].join("\n"),
    );
    const files = generateReleaseEvidenceInputs({
      command: `node ${JSON.stringify(script)}`,
      cwd,
      sourceSha: "a".repeat(40),
      tag: "v4.0.0-alpha.1",
      channel: "alpha",
      version: "4.0.0-alpha.1",
      deploymentCoordinate: "github-release:kungfu-systems/kungfu@v4.0.0-alpha.1",
      targetRef: "alpha/v4/v4.0",
      outputDir: path.join(cwd, "passport"),
    });
    assert.deepEqual(files, [path.join(cwd, "product-evidence.json")]);
    assert.deepEqual(JSON.parse(fs.readFileSync(files[0], "utf8")), {
      sourceSha: "a".repeat(40),
      tag: "v4.0.0-alpha.1",
      channel: "alpha",
      version: "4.0.0-alpha.1",
      deploymentCoordinate: "github-release:kungfu-systems/kungfu@v4.0.0-alpha.1",
      targetRef: "alpha/v4/v4.0",
      outputDir: path.join(cwd, "passport"),
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
test("only the configured major can write the shared npm alpha channel", () => {
  assert.equal(alphaDistTagForPromotion({
    ownsMajorAlphaTag: true,
    line: "v0.1",
    publishDistTag: "alpha",
  }), "alpha");
  assert.equal(alphaDistTagForPromotion({
    ownsMajorAlphaTag: true,
    line: "v3.0",
    sharedAlphaAuthorityMajor: 3,
  }), "");
  assert.equal(alphaDistTagForPromotion({
    ownsMajorAlphaTag: true,
    line: "v3.0",
    publishDistTag: "alpha",
    sharedAlphaAuthorityMajor: 3,
  }), "alpha");
  assert.equal(alphaDistTagForPromotion({
    ownsMajorAlphaTag: true,
    line: "v2.14",
    sharedAlphaAuthorityMajor: 3,
  }), "v2.14-alpha");
  assert.equal(alphaDistTagForPromotion({
    ownsMajorAlphaTag: false,
    line: "v3.0",
    sharedAlphaAuthorityMajor: 3,
  }), "v3.0-alpha");
  assert.throws(
    () => alphaDistTagForPromotion({
      ownsMajorAlphaTag: true,
      line: "v2.14",
      publishDistTag: "alpha",
      sharedAlphaAuthorityMajor: 3,
    }),
    /shared npm alpha authority belongs to v3/,
  );
  assert.throws(
    () => alphaDistTagForPromotion({ ownsMajorAlphaTag: false, line: "" }),
    /alpha publication requires a vN\.N release line/,
  );
});

test("publication authority version binding fails closed on transaction drift", () => {
  assert.equal(assertExpectedPublicationVersion("2.12.7-alpha.3", "2.12.7-alpha.3"), "2.12.7-alpha.3");
  assert.throws(
    () => assertExpectedPublicationVersion("2.12.7-alpha.3", "2.12.7-alpha.4"),
    /publication version changed after authority planning: expected 2\.12\.7-alpha\.3, got 2\.12\.7-alpha\.4/,
  );
});

test("major bootstrap aligns version-bound release impact to the new line", () => {
  const unchanged = {
    path: "package.json",
    content: '{"version":"3.0.0"}\n',
  };
  const aligned = alignMajorBootstrapReleaseImpact([
    unchanged,
    {
      path: ".buildchain/release-impact.json",
      content: JSON.stringify({
        release: { version: "3.0.0", line: "v2.14" },
        classification: "major",
      }),
    },
  ], {
    version: "3.0.0",
  });

  assert.equal(aligned[0], unchanged);
  assert.deepEqual(JSON.parse(aligned[1].content).release, {
    version: "3.0.0",
    line: "v3.0",
  });
  assert.throws(
    () => alignMajorBootstrapReleaseImpact(aligned, {
      version: "not-semver",
    }),
    /requires an exact semantic version/,
  );
});

test("promotion admits only its exact generated sidecars", () => {
  const configured = ["package.json", "dist/site/buildchain-contract.json"];
  assert.deepEqual(
    versionVerificationAllowedPathsForPromotion("major", configured),
    [
      "package.json",
      "dist/site/buildchain-contract.json",
      "dist/site/kfd-claims.json",
    ],
  );
  assert.deepEqual(
    versionVerificationAllowedPathsForPromotion("release", configured),
    ["package.json", "dist/site/buildchain-contract.json", "dist/site/kfd-claims.json", "dist/site/public-surface-audit.json", "dist/site/workflow-registry.json"],
  );
  assert.deepEqual(versionVerificationAllowedPathsForPromotion("alpha", configured), versionVerificationAllowedPathsForPromotion("release", configured));
});
test("durable release passport state excludes binary release assets", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-release-passport-"));
  fs.writeFileSync(path.join(outputDir, "buildchain.release.json"), "{}\n");
  fs.writeFileSync(path.join(outputDir, "SHA256SUMS"), `${"a".repeat(64)}  agent-hub-demo-linux-x64\n`);
  fs.writeFileSync(path.join(outputDir, "agent-hub-demo-linux-x64.sha256"), `${"a".repeat(64)}\n`);
  fs.writeFileSync(path.join(outputDir, "agent-hub-demo-linux-x64"), Buffer.from([0, 255, 1, 254]));
  fs.writeFileSync(path.join(outputDir, "agent-hub-demo-windows-x64.exe"), Buffer.from([77, 90, 0, 255]));

  assert.deepEqual(
    releasePassportArtifactFiles(outputDir).map((entry) => entry.path),
    [
      "release-passport/agent-hub-demo-linux-x64.sha256",
      "release-passport/buildchain.release.json",
      "release-passport/SHA256SUMS",
    ],
  );
});

test("release governance preserves the emitted reusable workflow check context", () => {
  assert.equal(resolveProtectedStatusCheckContext({
    requiredStatusCheck: "check",
    protection: { required_status_checks: { strict: true, contexts: ["check / check"], checks: [{ context: "check / check", app_id: 15368 }] } },
  }), "check / check");
  assert.equal(resolveProtectedStatusCheckContext({
    requiredStatusCheck: "consumer verify",
    protection: { required_status_checks: { strict: true, contexts: ["consumer verify"] } },
  }), "consumer verify");
});

test("release impact path resolves through configured version state", () => {
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
path = ".buildchain/release-impact.json"
key = "release.version"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "2.11.10-alpha.0",
    },
    ".buildchain/release-impact.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-impact",
      release: { version: "2.11.10-alpha.0", line: "v2.11" },
      versionImpact: {
        final: "patch",
        source: "buildchain-version-state",
        rationale: "Version-bound impact.",
      },
      surfaceImpacts: [
        { id: "release-impact-version-binding", impact: "patch", rationale: "Keep the public release asset version-bound." },
      ],
      classification: "patch",
      summary: "Version-bound Buildchain release impact.",
    },
  });

  const resolved = JSON.parse(resolveReleaseImpactInput({
    cwd,
    impactJson: ".buildchain/release-impact.json",
    version: "2.11.10-alpha.1",
  }));

  assert.equal(resolved.release.version, "2.11.10-alpha.1");
  assert.equal(resolved.release.line, "v2.11");
  assert.equal(resolved.classification, "patch");
  assert.equal(resolved.summary, "Version-bound Buildchain release impact.");

  const nextMajor = JSON.parse(resolveReleaseImpactInput({
    cwd,
    impactJson: ".buildchain/release-impact.json",
    version: "3.0.0",
    line: "v3.0",
  }));
  assert.deepEqual(nextMajor.release, {
    version: "3.0.0",
    line: "v3.0",
  });
});

test("tree-equivalent stable promotion derives a release-governance impact ledger", () => {
  const impact = JSON.parse(createTreeEquivalentReleaseImpact({
    channel: "release",
    version: "22.22.3-kf.4",
    tag: "v22.22.3-kf.4",
    line: "v22.22",
    releaseCandidateValidation: {
      treeEquivalent: true,
      candidateHash: "sha256:qualified-candidate",
    },
  }));

  assert.deepEqual(impact.release, {
    tag: "v22.22.3-kf.4",
    line: "v22.22",
    version: "22.22.3-kf.4",
  });
  assert.equal(impact.versionImpact.final, "patch");
  assert.equal(impact.versionImpact.source, "release-candidate-tree-equivalence");
  assert.deepEqual(
    impact.surfaceImpacts.map((entry) => entry.id),
    ["release-candidate-stable-finalization"],
  );
  assert.equal(
    impact.surfaceImpacts[0].source,
    "release-candidate-passport:sha256:qualified-candidate",
  );
});

test("release impact inference stays fail-closed without exact RC tree equivalence", () => {
  assert.equal(
    createTreeEquivalentReleaseImpact({
      channel: "release",
      version: "22.22.3-kf.4",
      releaseCandidateValidation: { treeEquivalent: false },
    }),
    "",
  );
  assert.equal(
    createTreeEquivalentReleaseImpact({
      channel: "alpha",
      version: "22.22.3-kf.4-alpha.1",
      releaseCandidateValidation: { treeEquivalent: true },
    }),
    "",
  );
});

test("durable release transaction treats retried createRef as idempotent", async () => {
  const cwd = makeTempWorkspace({});
  const { octokit, refs, commitLog } = createGitMock();
  const originalCreateRef = octokit.rest.git.createRef;
  const originalUpdateRef = octokit.rest.git.updateRef;
  let createCalls = 0;
  let updateCalls = 0;
  octokit.rest.git.createRef = async (request) => {
    createCalls += 1;
    if (createCalls === 1) {
      await originalCreateRef(request);
      throw transientGitHubError();
    }
    return originalCreateRef(request);
  };
  octokit.rest.git.updateRef = async (request) => {
    updateCalls += 1;
    return originalUpdateRef(request);
  };

  const result = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      exact_tag: "v1.0.0-alpha.0",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.0.json"),
      state: "publishing",
    },
  });

  assert.equal(createCalls, 2);
  assert.equal(updateCalls, 0);
  assert.equal(result.sha, refs.get("heads/buildchain/release-state/1-0-0-alpha-0"));
  assert.equal(commitLog.length, 1);
});

test("durable release transaction treats retried updateRef non-fast-forward as idempotent", async () => {
  const cwd = makeTempWorkspace({});
  const { octokit, refs, commitLog } = createGitMock({
    refs: new Map([["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA]]),
  });
  const originalUpdateRef = octokit.rest.git.updateRef;
  let updateCalls = 0;
  octokit.rest.git.updateRef = async (request) => {
    updateCalls += 1;
    if (updateCalls === 1) {
      await originalUpdateRef(request);
      throw transientGitHubError();
    }
    if (refs.get(request.ref) === request.sha) {
      const error = new Error("Update is not a fast forward");
      error.status = 422;
      error.response = { data: { message: "Update is not a fast forward" } };
      throw error;
    }
    return originalUpdateRef(request);
  };

  const result = await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      exact_tag: "v1.0.0-alpha.0",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.0.json"),
      state: "published",
    },
  });

  assert.equal(updateCalls, 2);
  assert.equal(result.sha, refs.get("heads/buildchain/release-state/1-0-0-alpha-0"));
  assert.equal(commitLog.length, 1);
  assert.deepEqual(commitLog[0].parents, [OTHER_SHA]);
});

test("parseTags accepts exact, minor-floating, and major-floating buildchain tags", () => {
  assert.deepEqual(
    parseTags("v1, v1-alpha, v1.0, v1.0-alpha, v1.0.0, v1.0.1-alpha.0, v1"),
    ["v1", "v1-alpha", "v1.0", "v1.0-alpha", "v1.0.0", "v1.0.1-alpha.0"],
  );
  assert.throws(
    () => parseTags("1.0.0"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("v1.0.1.alpha.0"),
    /Unsupported buildchain promotion tag/,
  );
  assert.throws(
    () => parseTags("latest"),
    /Unsupported buildchain promotion tag/,
  );
});

test("promotion is limited to buildchain alpha and release line refs", () => {
  assertPromotableRepository("kungfu-systems", "buildchain");
  assertPromotableTargetRef("alpha/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.0");
  assertPromotableTargetRef("release/v1/v1.1");
  assertPromotableTargetRef("publish-gate/major");
  assertPromotableTargetRef("major-gate");
  assert.throws(
    () => assertPromotableRepository("kungfu-systems", "other"),
    /limited to kungfu-systems\/buildchain/,
  );
  assert.throws(
    () => assertPromotableTargetRef("dev/v1/v1.0"),
    /alpha\/vN\/vN\.M, release\/vN\/vN\.M, publish-gate\/major, or major-gate/,
  );
  assert.throws(
    () => assertPromotableTargetRef("release/v1/v2.0"),
    /major mismatch/,
  );
  assert.deepEqual(resolveTagsForTarget("alpha/v1/v1.0"), ["v1.0-alpha", "v1-alpha"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.0"), ["v1", "v1.0"]);
  assert.deepEqual(resolveTagsForTarget("release/v1/v1.1"), ["v1", "v1.1"]);
  assert.deepEqual(resolveTagsForTarget("publish-gate/major"), []);
  assert.deepEqual(resolveTagsForTarget("major-gate"), []);
  assert.throws(
    () => resolveTagsForTarget("alpha/v1/v1.0", ["v1"]),
    /not allowed for alpha promotion/,
  );
  assert.throws(
    () => resolveTagsForTarget("release/v1/v1.0", ["v1.1.0"]),
    /not allowed for release promotion/,
  );
  assert.deepEqual(
    resolveTagsForTarget("alpha/v12/v12.34", ["v12.34-alpha", "v12-alpha"]),
    ["v12.34-alpha", "v12-alpha"],
  );
});

test("major alpha channel follows the highest published minor without crossing majors", () => {
  const refs = [
    { ref: "refs/tags/v2.9-alpha", object: { sha: SHA } },
    { ref: "refs/tags/v2.10.3-alpha.4", object: { sha: OTHER_SHA } },
    { ref: "refs/tags/v1.99-alpha", object: { sha: "c".repeat(40) } },
    { ref: "refs/tags/v3.0.0-alpha.0", object: { sha: "d".repeat(40) } },
    { ref: "refs/tags/v2.11.0", object: { sha: "e".repeat(40) } },
  ];

  assert.equal(ownsMajorAlphaChannel({ refs, major: 2, minor: 10 }), true);
  assert.equal(ownsMajorAlphaChannel({ refs, major: 2, minor: 9 }), false);
  assert.equal(ownsMajorAlphaChannel({ refs, major: 2, minor: 11 }), true);
  assert.equal(ownsMajorAlphaChannel({ refs, major: 7, minor: 0 }), true);
});

test("channel promotion PR lineage retries transient GitHub API failures", async () => {
  const originalRetryDelay = process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
  process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = "0";
  let calls = 0;
  const octokit = {
    rest: {
      repos: {
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          calls += 1;
          assert.equal(commit_sha, SHA);
          if (calls === 1) {
            throw transientGitHubError("other side closed");
          }
          return {
            data: [
              {
                merged_at: "2026-07-04T00:00:00Z",
                base: { ref: "alpha/v1/v1.0" },
                head: {
                  ref: "dev/v1/v1.0",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          };
        },
      },
    },
  };

  try {
    await assertChannelPromotionPr({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
    });
    assert.equal(calls, 2);
  } finally {
    if (originalRetryDelay === undefined) {
      delete process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS;
    } else {
      process.env.BUILDCHAIN_GITHUB_RETRY_DELAY_MS = originalRetryDelay;
    }
  }
});

test("release transaction complete transition clears stale failure", () => {
  const record = {
    schema: 1,
    id: "tx-stale-failure",
    repository: "kungfu-systems/buildchain",
    target_ref: "alpha/v1/v1.0",
    source_sha: SHA,
    release_sha: OTHER_SHA,
    release_material_sha: OTHER_SHA,
    publish_tooling_sha: OTHER_SHA,
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
    failure: "GitHub API 500: other side closed",
    artifacts: [],
    evidence: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };

  const complete = transitionReleaseTransaction(record, "complete", {
    actor: "codex",
    runId: "2",
  });
  assert.equal(complete.state, "complete");
  assert.equal(complete.failure, "");

  const cleanedRerun = transitionReleaseTransaction({
    ...complete,
    failure: "GitHub API 500: other side closed",
  }, "complete", {
    actor: "codex",
    runId: "3",
  });
  assert.equal(cleanedRerun.state, "complete");
  assert.equal(cleanedRerun.failure, "");
});

test("promote action validates generic publish source locks before promotion", () => {
  const report = validateRequiredPublishSourceLock({
    sha: SHA,
    publishSourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
    publishSourceSha: SHA,
    publishSourceLocked: "true",
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.publishSource.channel, "release");

  assert.throws(
    () => validateRequiredPublishSourceLock({
      sha: SHA,
      publishSourceRef: "release/v22/v22.22",
      publishSourceSha: SHA,
      publishSourceLocked: "true",
    }),
    /publish source-lock validation failed: .*publish\.source_ref/,
  );

  assert.throws(
    () => validateRequiredPublishSourceLock({
      sha: SHA,
      publishSourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      publishSourceSha: SHA,
      publishSourceLocked: "false",
    }),
    /publish source-lock validation failed: .*publish\.source_locked/,
  );

  assert.throws(
    () => validateRequiredPublishSourceLock({
      sha: SHA,
      publishSourceRef: "publish-gate/release/v22/v22.22/22.22.3-kf.0",
      publishSourceSha: OTHER_SHA,
      publishSourceLocked: "true",
    }),
    /does not match promotion sha/,
  );
});

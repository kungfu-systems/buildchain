import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  alphaDistTagForPromotion,
  alignMajorBootstrapReleaseImpact,
  versionVerificationAllowedPathsForPromotion,
  assertAllowedLocalChanges,
  assertExpectedPublicationVersion,
  assertChannelPromotionPr,
  assertProviderEnforcedChannelTransaction,
  assertProtectedChannel,
  assertPromotableRepository,
  assertPromotableTargetRef,
  createTreeEquivalentReleaseImpact,
  discoverVersionStateFiles,
  ensureManagedChannelBranchProtection,
  expectedHeadRefForTarget,
  isAllowedReleaseLineRecoveryPath,
  latestAlphaForPatch,
  ownsMajorAlphaChannel,
  parseReleaseLineRef,
  parseTags,
  persistDurableReleaseTransaction,
  promoteBuildchainRefs,
  restoreDurableReleaseTransaction,
  runPublishTransaction,
  resolveTagsForTarget,
  runVersionVerification,
  resolveReleaseImpactInput,
  generateReleaseEvidenceInputs,
  resolveProtectedStatusCheckContext,
  releasePassportArtifactFiles,
  selectAlphaTag,
  selectReleaseTag,
  updateVersionStateContents,
  validatePromotionReleaseCandidate,
} = await import("../actions/promote-buildchain-ref/lib.js");
const {
  loadBuildchainConfig,
} = await import("../packages/core/buildchain-config.js");
import {
  GENERATED_COMMIT_SIGN_OFF,
  OTHER_SHA,
  SHA,
  alreadyExists,
  createGitMock,
  makeTempWorkspace,
  notFound,
  productionImpactJson,
  protectedChannel,
  run,
  signedGeneratedCommitMessage,
  transientGitHubError,
  versionStateBranchName,
} from "./helpers/promote-buildchain-ref-fixtures.mjs";

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

test("major bootstrap admits only its exact generated KFD claim sidecar", () => {
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
    ["package.json", "dist/site/buildchain-contract.json"],
  );
});
const {
  explainReleaseLineDryRun,
  formatReleaseLineDryRun,
} = await import("../packages/core/release-line-dry-run.js");
const {
  transitionReleaseTransaction,
} = await import("../packages/core/publish-transaction.js");
const {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} = await import("../packages/core/publication-artifact-candidate.js");
const {
  createPublicationSealedBundle,
} = await import("../packages/core/publication-sealed-bundle.js");
const {
  validateRequiredPublishSourceLock,
  plannedPublicationExactTag,
  collectGitHubReleaseEvidenceAssets,
  publishGitHubReleaseEvidence,
  reuseCompleteGitHubReleaseEvidence,
} = await import("../actions/promote-buildchain-ref/index.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

test("promote action collects GitHub Release evidence assets fail-closed", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.0/evidence.json": { ok: true },
    ".buildchain/release-passport/buildchain.release.json": {
      release: { tag: "v1.0.0" },
    },
    ".buildchain/release-passport/evidence.json": { passport: true },
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
      ".buildchain/release-passport/evidence.json",
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
      assert.equal(body.target_commitish, SHA);
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

test("complete candidate recovery fills an existing GitHub Release when its public Passport is absent", async (t) => {
  const cwd = makeTempWorkspace({
    ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json": { state: "complete" },
    ".buildchain/release-passport/buildchain.release.json": {
      release: { publicTag: "v1.0.1-alpha.0", channel: "alpha", releaseSha: SHA },
    },
    ".buildchain/release-passport/artifact-evidence.json": { ok: true },
    "dist/package.tgz": "sealed product bytes",
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
    if (String(url).endsWith("/releases/123") && options.method === "PATCH") {
      return new Response(JSON.stringify({ id: 123, html_url: "https://github.test/release" }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  const uploaded = [];
  const octokit = {
    rest: {
      repos: {
        listReleaseAssets: async () => ({ data: [] }),
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
    channel: "alpha",
    publishEvidencePath: path.join(cwd, ".buildchain/release-evidence/v1.0.1-alpha.0/evidence.json"),
    releasePassportPath: path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    releasePassportOutputDir: path.join(cwd, ".buildchain/release-passport"),
    additionalAssetPaths: [path.join(cwd, "dist/package.tgz")],
    reuseExistingCompleteEvidence: true,
  });

  assert.equal(result.action, "updated");
  assert.equal(result.uploadedAssetCount, 4);
  assert.deepEqual(uploaded.sort(), [
    "artifact-evidence.json",
    "buildchain.release.json",
    "evidence.json",
    "package.tgz",
  ]);
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

test("governance maps channel targets to the only legal PR source", () => {
  assert.equal(expectedHeadRefForTarget("alpha/v1/v1.0"), "dev/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("release/v1/v1.0"), "alpha/v1/v1.0");
  assert.equal(expectedHeadRefForTarget("publish-gate/major"), "release/vN/vN.M");
  assert.equal(expectedHeadRefForTarget("major-gate"), "release/vN/vN.M");
  assert.deepEqual(parseReleaseLineRef("release/v1/v1.0"), {
    ref: "release/v1/v1.0",
    major: 1,
    minor: 0,
  });
  assert.deepEqual(
    latestAlphaForPatch(
      [
        { ref: "refs/tags/v1.0.2-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.2-alpha.1", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.3-alpha.0", object: { sha: "c".repeat(40) } },
      ],
      "v1.0",
      2,
    ),
    { tag: "v1.0.2-alpha.1", patch: 2, prerelease: 1, sha: OTHER_SHA },
  );
});

test("release line dry-run explains alpha promotion semantics", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "fixture",
      version: "2.0.0-alpha.0",
    },
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "alpha/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "alpha");
  assert.equal(plan.source.expectedHeadRef, "dev/v2/v2.0");
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "alpha/v2/v2.0",
    "dev/v2/v2.0",
  ]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0-alpha", "v2-alpha"]);
  assert.match(formatReleaseLineDryRun(plan), /No refs, tags, packages, or files were modified/);
});

test("release line dry-run explains production and next-alpha semantics", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `schema = 1

[version]
required = true

[[version.files]]
path = "VERSION"
type = "regex"
pattern = "VERSION=(?<version>[^\\n]+)"
replacement = "VERSION={{version}}"
`,
    VERSION: "VERSION=2.0.1-alpha.0\n",
  });
  const plan = explainReleaseLineDryRun({
    cwd,
    targetRef: "release/v2/v2.0",
    sha: SHA,
    tags: ["v2.0.1", "v2.0.2-alpha.0"],
    publishTransaction: true,
  });

  assert.equal(plan.channel, "release");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v2.0.1", "v2.0.2-alpha.0"]);
  assert.deepEqual(plan.floatingRefs.map((update) => update.ref), ["v2.0", "v2", "v2.0-alpha", "v2-alpha"]);
  assert.equal(plan.publishTransaction.enabled, true);
  assert.equal(plan.versionState.manager, "buildchain.toml");
  assert.deepEqual(plan.versionState.files, ["VERSION"]);
  assert.match(plan.governanceChecks.join("\n"), /same-patch exact alpha tag tree/);
});

test("release line dry-run resolves major gate from explicit source ref", () => {
  const plan = explainReleaseLineDryRun({
    cwd: makeTempWorkspace({}),
    targetRef: "publish-gate/major",
    sourceRef: "release/v2/v2.0",
    sha: SHA,
  });

  assert.equal(plan.channel, "major");
  assert.equal(plan.line, "v3.0");
  assert.deepEqual(plan.exactTags.map((tag) => tag.tag), ["v3.0.0", "v3.0.1-alpha.0"]);
  assert.deepEqual(plan.branchUpdates.map((update) => update.ref), [
    "publish-gate/major",
    "release/v3/v3.0",
    "alpha/v3/v3.0",
    "dev/v3/v3.0",
  ]);
});

test("selectReleaseTag creates, increments, and reuses canonical v-prefixed release tags", () => {
  assert.deepEqual(
    selectReleaseTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0",
      patch: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1", object: { sha: SHA } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1", patch: 1, exists: true },
  );
  assert.deepEqual(
    selectReleaseTag({
      refs: [
        { ref: "refs/tags/1.0.99", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        {
          ref: "refs/heads/buildchain/release-state/1-0-1",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.2", patch: 2, exists: false },
  );
});

test("selectAlphaTag creates ABV-style prerelease tags for the minor line", () => {
  assert.deepEqual(
    selectAlphaTag({ refs: [], releasePrefix: "v1.0", sha: SHA }),
    {
      tag: "v1.0.0-alpha.0",
      patch: 0,
      prerelease: 0,
      exists: false,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.0", patch: 1, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
        {
          ref: "refs/heads/buildchain/release-state/1-0-1",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.2-alpha.0", patch: 2, prerelease: 0, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [{ ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } }],
      releasePrefix: "v1.0",
      sha: SHA,
    }),
    {
      tag: "v1.0.1-alpha.0",
      patch: 1,
      prerelease: 0,
      sha: SHA,
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        { ref: "refs/tags/v1.0.0-alpha.0", object: { sha: SHA } },
        { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: OTHER_SHA } },
        { ref: "refs/tags/v1.0.1-alpha.1", object: { sha: "b".repeat(40) } },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    {
      tag: "v1.0.1-alpha.1",
      patch: 1,
      prerelease: 1,
      sha: "b".repeat(40),
      exists: true,
    },
  );
  assert.deepEqual(
    selectAlphaTag({
      refs: [
        {
          ref: "refs/heads/buildchain/release-state/1-0-1-alpha-0",
          object: { sha: OTHER_SHA },
        },
      ],
      releasePrefix: "v1.0",
      sha: SHA,
      patchAfterRelease: 1,
    }),
    { tag: "v1.0.1-alpha.1", patch: 1, prerelease: 1, exists: false },
  );
});

test("discoverVersionStateFiles follows package-manager workspace metadata", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "actions/no-version/package.json": {
      name: "@kungfu-systems/no-version",
      private: true,
    },
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "pnpm");
  assert.deepEqual(
    discovered.files.map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
  assert.deepEqual(
    updateVersionStateContents(discovered.files, "1.0.1").map((file) => file.path),
    ["actions/one/package.json", "package.json"],
  );
});

test("discoverVersionStateFiles prefers buildchain.toml version state", () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "toml"
path = "pyproject.toml"
key = "project.version"
`,
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pyproject.toml": '[project]\nname = "example"\nversion = "1.0.0-alpha.0"\n',
  });

  const discovered = discoverVersionStateFiles(cwd);

  assert.equal(discovered.packageManager.name, "buildchain.toml");
  assert.deepEqual(discovered.files.map((file) => file.path), ["pyproject.toml"]);
  const changed = updateVersionStateContents(discovered.files, "1.0.1");
  assert.equal(changed.length, 1);
  assert.match(changed[0].content, /version = "1.0.1"/);
});

test("version verification allows only discovered version-state file changes", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
    },
    "actions/one/package.json": {
      name: "@kungfu-systems/one",
      version: "1.0.0-alpha.0",
    },
    "README.md": "fixture\n",
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  fs.writeFileSync(
    path.join(cwd, "actions/one/package.json"),
    JSON.stringify({ name: "@kungfu-systems/one", version: "1.0.1-alpha.0" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "changed\n");

  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
    /README\.md/,
  );
  fs.writeFileSync(path.join(cwd, "README.md"), "fixture\n");
  assert.doesNotThrow(() =>
    assertAllowedLocalChanges(cwd, ["actions/one/package.json"]),
  );
});

test("version verification ignores generated buildchain evidence", () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-systems/example",
      version: "1.0.0-alpha.0",
    },
    "README.md": "fixture\n",
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ name: "@kungfu-systems/example", version: "1.0.1-alpha.0" }, null, 2) + "\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-candidate/passport"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-candidate/passport/release-candidate-passport.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/kfd/kfd-1"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".buildchain/kfd/kfd-2/claims"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/kfd/kfd-1/contract-world.witness.json"),
    "{}\n",
  );
  fs.writeFileSync(
    path.join(cwd, ".buildchain/kfd/kfd-2/claims/buildchain-npm-publish-evidence.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-evidence/v1.0.1"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-evidence/v1.0.1/evidence.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-passport"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-passport/buildchain.release.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/release-state"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/release-state/v1.0.1.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/runtime/actions/promote-buildchain-ref"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/runtime/actions/promote-buildchain-ref/action.yml"),
    "name: runtime\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/contract-drift"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/contract-drift/issue-body.md"),
    "# compatible drift\n",
  );
  fs.writeFileSync(
    path.join(cwd, ".buildchain/publication-result.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/admitted/artifact/.buildchain/publication"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/admitted/artifact/.buildchain/publication/publication-artifact.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/admitted/controller"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/admitted/controller/receipt.json"),
    "{}\n",
  );
  fs.mkdirSync(path.join(cwd, ".buildchain/controller"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".buildchain/controller/plan.json"),
    "{}\n",
  );

  assert.doesNotThrow(() => assertAllowedLocalChanges(cwd, ["package.json"]));

  fs.writeFileSync(
    path.join(cwd, ".buildchain/publication-result.json.backup"),
    "{}\n",
  );
  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["package.json"]),
    /\.buildchain\/publication-result\.json\.backup/,
  );
  fs.rmSync(path.join(cwd, ".buildchain/publication-result.json.backup"));

  fs.writeFileSync(path.join(cwd, ".buildchain/other.json"), "{}\n");
  assert.throws(
    () => assertAllowedLocalChanges(cwd, ["package.json"]),
    /\.buildchain\/other\.json/,
  );
});

test("version-state lifecycle can materialize declared derived files before verification", () => {
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

[lifecycle.verify]
command = "node scripts/check-site-contract.mjs"
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
    "scripts/check-site-contract.mjs": `
import assert from "node:assert/strict";
import fs from "node:fs";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const contract = JSON.parse(fs.readFileSync("dist/site/buildchain-contract.json", "utf8"));
assert.equal(contract.product.version, pkg.version);
assert.equal(contract.generated, true);
`,
  });
  run(["git", "init"], cwd);
  run(["git", "add", "."], cwd);
  run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"], cwd);

  const discovered = discoverVersionStateFiles(cwd);
  const changedFiles = updateVersionStateContents(discovered.files, "1.0.1-alpha.0");
  const verifiedChangedFiles = runVersionVerification({
    cwd,
    loadedConfig: discovered.config,
    version: "1.0.1-alpha.0",
    changedFiles,
    allowedPaths: discovered.files.map((file) => file.path),
  });

  assert.deepEqual(
    verifiedChangedFiles.map((file) => file.path),
    ["dist/site/buildchain-contract.json", "package.json"],
  );
  const contract = JSON.parse(
    verifiedChangedFiles.find((file) => file.path === "dist/site/buildchain-contract.json").content,
  );
  assert.deepEqual(contract, {
    product: { version: "1.0.1-alpha.0" },
    generated: true,
  });
});

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
    ["updateRef", "tags/v1.0", SHA, true],
    ["getRef", "tags/v1.1"],
    ["updateRef", "tags/v1", SHA, true],
    ["getRef", "tags/v1.0.1-alpha.0"],
    ["createRef", "refs/tags/v1.0.1-alpha.0", SHA],
    ["updateRef", "tags/v1.0-alpha", SHA, true],
    ["listMatchingRefs", "tags/v1."],
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
    ["updateRef", "tags/v1.0-alpha", SHA, true],
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

test("rerunning the same release SHA reuses exact tags", async () => {
  const octokit = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (
            ref === "heads/release/v1/v1.0" ||
            ref === "tags/v1.0.0" ||
            ref === "tags/v1.0.1-alpha.0"
          ) {
            return { data: { object: { sha: SHA } } };
          }
          throw notFound();
        },
        listMatchingRefs: async () => ({
          data: [
            { ref: "refs/tags/v1.0.0", object: { sha: SHA } },
            { ref: "refs/tags/v1.0.1-alpha.0", object: { sha: SHA } },
          ],
        }),
        updateRef: async () => ({}),
        createRef: async () => {
          throw new Error("createRef should not be called for exact tags");
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
    { tag: "v1.0.0", action: "existing", sha: SHA },
    { tag: "v1.0", action: "updated", sha: SHA },
    { tag: "v1", action: "updated", sha: SHA },
    { tag: "v1.0.1-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "updated", sha: SHA },
    { tag: "v1-alpha", action: "updated", sha: SHA },
  ]);
});

test("release promotion creates source version commits and points refs at them", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "pnpm-workspace.yaml": 'packages:\n  - "actions/*"\n',
    "actions/promote-buildchain-ref/package.json": {
      name: "@kungfu-systems/buildchain-promote-buildchain-ref",
      version: "1.0.0-alpha.0",
      private: true,
    },
  });
  const refs = new Map([["heads/release/v1/v1.0", SHA]]);
  const blobs = [];
  const commits = [];
  const repoUpdates = [];
  let getCommitCalls = 0;
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
        getCommit: async ({ commit_sha }) => {
          getCommitCalls += 1;
          if (getCommitCalls === 1) {
            throw Object.assign(new Error("other side closed"), {
              status: 500,
            });
          }
          return { data: { tree: { sha: `tree-${commit_sha}` } } };
        },
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
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(getCommitCalls, 3);
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0.0"), releaseSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextAlphaSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v1/v1.0",
    },
  ]);
  assert.deepEqual(
    commits.map((commit) => [commit.message, commit.parents]),
    [
      [signedGeneratedCommitMessage("chore(release): release v1.0.0"), [SHA]],
      [signedGeneratedCommitMessage("chore(release): prepare v1.0.1-alpha.0"), [releaseSha]],
    ],
  );
  assert.equal(blobs.length, 4);
  assert(
    blobs.slice(0, 2).every(({ content }) => content.includes('"version": "1.0.0"')),
  );
  assert(
    blobs
      .slice(2)
      .every(({ content }) => content.includes('"version": "1.0.1-alpha.0"')),
  );
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "created-version-state")
      .map((update) => [update.version, update.packageManager]),
    [
      ["1.0.0", "pnpm"],
      ["1.0.1-alpha.0", "pnpm"],
    ],
  );
});

test("release promotion updates default branch before direct next-alpha sync", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["heads/alpha/v1/v1.0", SHA],
  ]);
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
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
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
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  assert.equal(result.sha, releaseSha);
  assert.equal(result.nextAlphaSha, nextAlphaSha);
  assert.equal(result.pendingPullRequest, undefined);
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextAlphaSha);
  assert.equal(refs.get("tags/v1.0"), releaseSha);
  assert.equal(refs.get("tags/v1"), releaseSha);
  assert.deepEqual(repoUpdates, [
    {
      owner: "kungfu-systems",
      repo: "buildchain",
      default_branch: "dev/v1/v1.0",
    },
  ]);
  assert.deepEqual(
    result.updates
      .filter((update) => update.action === "updated-default-branch" || update.ref === "alpha/v1/v1.0")
      .map((update) => [update.ref, update.action]),
    [
      ["dev/v1/v1.0", "updated-default-branch"],
      ["alpha/v1/v1.0", "updated"],
    ],
  );
});

test("release finalization merges protected alpha next-alpha ancestry", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/release/v1/v1.0", SHA],
    ["heads/alpha/v1/v1.0", OTHER_SHA],
  ]);
  const commits = [];
  let createdPullRequest;
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
            tree: { sha: `tree-${commit_sha}` },
            parents: commit_sha.startsWith("commit-2")
              ? [{ sha: commits[0]?.sha }]
              : [],
          },
        }),
        getTree: async () => ({
          data: { tree: [] },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async ({ message, parents }) => {
          const sha = `commit-${commits.length + 1}`.padEnd(40, "0");
          commits.push({ sha, message, parents });
          return { data: { sha } };
        },
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v1/v1.0" && sha.startsWith("commit-2")) {
            const error = new Error("Update is not a fast forward");
            error.status = 422;
            error.response = {
              data: { message: "Update is not a fast forward" },
            };
            throw error;
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: `https://github.com/kungfu-systems/buildchain/pull/test`,
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
      repos: {
        update: async () => ({}),
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
    targetRef: "release/v1/v1.0",
    cwd,
  });

  const releaseSha = commits[0].sha;
  const nextAlphaSha = commits[1].sha;
  const nextAlphaMergeSha = commits[2].sha;
  assert.equal(refs.get("heads/release/v1/v1.0"), releaseSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextAlphaMergeSha);
  assert.deepEqual(commits[1].parents, [releaseSha]);
  assert.deepEqual(commits[2].parents, [OTHER_SHA, nextAlphaSha]);
  assert.equal(createdPullRequest, undefined);
  assert.equal(result.nextAlphaSha, nextAlphaMergeSha);
  assert.equal(
    result.updates.some(
      (update) =>
        update.ref === "alpha/v1/v1.0" &&
        update.action === "created-version-state-merge" &&
        update.sha === nextAlphaMergeSha,
    ),
    true,
  );
});

test("publish transaction gates alpha final refs on lifecycle.publish evidence", async () => {
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
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";
import path from "node:path";

fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.appendFileSync("order.log", "publish\\n");
fs.writeFileSync("required-artifacts.json", process.env.BUILDCHAIN_REQUIRED_ARTIFACTS + "\\n");
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
    digest: "sha256:alpha"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commitLog } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    orderFile: path.join(cwd, "order.log"),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
      },
    ]),
  });

  const alphaSha = commitLog[0].sha;
  assert.equal(result.sha, alphaSha);
  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.failure, "");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-0");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(cwd, "required-artifacts.json"), "utf8")),
    [{
      group: "",
      kind: "npm",
      name: "@kungfu-tech/buildchain",
      ref: "1.0.0-alpha.0",
      digest: "",
      role: "",
      required: true,
    }],
  );
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-0"), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), alphaSha);
  assert.equal(refs.get("tags/v1-alpha"), alphaSha);
  const order = fs.readFileSync(path.join(cwd, "order.log"), "utf8").trim().split("\n");
  assert.equal(order[0], "create:refs/heads/buildchain/release-state/1-0-0-alpha-0");
  assert.equal(order.filter((entry) => entry.includes("buildchain/release-state")).length >= 4, true);
  assert.deepEqual(order.filter((entry) => !entry.includes("buildchain/release-state")), [
    "publish",
    "update:heads/alpha/v1/v1.0",
    "create:refs/heads/dev/v1/v1.0",
    "create:refs/tags/v1.0.0-alpha.0",
    "update:tags/v1.0-alpha",
    "update:tags/v1-alpha",
  ]);
});

test("OCI provenance conflicts enter repair_required before alpha refs move", async () => {
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
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

const [required] = JSON.parse(process.env.BUILDCHAIN_REQUIRED_ARTIFACTS);
const digest = "sha256:reused";
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
    ...required,
    digest,
    verification: {
      public_manifest: true,
      ref: required.ref,
      digest: "sha256:registry-conflict",
      platform: required.platform,
      contract_major: required.contract_major,
      evidence: "registry-inspect.json",
      smoke: { policy: "manifest-contract", passed: true, evidence: "smoke.json" }
    }
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
  });

  await assert.rejects(
    () => promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "alpha/v1/v1.0",
      cwd,
      publishTransaction: true,
      publishRequiredArtifactsJson: JSON.stringify([{
        group: "image",
        kind: "oci",
        name: "ghcr.io/kungfu-systems/base-linux",
        action: "reused",
        platform: "linux/amd64",
        contract_major: 1,
        content: {
          version: "0.9.9",
          ref: "0.9.9",
          source_sha: "c".repeat(40),
          material_sha: "d".repeat(40),
        },
      }]),
    }),
    /verification\.digest mismatch/,
  );

  const state = JSON.parse(fs.readFileSync(
    path.join(cwd, ".buildchain/release-state/v1.0.0-alpha.0.json"),
    "utf8",
  ));
  assert.equal(state.state, "repair_required");
  assert.equal(refs.has("tags/v1.0.0-alpha.0"), false);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
});

test("release final-version trusted publishing runs without npm token auth", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

const requiredArtifacts = JSON.parse(process.env.BUILDCHAIN_REQUIRED_ARTIFACTS);
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync("publish-env.json", JSON.stringify({
  mode: process.env.BUILDCHAIN_PUBLISH_MODE,
  auth: process.env.BUILDCHAIN_PUBLISH_AUTH,
  distTag: process.env.BUILDCHAIN_NPM_DIST_TAG,
  tokenConfigured: Boolean(process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || process.env.npm_config__authToken),
  requiredArtifacts
}, null, 2) + "\\n");
fs.writeFileSync(process.env.BUILDCHAIN_PUBLISH_EVIDENCE, JSON.stringify({
  schema: 1,
  version: process.env.BUILDCHAIN_VERSION,
  channel: process.env.BUILDCHAIN_CHANNEL,
  source_sha: process.env.BUILDCHAIN_SOURCE_SHA,
  release_sha: process.env.BUILDCHAIN_RELEASE_SHA,
  target_ref: process.env.BUILDCHAIN_TARGET_REF,
  release_material_sha: process.env.BUILDCHAIN_RELEASE_MATERIAL_SHA,
  publish_tooling_sha: process.env.BUILDCHAIN_PUBLISH_TOOLING_SHA,
  artifacts: requiredArtifacts.map((artifact) => ({
    ...artifact,
    digest: "sha256:release-image"
  }))
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    npm_config__authToken: process.env.npm_config__authToken,
  };
  delete process.env.NODE_AUTH_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.npm_config__authToken;
  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      releasePassportImpactJson: productionImpactJson(),
      publishRequiredArtifactsJson: JSON.stringify([
        {
          kind: "oci",
          name: "ghcr.io/kungfu-systems/build-images/base-linux",
          ref_template: "v{version}",
        },
      ]),
    });

    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(refs.has("tags/v1.0.0"), true);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(cwd, "publish-env.json"), "utf8")),
      {
        mode: "publish-final-version",
        auth: "trusted-publishing",
        distTag: "latest",
        tokenConfigured: false,
        requiredArtifacts: [{
          group: "",
          kind: "oci",
          name: "ghcr.io/kungfu-systems/build-images/base-linux",
          ref: "v1.0.0",
          digest: "",
          role: "",
          required: true,
        }],
      },
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("publish transaction expands ref templates after skipping occupied alpha versions", async () => {
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
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

const [required] = JSON.parse(process.env.BUILDCHAIN_REQUIRED_ARTIFACTS);
fs.mkdirSync(process.env.BUILDCHAIN_EVIDENCE_DIR, { recursive: true });
fs.writeFileSync("required-artifacts.json", process.env.BUILDCHAIN_REQUIRED_ARTIFACTS + "\\n");
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
    ...required,
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
      ["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "oci",
        name: "ghcr.io/kungfu-systems/build-images/base-linux",
        ref_template: "v{version}",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-1");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), OTHER_SHA);
  assert.equal(refs.has("tags/v1.0.0-alpha.1"), true);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-1"), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(cwd, "required-artifacts.json"), "utf8")),
    [{
      group: "",
      kind: "oci",
      name: "ghcr.io/kungfu-systems/build-images/base-linux",
      ref: "v1.0.0-alpha.1",
      digest: "",
      role: "",
      required: true,
    }],
  );
  const transaction = JSON.parse(fs.readFileSync(
    path.join(cwd, result.publishTransaction.statePath),
    "utf8",
  ));
  assert.equal(transaction.artifacts[0].ref, "v1.0.0-alpha.1");
  const passport = JSON.parse(fs.readFileSync(
    path.join(cwd, result.publishTransaction.releasePassportPath),
    "utf8",
  ));
  assert.equal(
    passport.artifacts.find((artifact) => artifact.kind === "oci")?.ref,
    "v1.0.0-alpha.1",
  );
});

test("invalid ref templates fail before lifecycle publish", async () => {
  for (const refTemplate of ["v{tag}", "v{version", "v{version}{version}"]) {
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
        packageManager: "pnpm@11.7.0",
      },
      "scripts/publish.mjs": `
import fs from "node:fs";
fs.writeFileSync("publish-ran", "unexpected\\n");
`,
    });
    const { octokit } = createGitMock({
      refs: new Map([["heads/alpha/v1/v1.0", SHA]]),
    });

    await assert.rejects(
      () => promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "alpha/v1/v1.0",
        cwd,
        publishTransaction: true,
        publishRequiredArtifactsJson: JSON.stringify([{
          kind: "oci",
          name: "ghcr.io/kungfu-systems/build-images/base-linux",
          ref_template: refTemplate,
        }]),
      }),
      /ref_template/,
    );
    assert.equal(fs.existsSync(path.join(cwd, "publish-ran")), false);
  }
});

test("release publish transaction can promote existing npm artifacts by dist tag", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
package_set_order = "platforms-first-main-last"
main_package = "@kungfu-tech/buildchain"

[lifecycle.publish]
command = "node scripts/should-not-run.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/build-summary.json": "/home/runner/work/buildchain/buildchain/.buildchain/artifacts/build-summary.json\n",
    "scripts/should-not-run.mjs": "throw new Error('lifecycle.publish should not run');\n",
  });
  const binDir = path.join(cwd, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npm"),
    `#!/bin/sh
echo "$@" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then
  printf 'keren\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then
  printf '""\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then
  printf '"sha512-existing"\\n'
  exit 0
fi
if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 64
`,
  );
  fs.chmodSync(path.join(binDir, "npm"), 0o755);

  const { octokit, refs, blobs, trees, commits } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    PATH: process.env.PATH,
    NPM_LOG: process.env.NPM_LOG,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.NPM_LOG = path.join(cwd, "npm.log");
  process.env.NODE_AUTH_TOKEN = "test-token";
  try {
    const result = await promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      cwd,
      publishTransaction: true,
      releasePassportProductName: "Libnode",
      releasePassportImpactJson: productionImpactJson(),
      publishRequiredArtifactsJson: JSON.stringify([
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-linux-x64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "linux-x64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-darwin-arm64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "darwin-arm64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain-win32-x64",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "platform",
          platform: "win32-x64",
        },
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.0",
          digest: "sha512-rebuilt",
          role: "main",
        },
      ]),
    });

    assert.equal(result.publishTransaction.state, "complete");
    assert.equal(refs.has("tags/v1.0.0"), true);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(cwd, result.publishTransaction.evidencePath), "utf8"),
    );
    assert.deepEqual(evidence.artifacts, [
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-linux-x64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
        platform: "linux-x64",
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-darwin-arm64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
        platform: "darwin-arm64",
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain-win32-x64",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "platform",
        required: true,
        platform: "win32-x64",
      },
      {
        group: "",
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0",
        digest: "sha512-existing",
        role: "main",
        required: true,
      },
    ]);
    assert.deepEqual(
      fs.readFileSync(process.env.NPM_LOG, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("dist-tag add")),
      [
        "dist-tag add @kungfu-tech/buildchain-linux-x64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain-darwin-arm64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain-win32-x64@1.0.0 latest",
        "dist-tag add @kungfu-tech/buildchain@1.0.0 latest",
      ],
    );
    assert.equal(result.publishTransaction.releasePassportPath, ".buildchain/release-passport/buildchain.release.json");
    assert.equal(result.publishTransaction.releasePassportOutputDir, ".buildchain/release-passport");
    assert.equal(refs.get("heads/buildchain/release-state/1-0-0"), result.publishTransaction.releasePassportStateSha);
    const stateCommit = commits.get(result.publishTransaction.releasePassportStateSha);
    const passportEntry = (trees.get(stateCommit.tree.sha) || []).find((entry) =>
      entry.path === "release-passport/buildchain.release.json"
    );
    assert.ok(passportEntry);
    const passport = JSON.parse(
      Buffer.from(blobs.get(passportEntry.sha).content, "base64").toString("utf8"),
    );
    assert.equal(passport.packageSet.platforms.length, 3);
    assert.equal(passport.product.name, "Libnode");
    assert.equal(passport.distTagPromotion.fields.distTag, "latest");
    assert.equal(passport.release.releaseStateRef, "refs/heads/buildchain/release-state/1-0-0");
    assert.match(passport.release.releaseStateSha, /^commit-\d+0+$/);
    assert.ok(commits.has(passport.release.releaseStateSha));
    assert.equal(stateCommit.parents[0].sha, passport.release.releaseStateSha);
    assert.equal(passport.buildSummary, undefined);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release passport verification failure blocks durable passport persistence", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
main_package = "@kungfu-tech/buildchain"

[lifecycle.publish]
command = "node scripts/should-not-run.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
    ".buildchain/artifacts/build-summary.json": "/home/runner/work/buildchain/buildchain/.buildchain/artifacts/build-summary.json\n",
    "scripts/should-not-run.mjs": "throw new Error('lifecycle.publish should not run');\n",
  });
  const binDir = path.join(cwd, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "npm"),
    `#!/bin/sh
echo "$@" >> "$NPM_LOG"
if [ "$1" = "whoami" ]; then
  printf 'keren\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then
  printf '""\\n'
  exit 0
fi
if [ "$1" = "view" ] && [ "$3" = "dist.integrity" ]; then
  printf '"sha512-existing"\\n'
  exit 0
fi
if [ "$1" = "dist-tag" ] && [ "$2" = "add" ]; then
  exit 0
fi
exit 64
`,
  );
  fs.chmodSync(path.join(binDir, "npm"), 0o755);

  const { octokit, refs, commits, trees } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    PATH: process.env.PATH,
    NPM_LOG: process.env.NPM_LOG,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.NPM_LOG = path.join(cwd, "npm.log");
  process.env.NODE_AUTH_TOKEN = "test-token";
  try {
    await assert.rejects(
      () => promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "release/v1/v1.0",
        cwd,
        publishTransaction: true,
        releasePassportProductName: "Libnode",
        publishRequiredArtifactsJson: JSON.stringify([
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0",
            digest: "sha512-rebuilt",
            role: "main",
          },
        ]),
      }),
      /Release passport generated check failed.*impact\.surfaceImpacts\.required/,
    );

    const stateSha = refs.get("heads/buildchain/release-state/1-0-0");
    assert.ok(stateSha);
    const stateCommit = commits.get(stateSha);
    assert.ok(stateCommit);
    assert.equal(
      (trees.get(stateCommit.tree.sha) || []).some((entry) =>
        entry.path === "release-passport/buildchain.release.json"
      ),
      false,
    );
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release existing-version promotion fails before transaction side effects without npm token", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "promote-existing-version"
auth = "npm-token"
dist_tag = "latest"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  const previousEnv = {
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN,
    NPM_TOKEN: process.env.NPM_TOKEN,
    npm_config__authToken: process.env.npm_config__authToken,
  };
  delete process.env.NODE_AUTH_TOKEN;
  delete process.env.NPM_TOKEN;
  delete process.env.npm_config__authToken;
  try {
    await assert.rejects(
      () =>
        promoteBuildchainRefs({
          octokit,
          owner: "kungfu-systems",
          repo: "buildchain",
          sha: SHA,
          targetRef: "release/v1/v1.0",
          cwd,
          publishTransaction: true,
          publishRequiredArtifactsJson: JSON.stringify([
            {
              kind: "npm",
              name: "@kungfu-tech/buildchain",
              ref: "1.0.0",
              digest: "sha512-existing",
            },
          ]),
        }),
      /requires npm token auth before dist-tag promotion/,
    );
    assert.equal(refs.has("heads/buildchain/release-state/1-0-0"), false);
    assert.equal(refs.has("tags/v1.0.0"), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("release final-version trusted publishing rejects alpha package refs", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "latest"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "0.0.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/release/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });

  await assert.rejects(
    () =>
      promoteBuildchainRefs({
        octokit,
        owner: "kungfu-systems",
        repo: "buildchain",
        sha: SHA,
        targetRef: "release/v1/v1.0",
        cwd,
        publishTransaction: true,
        publishRequiredArtifactsJson: JSON.stringify([
          {
            kind: "npm",
            name: "@kungfu-tech/buildchain",
            ref: "1.0.0-alpha.0",
            digest: "sha512-alpha",
          },
        ]),
      }),
    /must publish final package refs, not alpha refs/,
  );
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0"), false);
  assert.equal(refs.has("tags/v1.0.0"), false);
});

test("explicit override replaces an unpublished stale alpha transaction identity", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/buildchain",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

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
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-alpha-1",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: OTHER_SHA,
      release_sha: OTHER_SHA,
      release_material_sha: OTHER_SHA,
      publish_tooling_sha: OTHER_SHA,
      version: "1.0.0-alpha.1",
      exact_tag: "v1.0.0-alpha.1",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-1",
      state_path: "",
      evidence_path: "",
      state: "published",
      previous_state: "",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [],
      evidence: [],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const options = {
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    tags: ["v1.0.0-alpha.1"],
    cwd,
    requireVersionState: false,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.1",
        digest: "sha256:alpha1",
      },
    ]),
  };

  const result = await promoteBuildchainRefs({
    ...options,
    publishTransactionOverride: true,
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.1");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-1");
  assert.equal(refs.get("tags/v1.0.0-alpha.1"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0-alpha-1") !== OTHER_SHA, true);
  const recovered = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0-alpha-1",
    statePath: path.join(cwd, ".buildchain", "release-state.json"),
    evidencePath: path.join(cwd, ".buildchain", "publish-evidence.json"),
  });
  assert.equal(recovered.source_sha, SHA);
  assert.equal(recovered.release_sha, SHA);
  assert.equal(recovered.state, "complete");
});

test("publish transaction replaces stale current alpha transaction identity", async () => {
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
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

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
    digest: "sha256:alpha1"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: OTHER_SHA,
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
      state: "published",
      previous_state: "",
      actor: "",
      run_id: "",
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
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha1",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(result.publishTransaction.stateRef, "buildchain/release-state/1-0-0-alpha-0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
  assert.equal(refs.get("heads/buildchain/release-state/1-0-0-alpha-0") !== OTHER_SHA, true);
  const recovered = await restoreDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    stateRef: "buildchain/release-state/1-0-0-alpha-0",
    statePath: path.join(cwd, ".buildchain", "release-state.json"),
    evidencePath: path.join(cwd, ".buildchain", "publish-evidence.json"),
  });
  assert.equal(recovered.source_sha, SHA);
  assert.equal(recovered.release_sha, SHA);
  assert.equal(recovered.state, "complete");
});

test("publish transaction ignores local-only stale alpha residue", async () => {
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
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

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
    digest: "sha256:alpha0"
  }]
}, null, 2) + "\\n");
`,
  });
  const localStatePath = path.join(cwd, ".buildchain", "release-state", "v1.0.0-alpha.0.json");
  fs.mkdirSync(path.dirname(localStatePath), { recursive: true });
  fs.writeFileSync(
    localStatePath,
    JSON.stringify(
      {
        schema: 1,
        id: "local-residue",
        repository: "kungfu-systems/buildchain",
        target_ref: "alpha/v1/v1.0",
        source_sha: OTHER_SHA,
        release_sha: OTHER_SHA,
        release_material_sha: OTHER_SHA,
        publish_tooling_sha: OTHER_SHA,
        version: "1.0.0-alpha.99",
        exact_tag: "v1.0.0-alpha.99",
        channel: "alpha",
        line: "v1.0",
        version_strategy: "",
        lifecycle_identity: "lifecycle.publish",
        state_ref: "buildchain/release-state/1-0-0-alpha-99",
        state_path: localStatePath,
        evidence_path: "",
        state: "complete",
        previous_state: "finalizing",
        actor: "",
        run_id: "",
        superseded_by: "",
        failure: "",
        artifacts: [],
        evidence: [],
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
  );
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
    ]),
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.0-alpha.0",
        digest: "sha256:alpha0",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.0-alpha.0");
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), SHA);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-99"), false);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-0-alpha-0"), true);
});

test("declared alpha version outranks older resumable durable state", async () => {
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
      version: "1.0.1-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

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
    digest: "sha256:alpha-current"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
      ["heads/buildchain/release-state/1-0-0-alpha-0", OTHER_SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "old-open-alpha-0",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: SHA,
      release_material_sha: SHA,
      publish_tooling_sha: SHA,
      version: "1.0.0-alpha.0",
      exact_tag: "v1.0.0-alpha.0",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-0",
      state_path: "",
      evidence_path: "",
      state: "publishing",
      previous_state: "prepared",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.1-alpha.1",
          digest: "sha256:stale-alpha",
        },
      ],
      evidence: [".buildchain/release-evidence/v1.0.1-alpha.1/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([
      {
        kind: "npm",
        name: "@kungfu-tech/buildchain",
        ref: "1.0.1-alpha.0",
        digest: "sha256:alpha-current",
      },
    ]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.1-alpha.0");
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-1-alpha-0"), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.0"), undefined);
});

test("alpha promotion skips published durable state reached only through channel history", async () => {
  const staleSourceSha = "7".repeat(40);
  const staleReleaseSha = "8".repeat(40);
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
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
    "scripts/publish.mjs": `
import fs from "node:fs";

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
    digest: "sha256:alpha-current"
  }]
}, null, 2) + "\\n");
`,
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", OTHER_SHA],
      ["tags/v1.0-alpha", OTHER_SHA],
      ["tags/v1.0.0-alpha.0", OTHER_SHA],
    ]),
  });
  commits.set(SHA, {
    sha: SHA,
    tree: { sha: `tree-${SHA}` },
    parents: [{ sha: staleReleaseSha }],
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    cwd,
    transaction: {
      schema: 1,
      id: "stale-alpha-1",
      repository: "kungfu-systems/buildchain",
      target_ref: "alpha/v1/v1.0",
      source_sha: staleSourceSha,
      release_sha: staleReleaseSha,
      release_material_sha: staleReleaseSha,
      publish_tooling_sha: staleReleaseSha,
      version: "1.0.1-alpha.1",
      exact_tag: "v1.0.1-alpha.1",
      channel: "alpha",
      line: "v1.0",
      version_strategy: "",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-1-alpha-1",
      state_path: "",
      evidence_path: "",
      state: "published",
      previous_state: "publishing",
      actor: "",
      run_id: "",
      superseded_by: "",
      failure: "",
      artifacts: [
        {
          kind: "npm",
          name: "@kungfu-tech/buildchain",
          ref: "1.0.1-alpha.1",
          digest: "sha256:stale-alpha",
        },
      ],
      evidence: [".buildchain/release-evidence/v1.0.1-alpha.1/evidence.json"],
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    evidencePath: "",
  });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, "v1.0.1-alpha.2");
  assert.equal(refs.get("heads/alpha/v1/v1.0"), result.sha);
  assert.equal(refs.get("tags/v1.0.1-alpha.2"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), result.sha);
  assert.equal(refs.has("tags/v1.0.1-alpha.1"), false);
  assert.equal(refs.has("heads/buildchain/release-state/1-0-1-alpha-2"), true);
});

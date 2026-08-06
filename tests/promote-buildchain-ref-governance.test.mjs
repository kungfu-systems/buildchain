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
const { sha256Json } = await import("../packages/core/release-candidate.js");

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
} = await import("../actions/promote-buildchain-ref/index.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  const releaseSha = "c".repeat(40); const advancedSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const { octokit, refs, commits } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", advancedSha],
      ["heads/dev/v1/v1.0", advancedSha],
      ["tags/v1.0-alpha", advancedSha],
      ["tags/v1-alpha", advancedSha],
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
  const result = await promoteBuildchainRefs({
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
  });

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
  assert.equal(result.updates.at(-1).action, "finalized-advanced-publication");
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

test("promote-only RC passport tolerates legacy unbound target channel", () => {
  const cwd = makeTempWorkspace({
    ".buildchain/artifacts/release-candidate-passport.json": {
      schemaVersion: 1,
      contract: "kungfu-buildchain-release-candidate-passport",
      repository: "kungfu-systems/buildchain",
      target: { channel: "none", ref: "", version: "source-aaaaaaaaaaaa" },
      source: { headSha: SHA, mergeRefSha: SHA, treeHash: `tree-${SHA}` },
      platformMatrix: [{ platformId: "linux-x64", artifactName: "buildchain-linux-x64" }],
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
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("strict alpha promotion requires a protected dev-to-alpha PR", async () => {
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
        listMatchingRefs: async () => ({ data: [] }),
        createRef: async () => ({}),
        updateRef: async () => ({}),
      },
      repos: {
        getBranchProtection: async ({ branch }) => {
          assert.equal(branch, "alpha/v1/v1.0");
          return {
            data: protectedChannel(),
          };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
          assert.equal(commit_sha, SHA);
          return {
            data: [
              {
                merged_at: "2026-06-29T00:00:00Z",
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

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd: makeTempWorkspace({}),
    versionState: false,
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(calls.slice(0, 2), [
    ["getRef", "heads/alpha/v1/v1.0"],
    ["getRef", "tags/v1.0.0-alpha.0"],
  ]);
});

test("strict alpha promotion uses provider transaction evidence when protection details are unreadable", async () => {
  let reviewState = "APPROVED";
  let protectionReadStatus = 403;
  let observedHeadSha = SHA;
  const pullRequestHeadSha = "b".repeat(40);
  const checkedRefs = [];
  const octokit = {
    rest: {
      repos: {
        getBranchProtection: async () => {
          const error = new Error(
            protectionReadStatus === 404
              ? "Not Found"
              : "Resource not accessible by integration",
          );
          error.status = protectionReadStatus;
          throw error;
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              number: 42,
              merged_at: "2026-06-29T00:00:00Z",
              user: { login: "author" },
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "dev/v1/v1.0",
                sha: pullRequestHeadSha,
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
        getBranch: async ({ branch }) => {
          assert.equal(branch, "alpha/v1/v1.0");
          return {
            data: {
              protected: true,
              commit: { sha: observedHeadSha },
              protection: {
                required_status_checks: {
                  enforcement_level: "everyone",
                  contexts: ["check"],
                  checks: [{ context: "check", app_id: 15368 }],
                },
              },
            },
          };
        },
      },
      pulls: {
        listReviews: async ({ pull_number }) => {
          assert.equal(pull_number, 42);
          return {
            data: [{ state: reviewState, user: { login: "reviewer" } }],
          };
        },
      },
      checks: {
        listForRef: async ({ ref }) => {
          checkedRefs.push(ref);
          assert.equal(ref, pullRequestHeadSha);
          return {
            data: {
              check_runs: [{ name: "check", conclusion: "success", app: { id: 15368 } }],
            },
          };
        },
      },
    },
  };

  for (const status of [403, 404]) {
    protectionReadStatus = status;
    const resolvedStatusCheck = await assertProtectedChannel({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sourceSha: SHA,
      targetRef: "alpha/v1/v1.0",
      requiredStatusCheck: "check",
    });
    assert.equal(resolvedStatusCheck, "check");
  }
  assert.deepEqual(checkedRefs, [pullRequestHeadSha, pullRequestHeadSha]);

  observedHeadSha = OTHER_SHA;
  const recoveredStatusCheck = await assertProtectedChannel({ octokit, owner: "kungfu-systems", repo: "buildchain", sourceSha: SHA, expectedChannelSha: OTHER_SHA, targetRef: "alpha/v1/v1.0", requiredStatusCheck: "check" });
  assert.equal(recoveredStatusCheck, "check");
  await assert.rejects(assertProtectedChannel({ octokit, owner: "kungfu-systems", repo: "buildchain", sourceSha: SHA, targetRef: "alpha/v1/v1.0", requiredStatusCheck: "check" }), /must still point at the exact admitted channel head/);

  reviewState = "CHANGES_REQUESTED";
  await assert.rejects(
    assertProtectedChannel({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sourceSha: SHA,
      targetRef: "alpha/v1/v1.0",
      requiredStatusCheck: "check",
    }),
    /must have an independent approving review/,
  );
});

test("managed channels reuse provider-enforced policy when protection details are unreadable", async () => {
  let requiredContexts = ["check"];
  let protectionReadStatus = 403;
  const octokit = {
    rest: {
      repos: {
        getBranchProtection: async () => {
          const error = new Error(
            protectionReadStatus === 404
              ? "Not Found"
              : "Resource not accessible by integration",
          );
          error.status = protectionReadStatus;
          throw error;
        },
        getBranch: async () => ({
          data: {
            protected: true,
            protection: {
              required_status_checks: {
                enforcement_level: "everyone",
                contexts: requiredContexts,
                checks: requiredContexts.map((context) => ({
                  context,
                  app_id: 15368,
                })),
              },
            },
          },
        }),
        updateBranchProtection: async () => {
          assert.fail("provider-enforced existing policy must not be rewritten");
        },
      },
    },
  };

  const evidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "alpha/v1/v1.0",
    requiredStatusCheck: "check",
  });
  assert.equal(evidence.action, "branch-protection-policy-observed");
  assert.equal(evidence.policySource, "provider-enforced-existing-policy");
  assert.deepEqual(evidence.after.requiredStatusChecks, ["check"]);

  protectionReadStatus = 404;
  const hiddenEvidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "alpha/v1/v1.0",
    requiredStatusCheck: "check",
  });
  assert.equal(hiddenEvidence.action, "branch-protection-policy-observed");
  assert.deepEqual(hiddenEvidence.after.requiredStatusChecks, ["check"]);

  requiredContexts = ["security"];
  await assert.rejects(
    ensureManagedChannelBranchProtection({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      branch: "alpha/v1/v1.0",
      requiredStatusCheck: "check",
    }),
    /must require a check status check using the exact context/,
  );
});

test("strict alpha promotion rejects protection without admin enforcement", async () => {
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
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({ enforce_admins: { enabled: false } }),
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
    /must enforce branch protection for administrators/,
  );
});

test("strict alpha promotion reports all missing protected channel settings", async () => {
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
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({
            enforce_admins: { enabled: false },
            allow_force_pushes: { enabled: true },
            allow_deletions: { enabled: true },
            required_conversation_resolution: { enabled: false },
            required_pull_request_reviews: {
              required_approving_review_count: 0,
            },
            required_status_checks: { strict: false, contexts: [] },
          }),
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
    (error) => {
      assert.match(error.message, /missing required protection settings/);
      assert.match(error.message, /must enforce branch protection for administrators/);
      assert.match(error.message, /must disallow force pushes/);
      assert.match(error.message, /must disallow branch deletion/);
      assert.match(error.message, /must require conversation resolution/);
      assert.match(error.message, /must require at least one approving review/);
      assert.match(error.message, /must require a check status check/);
      return true;
    },
  );
});

test("managed release channels keep required checks without an impossible source-up-to-date loop", async () => {
  const updates = [];
  const protection = protectedChannel({
    required_status_checks: {
      strict: true,
      checks: [
        { context: "check", app_id: 15368 },
        { context: "verify", app_id: 15368 },
      ],
    },
  });
  const octokit = {
    rest: {
      repos: {
        getBranchProtection: async () => ({ data: protection }),
        updateBranchProtection: async (request) => {
          updates.push(request);
          return { data: {} };
        },
      },
    },
  };

  const alphaEvidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "alpha/v2/v2.14",
    requiredStatusCheck: "check",
  });
  assert.equal(updates[0].required_status_checks.strict, false);
  assert.deepEqual(updates[0].required_status_checks.checks, protection.required_status_checks.checks);
  assert.equal(alphaEvidence.after.strict, false);

  protection.required_status_checks.strict = false;
  const devEvidence = await ensureManagedChannelBranchProtection({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    branch: "dev/v2/v2.14",
    requiredStatusCheck: "check",
  });
  assert.equal(updates[1].required_status_checks.strict, false);
  assert.equal(devEvidence.after.strict, false);
});

test("strict alpha promotion rejects protection bypass surfaces", async () => {
  for (const [override, pattern] of [
    [
      { allow_force_pushes: { enabled: true } },
      /must disallow force pushes/,
    ],
    [
      { allow_deletions: { enabled: true } },
      /must disallow branch deletion/,
    ],
    [
      { required_conversation_resolution: { enabled: false } },
      /must require conversation resolution/,
    ],
  ]) {
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
        },
        repos: {
          getBranchProtection: async () => ({
            data: protectedChannel(override),
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
      pattern,
    );
  }
});

test("strict alpha promotion rejects missing PR lineage", async () => {
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
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "feature/direct",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
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
    /must come from a merged same-repository PR dev\/v1\/v1\.0 -> alpha\/v1\/v1\.0/,
  );
});

test("strict alpha promotion accepts same-line version-state PR lineage", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
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
        getCommit: async ({ commit_sha }) => ({
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "state-sha" } }),
        listMatchingRefs: async ({ ref }) => {
          if (ref === "tags/v1.0.") {
            return {
              data: [{ ref: "refs/tags/v1.0.0", object: { sha: OTHER_SHA } }],
            };
          }
          return { data: [] };
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
        updateRef: async ({ ref, sha }) => {
          refs.set(ref, sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-07-07T00:00:00Z",
              base: { ref: "alpha/v1/v1.0" },
              head: {
                ref: "buildchain/version-state/alpha-v1-v1.0/123456789abc",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
        }),
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
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), SHA);
  assert.equal(refs.get("tags/v1.0-alpha"), SHA);
});

test("strict alpha promotion accepts same-line publish-gate PR lineage", async () => {
  const pullRequest = await assertChannelPromotionPr({
    octokit: {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => {
            assert.equal(commit_sha, SHA);
            return {
              data: [
                {
                  merged_at: "2026-07-08T00:00:00Z",
                  base: { ref: "alpha/v22/v22.22" },
                  head: {
                    ref: "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.15",
                    repo: { full_name: "kungfu-systems/libnode" },
                  },
                },
              ],
            };
          },
        },
      },
    },
    owner: "kungfu-systems",
    repo: "libnode",
    sha: SHA,
    targetRef: "alpha/v22/v22.22",
  });

  assert.equal(pullRequest.head.ref, "publish-gate/alpha/v22/v22.22/22.22.3-kf.3-alpha.15");
});

test("strict alpha promotion rejects publish-gate PR lineage for a different line", async () => {
  await assert.rejects(
    assertChannelPromotionPr({
      octokit: {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({
              data: [
                {
                  merged_at: "2026-07-08T00:00:00Z",
                  base: { ref: "alpha/v22/v22.22" },
                  head: {
                    ref: "publish-gate/alpha/v22/v22.23/22.23.0-alpha.0",
                    repo: { full_name: "kungfu-systems/libnode" },
                  },
                },
              ],
            }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "libnode",
      sha: SHA,
      targetRef: "alpha/v22/v22.22",
    }),
    /publish-gate\/alpha\/\.\.\. -> alpha\/v22\/v22\.22/,
  );
});

test("release channel admission accepts only an exact line-scoped recovery PR", async () => {
  const pullRequest = await assertChannelPromotionPr({
    octokit: {
      rest: {
        repos: {
          listPullRequestsAssociatedWithCommit: async () => ({
            data: [
              {
                merged_at: "2026-07-24T00:00:00Z",
                base: { ref: "release/v2/v2.14" },
                head: {
                  ref: "fix/release-line-v2-v2.14-finalization-recovery",
                  repo: { full_name: "kungfu-systems/buildchain" },
                },
              },
            ],
          }),
        },
      },
    },
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "release/v2/v2.14",
  });

  assert.equal(
    pullRequest.head.ref,
    "fix/release-line-v2-v2.14-finalization-recovery",
  );
});

test("release channel admission rejects a recovery PR for another line", async () => {
  await assert.rejects(
    assertChannelPromotionPr({
      octokit: {
        rest: {
          repos: {
            listPullRequestsAssociatedWithCommit: async () => ({
              data: [
                {
                  merged_at: "2026-07-24T00:00:00Z",
                  base: { ref: "release/v2/v2.14" },
                  head: {
                    ref: "fix/release-line-v2-v2.13-finalization-recovery",
                    repo: { full_name: "kungfu-systems/buildchain" },
                  },
                },
              ],
            }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v2/v2.14",
    }),
    /exact line-scoped release recovery PR/,
  );
});

test("strict alpha promotion no-ops settled generated version-state commits", async () => {
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.4-alpha.0", SHA],
    ["tags/v1.0-alpha", SHA],
    ["tags/v1-alpha", SHA],
  ]);
  const writes = [];
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
        createRef: async (args) => {
          writes.push(["createRef", args.ref]);
          return {};
        },
        updateRef: async (args) => {
          writes.push(["updateRef", args.ref]);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => {
          assert.fail("settled alpha version-state commits should not need PR lookup");
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
    requireGovernance: true,
  });

  assert.equal(result.sha, SHA);
  assert.deepEqual(writes, []);
  assert.deepEqual(result.updates, [
    { ref: "alpha/v1/v1.0", action: "already-promoted", sha: SHA },
    { ref: "dev/v1/v1.0", action: "already-promoted", sha: SHA },
    { tag: "v1.0.4-alpha.0", action: "existing", sha: SHA },
    { tag: "v1.0-alpha", action: "existing", sha: SHA },
    { tag: "v1-alpha", action: "existing", sha: SHA },
  ]);
});

test("settled anchored alpha dry-run preserves the exact publication identity", async () => {
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/kfd",
      version: "1.0.0-alpha.41",
    },
    "release.json": {
      version: "1.0.0-alpha.41",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", SHA],
    ["heads/buildchain/release-state/1-0-0-alpha-41", OTHER_SHA],
    ["tags/v1.0.0-alpha.41", SHA],
    ["tags/v1.0-alpha", SHA],
    ["tags/v1-alpha", SHA],
  ]);
  const { octokit } = createGitMock({ refs });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "kfd",
    allowRepository: "kungfu-systems/kfd",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    dryRun: true,
    publishTransaction: true,
  });

  assert.deepEqual(
    result.updates.find((update) => update.action === "dry-run-publish-transaction"),
    {
      action: "dry-run-publish-transaction",
      version: "1.0.0-alpha.41",
      tag: "v1.0.0-alpha.41",
      publicTag: "v1.0.0-alpha.41",
      sha: SHA,
    },
  );
});

test("settled anchored alpha rerun restores its complete transaction without republishing", async () => {
  const version = "1.0.0-alpha.41";
  const exactTag = `v${version}`;
  const cwd = makeTempWorkspace({
    "buildchain.toml": `
schema = 1

[version]
required = true
strategy = "anchored"
next = "manual"
manifest = "release.json"

[[version.files]]
type = "json"
path = "package.json"
key = "version"

[publish]
mode = "publish-final-version"
auth = "trusted-publishing"
dist_tag = "alpha"

[lifecycle.publish]
command = "node scripts/publish.mjs"
`,
    "package.json": {
      name: "@kungfu-tech/kfd",
      version,
    },
    "release.json": { version },
    "scripts/publish.mjs": `
import fs from "node:fs";
fs.writeFileSync("publish-must-not-run", "unexpected\n");
`,
  });
  const evidencePath = path.join(
    cwd,
    ".buildchain",
    "release-evidence",
    exactTag,
    "evidence.json",
  );
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify({
    schema: 1,
    version,
    channel: "alpha",
    source_sha: SHA,
    release_sha: SHA,
    target_ref: "alpha/v1/v1.0",
    release_material_sha: SHA,
    publish_tooling_sha: SHA,
    artifacts: [{
      kind: "npm",
      name: "@kungfu-tech/kfd",
      ref: version,
      digest: "sha512:kfd-alpha-41",
    }],
  }, null, 2) + "\n");
  const { octokit, refs } = createGitMock({
    refs: new Map([
      ["heads/alpha/v1/v1.0", SHA],
      ["heads/dev/v1/v1.0", SHA],
      ["tags/v1.0.0-alpha.41", SHA],
      ["tags/v1.0-alpha", SHA],
      ["tags/v1-alpha", SHA],
    ]),
  });
  await persistDurableReleaseTransaction({
    octokit,
    owner: "kungfu-systems",
    repo: "kfd",
    cwd,
    transaction: {
      schema: 1,
      id: "kfd-alpha-41",
      repository: "kungfu-systems/kfd",
      target_ref: "alpha/v1/v1.0",
      source_sha: SHA,
      release_sha: SHA,
      release_material_sha: SHA,
      publish_tooling_sha: SHA,
      version,
      exact_tag: exactTag,
      channel: "alpha",
      line: "v1.0",
      version_strategy: "anchored",
      lifecycle_identity: "lifecycle.publish",
      state_ref: "buildchain/release-state/1-0-0-alpha-41",
      state_path: "",
      evidence_path: "",
      state: "complete",
      previous_state: "finalizing",
      actor: "codex",
      run_id: "1",
      superseded_by: "",
      failure: "",
      artifacts: [{
        kind: "npm",
        name: "@kungfu-tech/kfd",
        ref: version,
        digest: "sha512:kfd-alpha-41",
      }],
      evidence: [],
      created_at: "2026-07-22T00:00:00.000Z",
      updated_at: "2026-07-22T00:00:00.000Z",
    },
    evidencePath,
  });
  fs.rmSync(path.join(cwd, ".buildchain", "release-state"), { recursive: true, force: true });
  fs.rmSync(path.join(cwd, ".buildchain", "release-evidence"), { recursive: true, force: true });

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "kfd",
    allowRepository: "kungfu-systems/kfd",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    publishTransaction: true,
    publishRequiredArtifactsJson: JSON.stringify([{
      kind: "npm",
      name: "@kungfu-tech/kfd",
      ref: version,
      digest: "sha512:kfd-alpha-41",
    }]),
  });

  assert.equal(result.publishTransaction.state, "complete");
  assert.equal(result.publishTransaction.exactTag, exactTag);
  assert.equal(result.publishTransaction.releaseSha, SHA);
  assert.equal(fs.existsSync(path.join(cwd, "publish-must-not-run")), false);
  assert.equal(fs.existsSync(path.join(cwd, result.publishTransaction.evidencePath)), true);
  assert.equal(refs.get("tags/v1.0.0-alpha.41"), SHA);
});

test("strict alpha promotion opens a protected version-state PR when direct sync is rejected", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "c".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  let createdPullRequest;
  const pullRequestOctokit = {
    rest: {
      pulls: {
        list: async () => ({ data: [] }),
        create: async ({ head, base, title }) => {
          createdPullRequest = {
            html_url: "https://github.com/kungfu-systems/buildchain/pull/alpha-version-state",
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
    },
  };
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
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            const error = new Error(
              "At least 1 approving review is required by reviewers with write access.",
            );
            error.status = 422;
            throw error;
          }
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
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

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
    pullRequestOctokit,
  });

  const versionStateBranch = versionStateBranchName("alpha/v1/v1.0", versionSha);
  assert.equal(refs.get(`heads/${versionStateBranch}`), versionSha);
  assert.equal(createdPullRequest.base, "alpha/v1/v1.0");
  assert.equal(createdPullRequest.head, versionStateBranch);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
  assert.equal(refs.has("tags/v1.0.1-alpha.0"), false);
});

test("strict alpha promotion returns a pending dev version-state PR after alpha finalization", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
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
          data: { tree: { sha: `tree-${commit_sha}` } },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "e".repeat(40) } }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/dev/v1/v1.0") {
            const error = new Error("Changes must be made through a pull request.");
            error.status = 422;
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
            html_url: "https://github.com/kungfu-systems/buildchain/pull/dev-version-state",
            head,
            base,
            title,
          };
          return { data: createdPullRequest };
        },
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
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

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  const versionStateBranch = versionStateBranchName("dev/v1/v1.0", SHA);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
  assert.equal(refs.get(`heads/${versionStateBranch}`), SHA);
  assert.equal(createdPullRequest.base, "dev/v1/v1.0");
  assert.equal(createdPullRequest.head, versionStateBranch);
  assert.equal(result.pendingPullRequest, createdPullRequest.html_url);
  assert.equal(refs.has("tags/v1.0.1-alpha.0"), false);
});

test("strict alpha promotion uses generated ref update token for protected version-state sync", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "d".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const bypassWrites = [];
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
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref, sha }) => {
          if (ref.startsWith("heads/")) {
            const error = new Error(
              "At least 1 approving review is required by reviewers with write access.",
            );
            error.status = 422;
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
      checks: {
        create: async () => ({ data: { id: 1 } }),
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "release-bot" } }),
      },
      apps: {
        getAuthenticated: async () => ({
          data: { slug: "buildchain-promotion" },
        }),
      },
      repos: {
        getBranchProtection: async () => ({ data: protectedChannel() }),
        updateBranchProtection: async () => ({ data: {} }),
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
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
  const refUpdateOctokit = {
    rest: {
      git: {
        updateRef: async ({ ref, sha }) => {
          bypassWrites.push(["updateRef", ref, sha]);
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          bypassWrites.push(["createRef", ref, sha]);
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
    },
  };

  await promoteBuildchainRefs({
    octokit,
    refUpdateOctokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.deepEqual(
    bypassWrites.filter((write) => write[1].startsWith("heads/")),
    [
      ["updateRef", "heads/dev/v1/v1.0", SHA],
    ],
  );
  assert.equal(refs.get("heads/alpha/v1/v1.0"), SHA);
  assert.equal(refs.get("heads/dev/v1/v1.0"), SHA);
});

test("strict alpha promotion protects created dev branches with one required approval", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.0-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const versionSha = "d".repeat(40);
  const refs = new Map([
    ["heads/alpha/v1/v1.0", SHA],
    ["heads/dev/v1/v1.0", OTHER_SHA],
    ["tags/v1.0.0", OTHER_SHA],
  ]);
  const protections = [];
  const checkRuns = [];
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
        createCommit: async () => ({ data: { sha: versionSha } }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/alpha/v1/v1.0") {
            for (const name of ["Build", "security"]) {
              assert.ok(
                checkRuns.find((check) => check.head_sha === sha && check.name === name),
                `generated alpha version-state check ${name} should be created before ref PATCH`,
              );
            }
          }
          if (ref === "heads/dev/v1/v1.0") {
            assert.ok(
              protections.find((protection) => protection.branch === "dev/v1/v1.0"),
              "managed dev branch protection should be updated before ref PATCH",
            );
            for (const name of ["Build", "security"]) {
              assert.ok(
                checkRuns.find((check) => check.head_sha === sha && check.name === name),
                `generated dev version-state check ${name} should be created before ref PATCH`,
              );
            }
          }
          refs.set(ref, sha);
          return {};
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//, ""), sha);
          return {};
        },
      },
      checks: {
        create: async (request) => {
          checkRuns.push(request);
          return { data: { id: checkRuns.length } };
        },
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel({
            required_status_checks: { strict: true, contexts: ["Build", "security"] },
          }),
        }),
        updateBranchProtection: async (request) => {
          protections.push(request);
          return { data: {} };
        },
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
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

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: SHA,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
    requiredStatusCheck: "Build",
    branchProtectionBypassApps: "github-actions",
  });

  const devProtection = protections.find(
    (protection) => protection.branch === "dev/v1/v1.0",
  );
  assert.ok(devProtection);
  assert.deepEqual(devProtection.required_status_checks, {
    strict: true,
    checks: [{ context: "Build", app_id: 15368 }, { context: "security", app_id: 15368 }],
  });
  assert.deepEqual(devProtection.required_pull_request_reviews, {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 1,
    require_last_push_approval: true,
    bypass_pull_request_allowances: {
      apps: ["github-actions"],
      users: [],
      teams: [],
    },
  });
  assert.equal(devProtection.enforce_admins, true);
  assert.equal(devProtection.allow_force_pushes, false);
  assert.equal(devProtection.allow_deletions, false);
  assert.equal(devProtection.required_conversation_resolution, true);
  const policyEvidence = result.updates.find((update) => update.action === "branch-protection-policy" && update.ref === "dev/v1/v1.0");
  assert.deepEqual(policyEvidence.before.requiredStatusChecks, ["Build", "security"]);
  assert.deepEqual(policyEvidence.after.requiredStatusChecks, ["Build", "security"]);
  assert.equal(policyEvidence.policySource, "release-governance-required-status-check");
  assert.equal(checkRuns.length, 2);
  assert.deepEqual(
    checkRuns.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
    [
      {
        name: "Build",
        status: "completed",
        conclusion: "success",
      },
      {
        name: "security",
        status: "completed",
        conclusion: "success",
      },
    ],
  );
});

test("managed channel protection rejects actors outside the exact GitHub Actions App", async () => {
  await assert.rejects(
    () => ensureManagedChannelBranchProtection({
      octokit: {
        rest: {
          repos: {
            getBranchProtection: async () => ({ data: protectedChannel() }),
            updateBranchProtection: async () => ({ data: {} }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "buildchain",
      branch: "dev/v2/v2.14",
      branchProtectionBypassUsers: "release-owner",
    }),
    /permits only the descriptor-bound github-actions App bypass actor/,
  );
  await assert.rejects(
    () => ensureManagedChannelBranchProtection({
      octokit: {
        rest: {
          repos: {
            getBranchProtection: async () => ({ data: protectedChannel() }),
            updateBranchProtection: async () => ({ data: {} }),
          },
        },
      },
      owner: "kungfu-systems",
      repo: "buildchain",
      branch: "dev/v2/v2.14",
      branchProtectionBypassApps: "buildchain-promotion",
    }),
    /permits only the descriptor-bound github-actions App bypass actor/,
  );
});

test("strict alpha promotion accepts reviewed version-state PRs from a legal parent", async () => {
  const versionSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.1-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", versionSha],
    ["heads/dev/v1/v1.0", SHA],
    ["tags/v1.0.0", OTHER_SHA],
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
            tree: { sha: `tree-${commit_sha}` },
            parents: commit_sha === versionSha ? [{ sha: SHA }] : [],
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
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === SHA
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "dev/v1/v1.0",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ]
              : [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/cccccccccccc",
                      repo: { full_name: "kungfu-systems/buildchain" },
                    },
                  },
                ],
        }),
      },
    },
  };

  const result = await promoteBuildchainRefs({
    octokit,
    owner: "kungfu-systems",
    repo: "buildchain",
    sha: versionSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, versionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), versionSha);
  assert.equal(refs.get("tags/v1.0.1-alpha.0"), versionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), versionSha);
});

test("strict alpha promotion accepts merged generated version-state PR commits", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", oldAlphaSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
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
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
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
        getBranchProtection: async () => ({ data: protectedChannel() }),
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
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
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
});

test("strict alpha promotion can advance from a generated version-state merge commit", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const nextVersionSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", oldAlphaSha],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
    ["tags/v1.0.6-alpha.0", oldAlphaSha],
    ["heads/buildchain/release-state/1-0-6-alpha-0", "e".repeat(40)],
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
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: nextVersionSha } }),
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
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
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
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, nextVersionSha);
  assert.equal(refs.get("heads/alpha/v1/v1.0"), nextVersionSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), nextVersionSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.1"), nextVersionSha);
  assert.equal(refs.get("tags/v1.0-alpha"), nextVersionSha);
});

test("strict alpha promotion finalizes tags when dev already advanced", async () => {
  const oldAlphaSha = "a".repeat(40);
  const versionHeadSha = "b".repeat(40);
  const mergeSha = "c".repeat(40);
  const advancedDevSha = "d".repeat(40);
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.6-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const refs = new Map([
    ["heads/alpha/v1/v1.0", mergeSha],
    ["heads/dev/v1/v1.0", advancedDevSha],
    ["heads/buildchain/release-state/1-0-6-alpha-0", "e".repeat(40)],
    ["tags/v1.0.5", OTHER_SHA],
    ["tags/v1.0.5-alpha.1", oldAlphaSha],
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
            tree: { sha: `tree-${commit_sha}` },
            parents:
              commit_sha === mergeSha
                ? [{ sha: oldAlphaSha }, { sha: versionHeadSha }]
                : [],
          },
        }),
        updateRef: async ({ ref, sha }) => {
          if (ref === "heads/dev/v1/v1.0") {
            throw Object.assign(new Error("Update is not a fast forward"), {
              status: 422,
              response: { data: { message: "Update is not a fast forward" } },
            });
          }
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
        compareCommitsWithBasehead: async () => ({
          data: { files: [{ filename: "package.json" }] },
        }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data:
            commit_sha === mergeSha
              ? [
                  {
                    merged_at: "2026-06-29T00:00:00Z",
                    base: { ref: "alpha/v1/v1.0" },
                    head: {
                      ref: "buildchain/version-state/alpha-v1-v1.0/bbbbbbbbbbbb",
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
    sha: mergeSha,
    targetRef: "alpha/v1/v1.0",
    cwd,
    requireGovernance: true,
    requireVersionState: true,
  });

  assert.equal(result.sha, mergeSha);
  assert.equal(refs.get("heads/dev/v1/v1.0"), advancedDevSha);
  assert.equal(refs.get("tags/v1.0.6-alpha.0"), mergeSha);
  assert.equal(refs.get("tags/v1.0-alpha"), mergeSha);
  assert.deepEqual(
    result.updates.find(
      (update) =>
        update.ref === "dev/v1/v1.0" &&
        update.action === "skipped-non-fast-forward",
    ),
    {
      ref: "dev/v1/v1.0",
      action: "skipped-non-fast-forward",
      sha: mergeSha,
      currentSha: advancedDevSha,
    },
  );
});

test("strict release promotion requires a matching alpha tree and alpha-to-release PR", async () => {
  const cwd = makeTempWorkspace({
    "package.json": {
      name: "@kungfu-tech/buildchain",
      version: "1.0.2-alpha.0",
      packageManager: "pnpm@11.7.0",
    },
  });
  const alphaSha = "c".repeat(40);
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
              sha: commit_sha === OTHER_SHA ? "old-release-tree" : "alpha-tree",
            },
            parents: [],
          },
        }),
        createBlob: async () => ({ data: { sha: "blob-sha" } }),
        createTree: async () => ({ data: { sha: "tree-sha" } }),
        createCommit: async () => ({ data: { sha: "d".repeat(40) } }),
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
        listPullRequestsAssociatedWithCommit: async () => ({
          data: [
            {
              merged_at: "2026-06-29T00:00:00Z",
              base: { ref: "release/v1/v1.0" },
              head: {
                ref: "alpha/v1/v1.0",
                repo: { full_name: "kungfu-systems/buildchain" },
              },
            },
          ],
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

  assert.equal(result.sha, "d".repeat(40));
  assert.equal(refs.get("tags/v1.0.2"), "d".repeat(40));
});

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

test("strict release promotion rejects code changes after alpha", async () => {
  const alphaSha = "c".repeat(40);
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
            tree: { sha: commit_sha === SHA ? "release-tree" : "alpha-tree" },
            parents: [],
          },
        }),
      },
      repos: {
        getBranchProtection: async () => ({
          data: protectedChannel(),
        }),
        listPullRequestsAssociatedWithCommit: async () => ({ data: [] }),
      },
    },
  };

  await assert.rejects(
    promoteBuildchainRefs({
      octokit,
      owner: "kungfu-systems",
      repo: "buildchain",
      sha: SHA,
      targetRef: "release/v1/v1.0",
      versionState: false,
      requireGovernance: true,
    }),
    /must have the same tree as v1\.0\.2-alpha\.0/,
  );
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
  assert.equal(
    isAllowedReleaseLineRecoveryPath("package.json", ["package.json"]),
    true,
  );
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

test("strict promotion rejects repositories without version state", async () => {
  const cwd = makeTempWorkspace({ "README.md": "no package state\n" });
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
      cwd,
      requireVersionState: true,
    }),
    /requires package version state/,
  );
});

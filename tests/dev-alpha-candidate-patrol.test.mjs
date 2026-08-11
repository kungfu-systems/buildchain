// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  channelCandidateSourceLockRef,
  decideChannelCandidate,
} from "../packages/core/channel-candidate.js";
import {
  createGitHubChannelCandidateClient,
  managedCandidateFromPullRequest,
  normalizeDevAlphaPatrolOptions,
  parseCandidateStateMarker,
  reconcileActiveReleaseTrain,
  runDevAlphaCandidatePatrol,
  selectLatestQualifiedSource,
} from "../scripts/dev-alpha-candidate-patrol.mjs";
import {
  createReleaseTrain,
  transitionReleaseTrain,
} from "../packages/core/release-train.js";
import { readGitHubNextDevelopmentVersionReservation } from "../packages/core/next-development-candidate-reservation.js";

const SOURCE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const OBSERVED_SHA = "c".repeat(40);
const ACTIVE_SHA = "d".repeat(40);
const CANDIDATE_TREE_SHA = "e".repeat(40);
const RUNTIME_SHA = "f".repeat(40);
const NOW = "2026-07-26T22:00:00.000Z";
const DEV = ".github/workflows/dev-verify-patrol.yml";
const ALPHA = ".github/workflows/alpha-promotion-preflight.yml";

function workflow(workflowPath, overrides = {}) {
  return {
    workflowPath,
    workflowName:
      workflowPath === DEV ? "Dev Verify Patrol" : "Alpha promotion preflight",
    runId: workflowPath === DEV ? 101 : 202,
    runAttempt: 1,
    headSha: SOURCE_SHA,
    status: "completed",
    conclusion: "success",
    completedAt: "2026-07-26T21:30:00.000Z",
    url: `https://github.com/kungfu-systems/kungfu/actions/runs/${workflowPath === DEV ? 101 : 202}`,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    repository: "kungfu-systems/kungfu",
    sourceBranch: "dev/v4/v4.0",
    targetBranch: "alpha/v4/v4.0",
    sourceSha: SOURCE_SHA,
    targetSha: TARGET_SHA,
    comparison: { status: "ahead", aheadBy: 12 },
    workflowEvidence: [workflow(DEV), workflow(ALPHA)],
    requiredWorkflowPaths: [DEV, ALPHA],
    now: NOW,
    maxAgeSeconds: 86400,
    ...overrides,
  };
}

test("exact same-SHA Dev and Alpha evidence selects one immutable candidate", () => {
  const decision = decideChannelCandidate(input());
  assert.equal(decision.eligible, true);
  assert.equal(decision.reason, "same-source-qualified");
  assert.equal(
    decision.sourceLockRef,
    "buildchain/candidate/alpha-v4-v4.0/aaaaaaaaaaaa",
  );
  assert.match(decision.decisionRoot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    decision.workflowEvidence.map((row) => row.headSha),
    [SOURCE_SHA, SOURCE_SHA],
  );
});

test("source lock naming is deterministic and source bound", () => {
  assert.equal(
    channelCandidateSourceLockRef("alpha/v4/v4.0", SOURCE_SHA),
    "buildchain/candidate/alpha-v4-v4.0/aaaaaaaaaaaa",
  );
});

test("missing, failed, stale, mismatched, and duplicate evidence fail closed", () => {
  assert.throws(
    () => decideChannelCandidate(input({ workflowEvidence: [workflow(DEV)] })),
    /expected exactly 2/u,
  );
  assert.throws(
    () =>
      decideChannelCandidate(
        input({
          workflowEvidence: [
            workflow(DEV, { conclusion: "failure" }),
            workflow(ALPHA),
          ],
        }),
      ),
    /not a completed successful run/u,
  );
  assert.throws(
    () =>
      decideChannelCandidate(
        input({
          workflowEvidence: [
            workflow(DEV, { completedAt: "2026-07-20T00:00:00.000Z" }),
            workflow(ALPHA),
          ],
        }),
      ),
    /stale/u,
  );
  assert.throws(
    () =>
      decideChannelCandidate(
        input({
          workflowEvidence: [
            workflow(DEV, { headSha: "c".repeat(40) }),
            workflow(ALPHA),
          ],
        }),
      ),
    /does not bind source SHA/u,
  );
  assert.throws(
    () =>
      decideChannelCandidate(
        input({ workflowEvidence: [workflow(DEV), workflow(DEV)] }),
      ),
    /duplicate workflow evidence/u,
  );
});

test("an already-current target is observable but not eligible", () => {
  const decision = decideChannelCandidate(
    input({
      comparison: { status: "identical", aheadBy: 0 },
      workflowEvidence: [],
    }),
  );
  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "target-already-current");
  assert.equal(decision.sourceLockRef, undefined);
});

test("patrol exits cleanly without workflow evidence when target is already current", async () => {
  let listedRuns = false;
  const fake = {
    resolveBranch: async () => SOURCE_SHA,
    compare: async () => ({ status: "identical", ahead_by: 0 }),
    listCompletedWorkflowRuns: async () => {
      listedRuns = true;
      throw new Error(
        "workflow evidence must not be queried for an identical target",
      );
    },
    listBranchHistory: async () => {
      listedRuns = true;
      throw new Error(
        "source history must not be queried for an identical target",
      );
    },
    listOpenPullRequests: async () => [],
  };
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, false);
  assert.equal(result.decision.reason, "target-already-current");
  assert.equal(listedRuns, false);
});

function apiRun(workflowPath, overrides = {}) {
  return {
    path: workflowPath,
    name:
      workflowPath === DEV ? "Dev Verify Patrol" : "Alpha promotion preflight",
    id: workflowPath === DEV ? 101 : 202,
    run_attempt: 1,
    head_sha: SOURCE_SHA,
    status: "completed",
    conclusion: "success",
    updated_at:
      workflowPath === DEV
        ? "2026-07-26T21:30:00.000Z"
        : "2026-07-26T21:40:00.000Z",
    html_url: `https://example.invalid/${workflowPath === DEV ? "dev/101" : "alpha/202"}`,
    ...overrides,
  };
}

function client({
  sourceHead = SOURCE_SHA,
  sourceHistory = [SOURCE_SHA],
  runs = [apiRun(DEV), apiRun(ALPHA)],
  comparison = { status: "ahead", ahead_by: 4 },
  comparisons,
  promotionBaseline,
  openPullRequests = [],
  candidateTreeSha = CANDIDATE_TREE_SHA,
  sourceLockSha,
  versionReservation,
} = {}) {
  const calls = [];
  return {
    calls,
    resolveBranch: async (branch) => {
      if (branch.startsWith("dev/")) return sourceHead;
      if (branch.startsWith("buildchain/candidate/"))
        return sourceLockSha || openPullRequests[0]?.head?.sha || ACTIVE_SHA;
      return TARGET_SHA;
    },
    resolveCommitTreeSha: async () => candidateTreeSha,
    compare: async (baseSha, headSha) =>
      comparisons?.get(`${baseSha}...${headSha}`) || comparison,
    resolveManagedPromotionBaseline: async () => promotionBaseline || null,
    listBranchHistory: async () => sourceHistory,
    readNextDevelopmentVersionReservation: async (request) => ({
      reservationSha: request.reservationSha,
      candidateSha: request.candidateSha,
      targetVersion: request.targetVersion,
      paths: ["package.json"],
      evidenceRoot: ROOT("8"),
      status: "current",
      ...versionReservation,
    }),
    listCompletedWorkflowRuns: async (workflowPath) =>
      runs.filter((run) => run.path === workflowPath),
    listOpenPullRequests: async () => openPullRequests,
    ensureImmutableBranch: async (ref, sha) => calls.push(["branch", ref, sha]),
    ensurePullRequest: async (request) => {
      calls.push(["pr", request]);
      return {
        number: 9,
        node_id: "PR_candidate_9",
        html_url: "https://example.invalid/pull/9",
      };
    },
    enableAutoMerge: async (pullRequest, mergeMethod) =>
      calls.push(["auto-merge", pullRequest.number, mergeMethod]),
    updatePullRequestBody: async (number, body) =>
      calls.push(["update-pr", number, body]),
  };
}

test("pure next-development preparation is ignored by Candidate Patrol", async () => {
  const preparationSha = "9".repeat(40);
  const integrationSha = "7".repeat(40);
  const fake = client({
    sourceHead: integrationSha,
    sourceHistory: [
      {
        sha: integrationSha,
        message: "Merge pull request #91 from buildchain/version-state",
        parents: [TARGET_SHA, preparationSha],
      },
      {
        sha: preparationSha,
        message: "chore(release): prepare v3.0.9-alpha.2\n\nSigned-off-by: buildchain-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
      },
    ],
    runs: [
      apiRun(DEV, { head_sha: integrationSha }),
      apiRun(ALPHA, { head_sha: integrationSha }),
    ],
  });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, false);
  assert.match(result.decision.blockReason, /no source commit/u);
  assert.deepEqual(fake.calls, []);
});

test("GitHub reservation readback roots exact prepared and candidate blobs", async () => {
  const preparationSha = "9".repeat(40);
  const api = async (endpoint) => {
    if (endpoint.includes(`/commits/${preparationSha}`)) {
      return {
        sha: preparationSha,
        commit: { message: "chore(release): prepare v3.0.9-alpha.2" },
        files: [{ filename: "package.json" }, { filename: "dist/version.json" }],
      };
    }
    if (endpoint.includes("package.json")) {
      return { type: "file", sha: "1".repeat(40) };
    }
    return { type: "file", sha: "2".repeat(40) };
  };
  const readback = await readGitHubNextDevelopmentVersionReservation({
    api,
    owner: "kungfu-systems",
    repo: "buildchain",
    reservationSha: preparationSha,
    candidateSha: SOURCE_SHA,
    targetVersion: "3.0.9-alpha.2",
  });
  assert.equal(readback.status, "current");
  assert.deepEqual(readback.paths, ["dist/version.json", "package.json"]);
  assert.match(readback.evidenceRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("Candidate Patrol rejects stale reserved version state before settlement", async () => {
  const preparationSha = "9".repeat(40);
  const fake = client({
    sourceHistory: [
      { sha: SOURCE_SHA, message: "feat(product): continue development" },
      {
        sha: preparationSha,
        message: "chore(release): prepare v3.0.9-alpha.2",
      },
    ],
    versionReservation: { status: "stale" },
  });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, false);
  assert.match(result.decision.blockReason, /reservation is stale/u);
  assert.deepEqual(fake.calls, []);
});

test("Candidate Patrol roots current reserved version state into selection", async () => {
  const preparationSha = "9".repeat(40);
  const fake = client({
    sourceHistory: [
      { sha: SOURCE_SHA, message: "feat(product): continue development" },
      {
        sha: preparationSha,
        message: "chore(release): prepare v3.0.9-alpha.2",
      },
    ],
  });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, true);
  assert.equal(
    result.decision.selection.versionReservation.reservationSha,
    preparationSha,
  );
  assert.equal(
    result.decision.selection.versionReservation.candidateSha,
    SOURCE_SHA,
  );
});

test("managed Alpha promotion merge uses its exact source as the patrol baseline", async () => {
  const promotedSourceSha = "e".repeat(40);
  const fake = client({
    promotionBaseline: {
      mode: "managed-candidate-merge-source",
      targetSha: TARGET_SHA,
      sourceSha: promotedSourceSha,
      pullRequestNumber: 2536,
      pullRequestUrl: "https://example.invalid/pull/2536",
    },
    comparisons: new Map([
      [`${TARGET_SHA}...${SOURCE_SHA}`, { status: "diverged", ahead_by: 3 }],
      [
        `${promotedSourceSha}...${SOURCE_SHA}`,
        { status: "ahead", ahead_by: 2 },
      ],
    ]),
  });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, true);
  assert.equal(
    result.decision.selection.mode,
    "latest-qualified-source-after-managed-promotion",
  );
  assert.deepEqual(result.decision.selection.targetBaseline, {
    mode: "managed-candidate-merge-source",
    targetSha: TARGET_SHA,
    sourceSha: promotedSourceSha,
    pullRequestNumber: 2536,
    pullRequestUrl: "https://example.invalid/pull/2536",
  });
});

test("unmanaged target divergence remains ineligible", async () => {
  const fake = client({
    comparison: { status: "diverged", ahead_by: 3 },
  });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, false);
  assert.equal(result.decision.reason, "source-does-not-lead-target");
});

const patrolOptions = {
  repository: "kungfu-systems/kungfu",
  sourceBranch: "dev/v4/v4.0",
  targetBranch: "alpha/v4/v4.0",
  devWorkflowPath: DEV,
  alphaWorkflowPath: ALPHA,
  now: NOW,
  maxAgeSeconds: 86400,
  requireActiveReleaseTrain: false,
};

function candidatePullRequest({
  sourceSha = ACTIVE_SHA,
  number = 17,
  body,
  autoMerge = null,
} = {}) {
  return {
    number,
    node_id: `PR_candidate_${number}`,
    auto_merge: autoMerge,
    html_url: `https://example.invalid/pull/${number}`,
    body:
      body ||
      [
        "Buildchain exact-source channel candidate.",
        "",
        `- Source SHA: \`${sourceSha}\``,
      ].join("\n"),
    head: {
      ref: `buildchain/candidate/alpha-v4-v4.0/${sourceSha.slice(0, 12)}`,
      sha: sourceSha,
    },
    base: { ref: "alpha/v4/v4.0" },
  };
}

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

function releaseTrain(overrides = {}) {
  return createReleaseTrain({
    repository: patrolOptions.repository,
    sourceBranch: patrolOptions.sourceBranch,
    targetBranch: patrolOptions.targetBranch,
    originDevSha: ACTIVE_SHA,
    candidateSha: ACTIVE_SHA,
    candidateTreeSha: CANDIDATE_TREE_SHA,
    alphaBaseSha: TARGET_SHA,
    buildchainRuntimeSha: RUNTIME_SHA,
    generation: 1,
    authorityRoots: [ROOT("1"), ROOT("2")],
    createdAt: NOW,
    ...overrides,
  });
}

function activeTrainCandidatePullRequest({
  train = releaseTrain(),
  body,
} = {}) {
  const pullRequest = candidatePullRequest({ sourceSha: ACTIVE_SHA });
  const state = {
    schema: "kungfu-buildchain-dev-alpha-candidate-state/v1",
    repository: patrolOptions.repository,
    sourceBranch: patrolOptions.sourceBranch,
    targetBranch: patrolOptions.targetBranch,
    targetSha: TARGET_SHA,
    generation: train.releaseCut.generation,
    priorStateRoot: "absent",
    activeCandidate: {
      sourceSha: ACTIVE_SHA,
      sourceLockRef: pullRequest.head.ref,
      decisionRoot: ROOT("3"),
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.html_url,
    },
    nextCandidate: null,
    tombstones: [],
    releaseTrain: train,
    observationDecisionRoot: ROOT("3"),
    observedAt: NOW,
    stateRoot: ROOT("4"),
  };
  return {
    ...pullRequest,
    body:
      body ||
      [
        "Buildchain exact-source channel candidate.",
        "",
        `- Source SHA: \`${ACTIVE_SHA}\``,
        "",
        "<!-- buildchain-dev-alpha-candidate-state",
        JSON.stringify(state),
        "-->",
      ].join("\n"),
  };
}

test("one hundred dev advances remain observations on one frozen Release Cut", () => {
  let train = releaseTrain();
  const original = structuredClone(train.releaseCut);
  for (let index = 0; index < 100; index += 1) {
    const observedDevSha = (index + 16).toString(16).padStart(40, "0");
    const result = reconcileActiveReleaseTrain({
      releaseTrain: train,
      repository: patrolOptions.repository,
      sourceBranch: patrolOptions.sourceBranch,
      targetBranch: patrolOptions.targetBranch,
      activeCandidateSha: ACTIVE_SHA,
      sourceLockSha: ACTIVE_SHA,
      candidateTreeSha: CANDIDATE_TREE_SHA,
      alphaBaseSha: TARGET_SHA,
      buildchainRuntimeSha: RUNTIME_SHA,
      observedDevSha,
      observedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
    });
    assert.equal(result.status, "active");
    assert.equal(result.train.trainRoot, train.trainRoot);
    assert.deepEqual(result.train.releaseCut, original);
    train = result.train;
  }
  assert.equal(train.observations.length, 100);
  assert.equal(train.releaseCut.candidateSha, ACTIVE_SHA);
  assert.equal(train.releaseCut.candidateTreeSha, CANDIDATE_TREE_SHA);
  assert.equal(train.releaseCut.generation, 1);
});

test("first settlement cuts and persists one exact active Release Train", async () => {
  const fake = client();
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      requireActiveReleaseTrain: true,
      buildchainRuntimeSha: RUNTIME_SHA,
      settlementAuthorized: true,
      dryRun: false,
    },
    fake,
  );
  assert.equal(result.controller.state, "active");
  assert.equal(result.releaseTrain.releaseCut.candidateSha, SOURCE_SHA);
  assert.equal(
    result.releaseTrain.releaseCut.candidateTreeSha,
    CANDIDATE_TREE_SHA,
  );
  assert.equal(result.releaseTrain.releaseCut.alphaBaseSha, TARGET_SHA);
  assert.equal(
    result.releaseTrain.releaseCut.buildchainRuntimeSha,
    RUNTIME_SHA,
  );
  const state = parseCandidateStateMarker(
    fake.calls.find(([kind]) => kind === "pr")[1].body,
  );
  assert.equal(state.releaseTrain.trainRoot, result.releaseTrain.trainRoot);
  assert.equal(state.generation, 1);
});

test("observe and settle reconstruct the same Release Cut before writes", async () => {
  const observed = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      requireActiveReleaseTrain: true,
      buildchainRuntimeSha: RUNTIME_SHA,
      dryRun: true,
    },
    client(),
  );
  const settled = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      requireActiveReleaseTrain: true,
      buildchainRuntimeSha: RUNTIME_SHA,
      expectedSelectedSha: observed.decision.source.sha,
      expectedCutRoot: observed.releaseTrain.releaseCut.cutRoot,
      cutCreatedAt: observed.releaseTrain.releaseCut.createdAt,
      settlementAuthorized: true,
      dryRun: false,
    },
    client(),
  );
  assert.equal(
    settled.releaseTrain.releaseCut.cutRoot,
    observed.releaseTrain.releaseCut.cutRoot,
  );
});

test("controller restart resumes the frozen candidate while dev moves", async () => {
  const firstClient = client({
    sourceHead: SOURCE_SHA,
    openPullRequests: [activeTrainCandidatePullRequest()],
    sourceLockSha: ACTIVE_SHA,
  });
  const first = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      requireActiveReleaseTrain: true,
      buildchainRuntimeSha: RUNTIME_SHA,
      settlementAuthorized: true,
      dryRun: false,
    },
    firstClient,
  );
  assert.equal(first.decision.source.sha, ACTIVE_SHA);
  assert.equal(first.controller.generation, 1);
  assert.equal(
    first.controller.settlementAction,
    "observe-active-release-train",
  );
  const persistedBody = firstClient.calls.find(
    ([kind]) => kind === "update-pr",
  )[2];
  const movedDevSha = "9".repeat(40);
  const restartedClient = client({
    sourceHead: movedDevSha,
    openPullRequests: [
      activeTrainCandidatePullRequest({ body: persistedBody }),
    ],
    sourceLockSha: ACTIVE_SHA,
  });
  const restarted = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      requireActiveReleaseTrain: true,
      buildchainRuntimeSha: RUNTIME_SHA,
      settlementAuthorized: true,
      dryRun: false,
      now: "2026-07-26T22:01:00.000Z",
    },
    restartedClient,
  );
  assert.equal(restarted.controller.state, "active");
  assert.equal(restarted.decision.source.sha, ACTIVE_SHA);
  assert.equal(
    restarted.releaseTrain.releaseCut.candidateTreeSha,
    CANDIDATE_TREE_SHA,
  );
  assert.equal(restarted.releaseTrain.releaseCut.generation, 1);
  assert.equal(
    restartedClient.calls.some(([kind]) => kind === "branch" || kind === "pr"),
    false,
  );
});

test("candidate, Alpha base, runtime and route drift produce rooted holds", () => {
  const base = {
    releaseTrain: releaseTrain(),
    repository: patrolOptions.repository,
    sourceBranch: patrolOptions.sourceBranch,
    targetBranch: patrolOptions.targetBranch,
    activeCandidateSha: ACTIVE_SHA,
    sourceLockSha: ACTIVE_SHA,
    candidateTreeSha: CANDIDATE_TREE_SHA,
    alphaBaseSha: TARGET_SHA,
    buildchainRuntimeSha: RUNTIME_SHA,
    observedDevSha: SOURCE_SHA,
    observedAt: NOW,
  };
  for (const [overrides, code] of [
    [{ sourceLockSha: SOURCE_SHA }, "candidate-ref-drift"],
    [{ candidateTreeSha: SOURCE_SHA }, "candidate-tree-drift"],
    [{ alphaBaseSha: SOURCE_SHA }, "alpha-base-drift"],
    [{ buildchainRuntimeSha: SOURCE_SHA }, "runtime-drift"],
    [{ repository: "kungfu-systems/other" }, "invalid-authority"],
  ]) {
    const result = reconcileActiveReleaseTrain({ ...base, ...overrides });
    assert.equal(result.status, "held");
    assert.equal(result.hold.code, code);
    assert.match(result.hold.holdRoot, /^sha256:[0-9a-f]{64}$/u);
  }
});

test("duplicate observations are idempotent and explicit supersession is terminal", () => {
  const base = {
    releaseTrain: releaseTrain(),
    repository: patrolOptions.repository,
    sourceBranch: patrolOptions.sourceBranch,
    targetBranch: patrolOptions.targetBranch,
    activeCandidateSha: ACTIVE_SHA,
    sourceLockSha: ACTIVE_SHA,
    candidateTreeSha: CANDIDATE_TREE_SHA,
    alphaBaseSha: TARGET_SHA,
    buildchainRuntimeSha: RUNTIME_SHA,
    observedDevSha: SOURCE_SHA,
    observedAt: NOW,
  };
  const first = reconcileActiveReleaseTrain(base);
  const duplicate = reconcileActiveReleaseTrain({
    ...base,
    releaseTrain: first.train,
    observedAt: "2026-07-26T22:05:00.000Z",
  });
  assert.deepEqual(duplicate.train, first.train);
  const superseded = transitionReleaseTrain(first.train, {
    to: "superseded",
    event: "candidate-invalidated",
    reason: "an explicit authority check invalidated the candidate",
    expectedStateRoot: first.train.state.stateRoot,
    authorityRoots: [ROOT("5")],
    supersessionCause: "invalid-authority",
    replacementCutRoot: ROOT("6"),
    replacementCandidateSha: SOURCE_SHA,
    recordedAt: "2026-07-26T22:06:00.000Z",
  });
  assert.equal(
    reconcileActiveReleaseTrain({ ...base, releaseTrain: superseded }).status,
    "superseded",
  );
});

test("dry-run emits an exact decision without GitHub writes", async () => {
  const fake = client();
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: true, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, true);
  assert.deepEqual(result.decision.selection, {
    mode: "latest-qualified-source-ancestor",
    observedSourceHeadSha: SOURCE_SHA,
    skippedNewerCommitCount: 0,
  });
  assert.equal(result.pullRequest, null);
  assert.deepEqual(fake.calls, []);
});

test("patrol selects the newest qualified ancestor when the observed head is still unqualified", async () => {
  const fake = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA, SOURCE_SHA],
  });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.source.sha, SOURCE_SHA);
  assert.deepEqual(result.decision.selection, {
    mode: "latest-qualified-source-ancestor",
    observedSourceHeadSha: OBSERVED_SHA,
    skippedNewerCommitCount: 1,
  });
});

test("a failed latest rerun excludes that SHA and falls back to the next qualified ancestor", () => {
  const selected = selectLatestQualifiedSource({
    sourceHistory: [OBSERVED_SHA, SOURCE_SHA],
    workflowRunsByPath: new Map([
      [
        DEV,
        [
          apiRun(DEV),
          apiRun(DEV, {
            id: 303,
            head_sha: OBSERVED_SHA,
            conclusion: "failure",
          }),
        ],
      ],
      [
        ALPHA,
        [apiRun(ALPHA), apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA })],
      ],
    ]),
    requiredWorkflowPaths: [DEV, ALPHA],
    now: NOW,
    maxAgeSeconds: 86400,
  });
  assert.equal(selected.sourceSha, SOURCE_SHA);
  assert.equal(selected.skippedNewerCommitCount, 1);
});

test("a cancelled duplicate preserves the latest completed qualification verdict", () => {
  const selected = selectLatestQualifiedSource({
    sourceHistory: [SOURCE_SHA],
    workflowRunsByPath: new Map([
      [
        DEV,
        [
          apiRun(DEV),
          apiRun(DEV, {
            id: 303,
            conclusion: "cancelled",
          }),
        ],
      ],
      [ALPHA, [apiRun(ALPHA)]],
    ]),
    requiredWorkflowPaths: [DEV, ALPHA],
    now: NOW,
    maxAgeSeconds: 86400,
  });
  assert.equal(selected.sourceSha, SOURCE_SHA);
  assert.equal(selected.skippedNewerCommitCount, 0);
  assert.equal(selected.workflowEvidence[0].runId, 101);
  assert.equal(selected.workflowEvidence[0].conclusion, "success");
});

test("patrol fails closed when no source ancestor has the complete evidence pair", async () => {
  const fake = client({ runs: [apiRun(ALPHA)] });
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: false, dryRun: true },
    fake,
  );
  assert.equal(result.decision.eligible, false);
  assert.equal(result.controller.state, "blocked");
  assert.match(
    result.decision.blockReason,
    /no source commit ahead of target has fresh completed successful same-SHA workflow evidence/u,
  );
});

test("candidate mode creates only an immutable branch and protected PR request", async () => {
  const fake = client();
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, createPullRequest: true, dryRun: false },
    fake,
  );
  assert.equal(result.pullRequest.html_url, "https://example.invalid/pull/9");
  assert.deepEqual(fake.calls[0], [
    "branch",
    result.decision.sourceLockRef,
    SOURCE_SHA,
  ]);
  assert.equal(fake.calls[1][0], "pr");
  assert.equal(fake.calls[1][1].base, "alpha/v4/v4.0");
  assert.doesNotMatch(fake.calls[1][1].body, /publish npm|create release/iu);
  assert.equal(result.controller.state, "active");
  assert.equal(result.controller.settlementAction, "create-active-candidate");
  assert.equal(
    parseCandidateStateMarker(fake.calls[1][1].body).activeCandidate.sourceSha,
    SOURCE_SHA,
  );
});

test("candidate settlement arms auto-merge only for the managed exact-source PR", async () => {
  const fake = client();
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      autoMerge: true,
      mergeMethod: "rebase",
      dryRun: false,
    },
    fake,
  );

  assert.deepEqual(fake.calls[2], ["auto-merge", 9, "rebase"]);
  assert.deepEqual(result.autoMerge, {
    requested: true,
    enabled: true,
    mergeMethod: "rebase",
  });
});

test("candidate auto-merge method is explicit and fail-closed", () => {
  assert.equal(
    normalizeDevAlphaPatrolOptions({ ...patrolOptions, mergeMethod: "REBASE" })
      .mergeMethod,
    "rebase",
  );
  assert.throws(
    () =>
      normalizeDevAlphaPatrolOptions({
        ...patrolOptions,
        mergeMethod: "fast-forward",
      }),
    /mergeMethod must be merge, squash, or rebase/u,
  );
});

test("candidate settlement preserves already-enabled auto-merge idempotently", async () => {
  const fake = client({
    openPullRequests: [
      candidatePullRequest({
        sourceSha: SOURCE_SHA,
        autoMerge: { merge_method: "rebase" },
      }),
    ],
  });
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      autoMerge: true,
      mergeMethod: "rebase",
      dryRun: false,
    },
    fake,
  );

  assert.equal(
    fake.calls.some(([operation]) => operation === "auto-merge"),
    false,
  );
  assert.equal(result.autoMerge.enabled, true);
});

test("candidate creation prepends a repository-owned governance declaration", async () => {
  const fake = client();
  const declaration = [
    "<!-- repository-release-declaration:v1",
    '{"kind":"alpha-settlement","no_progress":"qualified fixes only"}',
    "-->",
  ].join("\n");
  await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      pullRequestBodyPrefix: declaration,
      settlementAuthorized: true,
      dryRun: false,
    },
    fake,
  );
  assert.ok(fake.calls[1][1].body.startsWith(`${declaration}\n\n`));
  assert.equal(
    parseCandidateStateMarker(fake.calls[1][1].body).activeCandidate.sourceSha,
    SOURCE_SHA,
  );
});

test("candidate body prefix cannot forge the managed controller marker", async () => {
  await assert.rejects(
    runDevAlphaCandidatePatrol(
      {
        ...patrolOptions,
        pullRequestBodyPrefix:
          "<!-- buildchain-dev-alpha-candidate-state\n{}\n-->",
        dryRun: true,
      },
      client(),
    ),
    /must not contain the managed candidate state marker/u,
  );
});

test("read-only observation retains the newest qualified SHA behind one active candidate", async () => {
  const fake = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA, SOURCE_SHA],
    runs: [
      apiRun(DEV),
      apiRun(ALPHA),
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest()],
  });
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: false,
      createPullRequest: false,
      dryRun: true,
    },
    fake,
  );
  assert.equal(result.controller.state, "retained-next");
  assert.equal(result.controller.activeCandidate.sourceSha, ACTIVE_SHA);
  assert.equal(result.controller.nextCandidate.sourceSha, OBSERVED_SHA);
  assert.deepEqual(fake.calls, []);
});

test("settlement coalesces next_candidate into the active PR without creating a branch or PR", async () => {
  const fake = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA, SOURCE_SHA],
    runs: [
      apiRun(DEV),
      apiRun(ALPHA),
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest()],
  });
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      createPullRequest: true,
      dryRun: false,
    },
    fake,
  );
  assert.equal(result.controller.state, "retained-next");
  assert.equal(result.controller.settlementAction, "retain-next-candidate");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0][0], "update-pr");
  assert.equal(
    parseCandidateStateMarker(fake.calls[0][2]).nextCandidate.sourceSha,
    OBSERVED_SHA,
  );
});

test("duplicate qualification events are idempotent after next_candidate is persisted", async () => {
  const first = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest()],
  });
  await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      dryRun: false,
    },
    first,
  );
  const persistedBody = first.calls[0][2];
  const duplicate = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest({ body: persistedBody })],
  });
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      dryRun: false,
    },
    duplicate,
  );
  assert.equal(result.controller.state, "retained-next");
  assert.equal(result.controller.settlementAction, "none");
  assert.deepEqual(duplicate.calls, []);
});

test("settlement compare-and-swap rejects a stale observed controller root before writes", async () => {
  const seeded = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest()],
  });
  await runDevAlphaCandidatePatrol(
    { ...patrolOptions, settlementAuthorized: true, dryRun: false },
    seeded,
  );
  const persisted = candidatePullRequest({ body: seeded.calls[0][2] });
  const stale = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [persisted],
  });
  await assert.rejects(
    runDevAlphaCandidatePatrol(
      {
        ...patrolOptions,
        expectedPriorStateRoot: "sha256:" + "f".repeat(64),
        settlementAuthorized: true,
        dryRun: false,
      },
      stale,
    ),
    /compare-and-swap failed/u,
  );
  assert.deepEqual(stale.calls, []);
});

test("a newer qualified SHA explicitly supersedes the previously retained next candidate", async () => {
  const first = client({
    sourceHistory: [SOURCE_SHA],
    openPullRequests: [candidatePullRequest()],
  });
  await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      dryRun: false,
    },
    first,
  );
  const second = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA, SOURCE_SHA],
    runs: [
      apiRun(DEV),
      apiRun(ALPHA),
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [
      candidatePullRequest({
        body: first.calls[0][2],
      }),
    ],
  });
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      dryRun: false,
    },
    second,
  );
  assert.equal(result.controller.settlementAction, "supersede-next-candidate");
  assert.equal(result.controller.nextCandidate.sourceSha, OBSERVED_SHA);
  assert.equal(result.controller.supersededCandidate.sourceSha, SOURCE_SHA);
  assert.equal(second.calls[0][0], "update-pr");
  const persisted = parseCandidateStateMarker(second.calls[0][2]);
  assert.equal(persisted.tombstones.length, 1);
  assert.equal(persisted.tombstones[0].candidateSha, SOURCE_SHA);
  assert.equal(
    persisted.tombstones[0].reason,
    "newer-qualified-next-candidate",
  );
  assert.equal(
    persisted.tombstones[0].priorStateRoot,
    result.controller.priorStateRoot,
  );
  assert.match(persisted.tombstones[0].tombstoneRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("a rejected retained next is tombstoned and cannot reactivate without explicit authority", async () => {
  const qualified = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 303, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 404, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest()],
  });
  await runDevAlphaCandidatePatrol(
    { ...patrolOptions, settlementAuthorized: true, dryRun: false },
    qualified,
  );

  const rejected = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, {
        id: 305,
        head_sha: OBSERVED_SHA,
        conclusion: "failure",
      }),
      apiRun(ALPHA, { id: 406, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest({ body: qualified.calls[0][2] })],
  });
  const rejection = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, settlementAuthorized: true, dryRun: false },
    rejected,
  );
  assert.equal(rejection.controller.state, "rejected-next");
  const rejectedState = parseCandidateStateMarker(rejected.calls[0][2]);
  assert.equal(rejectedState.nextCandidate, null);
  assert.equal(rejectedState.tombstones[0].candidateSha, OBSERVED_SHA);
  assert.equal(
    rejectedState.tombstones[0].reason,
    "qualification-evidence-rejected",
  );

  const automatic = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 307, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 408, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest({ body: rejected.calls[0][2] })],
  });
  const blocked = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, settlementAuthorized: true, dryRun: false },
    automatic,
  );
  assert.equal(blocked.controller.state, "tombstone-blocked");
  assert.deepEqual(automatic.calls, []);

  const authorized = client({
    sourceHead: OBSERVED_SHA,
    sourceHistory: [OBSERVED_SHA],
    runs: [
      apiRun(DEV, { id: 309, head_sha: OBSERVED_SHA }),
      apiRun(ALPHA, { id: 410, head_sha: OBSERVED_SHA }),
    ],
    openPullRequests: [candidatePullRequest({ body: rejected.calls[0][2] })],
  });
  const reactivated = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      reactivationAuthorized: true,
      settlementAuthorized: true,
      dryRun: false,
    },
    authorized,
  );
  assert.equal(reactivated.controller.state, "retained-next");
  assert.equal(reactivated.controller.nextCandidate.sourceSha, OBSERVED_SHA);
  assert.equal(authorized.calls[0][0], "update-pr");
});

test("a previously known closed PR is reused as a tombstone instead of duplicated", async () => {
  const fake = client();
  fake.ensurePullRequest = async (request) => {
    fake.calls.push(["pr", request]);
    return {
      number: 33,
      html_url: "https://example.invalid/pull/33",
      state: "closed",
      merged_at: null,
      body: request.body,
      reused: true,
    };
  };
  const result = await runDevAlphaCandidatePatrol(
    { ...patrolOptions, settlementAuthorized: true, dryRun: false },
    fake,
  );
  assert.equal(result.controller.state, "tombstoned");
  assert.equal(
    result.controller.settlementAction,
    "reuse-known-candidate-tombstone",
  );
  assert.equal(
    fake.calls.filter(([kind]) => kind === "pr").length,
    1,
    "the known PR lookup must not mint another candidate identity",
  );
  const update = fake.calls.find(([kind]) => kind === "update-pr");
  const state = parseCandidateStateMarker(update[2]);
  assert.equal(state.activeCandidate, null);
  assert.equal(state.tombstones[0].candidateSha, SOURCE_SHA);
  assert.equal(state.tombstones[0].reason, "candidate-pr-closed");
});

test("foreign Alpha PRs are ignored and multiple managed candidates fail closed", async () => {
  const foreign = {
    number: 88,
    html_url: "https://example.invalid/pull/88",
    body: "Human-authored Alpha change",
    head: { ref: "feature/human-alpha-change" },
    base: { ref: "alpha/v4/v4.0" },
  };
  const allowed = client({ openPullRequests: [foreign] });
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: false,
      dryRun: true,
    },
    allowed,
  );
  assert.equal(result.controller.state, "eligible-for-settlement");
  await assert.rejects(
    runDevAlphaCandidatePatrol(
      {
        ...patrolOptions,
        settlementAuthorized: false,
        dryRun: true,
      },
      client({
        openPullRequests: [
          candidatePullRequest({ number: 17 }),
          candidatePullRequest({ number: 18, sourceSha: SOURCE_SHA }),
        ],
      }),
    ),
    /multiple open Buildchain candidate PRs/u,
  );
});

test("stale exact-SHA evidence is observable but cannot settle", async () => {
  const staleRuns = [
    apiRun(DEV, { updated_at: "2026-07-20T00:00:00.000Z" }),
    apiRun(ALPHA, { updated_at: "2026-07-20T00:00:00.000Z" }),
  ];
  const result = await runDevAlphaCandidatePatrol(
    {
      ...patrolOptions,
      settlementAuthorized: true,
      dryRun: false,
    },
    client({ runs: staleRuns }),
  );
  assert.equal(result.controller.state, "stale");
  assert.equal(result.controller.settlementAction, "none");
  assert.match(result.decision.decisionRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("settlement fails closed when the selected source changed after observation", async () => {
  const fake = client();
  await assert.rejects(
    () =>
      runDevAlphaCandidatePatrol(
        {
          ...patrolOptions,
          expectedSelectedSha: "f".repeat(40),
          settlementAuthorized: true,
          dryRun: false,
        },
        fake,
      ),
    /selected source changed between observation and settlement/u,
  );
  assert.deepEqual(fake.calls, []);
});

test("GitHub metadata reads retry bounded transient API failures", async () => {
  const statuses = [503, 200];
  const sleeps = [];
  const github = createGitHubChannelCandidateClient({
    repository: "kungfu-systems/kungfu",
    token: "not-a-real-token",
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async () => {
      const status = statuses.shift();
      return {
        status,
        ok: status === 200,
        headers: { get: () => null },
        text: async () =>
          status === 200
            ? JSON.stringify({ object: { sha: SOURCE_SHA } })
            : JSON.stringify({ message: "temporary outage" }),
      };
    },
  });
  assert.equal(await github.resolveBranch("dev/v4/v4.0"), SOURCE_SHA);
  assert.deepEqual(sleeps, [250]);
});

test("managed candidate parsing accepts the legacy PR and rejects a target mismatch", () => {
  const legacy = candidatePullRequest({ sourceSha: SOURCE_SHA });
  assert.equal(
    managedCandidateFromPullRequest(legacy, "alpha/v4/v4.0").sourceSha,
    SOURCE_SHA,
  );
  assert.equal(
    managedCandidateFromPullRequest(
      { ...legacy, base: { ref: "alpha/v5/v5.0" } },
      "alpha/v4/v4.0",
    ),
    undefined,
  );
});

test("reusable workflow retains the no-publication boundary", () => {
  const workflowText = fs.readFileSync(
    path.join(
      process.cwd(),
      ".github/workflows/dev-alpha-candidate-patrol.yml",
    ),
    "utf8",
  );
  assert.match(workflowText, /actions: read/u);
  assert.match(workflowText, /BUILDCHAIN_CHANNEL_PATROL_DRY_RUN/u);
  assert.match(
    workflowText,
    /BUILDCHAIN_CHANNEL_PATROL_REQUIRE_ACTIVE_TRAIN: "true"/u,
  );
  assert.match(workflowText, /BUILDCHAIN_CHANNEL_PATROL_RUNTIME_SHA/u);
  assert.match(workflowText, /BUILDCHAIN_CHANNEL_PATROL_EXPECTED_CUT_ROOT/u);
  assert.match(workflowText, /BUILDCHAIN_CHANNEL_PATROL_CUT_CREATED_AT/u);
  assert.match(workflowText, /BUILDCHAIN_CHANNEL_PATROL_NOW/u);
  assert.match(
    workflowText,
    /ref: \$\{\{ needs\.observe\.outputs\.runtime-sha \}\}/u,
  );
  assert.match(workflowText, /candidate-generation:/u);
  assert.match(workflowText, /candidate-tree-sha:/u);
  assert.match(workflowText, /drift-root:/u);
  assert.match(workflowText, /hold-root:/u);
  assert.match(workflowText, /BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX/u);
  assert.match(workflowText, /pull-request-body-prefix-renderer:/u);
  assert.match(
    workflowText,
    /ref: \$\{\{ steps\.observe\.outputs\.selected-sha \}\}/u,
  );
  assert.match(workflowText, /persist-credentials: false/u);
  assert.match(workflowText, /run-candidate-body-prefix-renderer\.mjs/u);
  assert.match(
    workflowText,
    /BUILDCHAIN_CHANNEL_PATROL_PR_BODY_PREFIX: \$\{\{ needs\.observe\.outputs\.pull-request-body-prefix \}\}/u,
  );
  assert.match(
    workflowText,
    /BUILDCHAIN_CHANNEL_PATROL_EXPECTED_SELECTED_SHA: \$\{\{ needs\.observe\.outputs\.selected-sha \}\}/u,
  );
  assert.match(
    workflowText,
    /BUILDCHAIN_CHANNEL_PATROL_EXPECTED_PRIOR_STATE_ROOT: \$\{\{ needs\.observe\.outputs\.prior-state-root \}\}/u,
  );
  assert.match(workflowText, /reactivation-authorized:/u);
  assert.match(workflowText, /auto-merge:/u);
  assert.match(workflowText, /merge-method:/u);
  const observeJob = workflowText.split("\n  settle:")[0];
  assert.doesNotMatch(observeJob, /secrets\.promotion-token/u);
  assert.doesNotMatch(observeJob, /BUILDCHAIN_CHANNEL_PATROL_AUTO_MERGE/u);
  const settleJob = workflowText.split("\n  settle:")[1] || "";
  assert.doesNotMatch(settleJob, /PR_BODY_PREFIX_RENDERER/u);
  assert.match(settleJob, /BUILDCHAIN_CHANNEL_PATROL_AUTO_MERGE/u);
  assert.match(settleJob, /BUILDCHAIN_CHANNEL_PATROL_MERGE_METHOD/u);
  assert.match(workflowText, /scripts\/dev-alpha-candidate-patrol\.mjs/u);
  assert.doesNotMatch(workflowText, /npm publish|gh release create|git tag/iu);
});

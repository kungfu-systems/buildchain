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
  parseCandidateStateMarker,
  runDevAlphaCandidatePatrol,
  selectLatestQualifiedSource,
} from "../scripts/dev-alpha-candidate-patrol.mjs";

const SOURCE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const OBSERVED_SHA = "c".repeat(40);
const ACTIVE_SHA = "d".repeat(40);
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
  openPullRequests = [],
} = {}) {
  const calls = [];
  return {
    calls,
    resolveBranch: async (branch) =>
      branch.startsWith("dev/") ? sourceHead : TARGET_SHA,
    compare: async () => comparison,
    listBranchHistory: async () => sourceHistory,
    listCompletedWorkflowRuns: async (workflowPath) =>
      runs.filter((run) => run.path === workflowPath),
    listOpenPullRequests: async () => openPullRequests,
    ensureImmutableBranch: async (ref, sha) => calls.push(["branch", ref, sha]),
    ensurePullRequest: async (request) => {
      calls.push(["pr", request]);
      return { number: 9, html_url: "https://example.invalid/pull/9" };
    },
    updatePullRequestBody: async (number, body) =>
      calls.push(["update-pr", number, body]),
  };
}

const patrolOptions = {
  repository: "kungfu-systems/kungfu",
  sourceBranch: "dev/v4/v4.0",
  targetBranch: "alpha/v4/v4.0",
  devWorkflowPath: DEV,
  alphaWorkflowPath: ALPHA,
  now: NOW,
  maxAgeSeconds: 86400,
};

function candidatePullRequest({
  sourceSha = ACTIVE_SHA,
  number = 17,
  body,
} = {}) {
  return {
    number,
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
    },
    base: { ref: "alpha/v4/v4.0" },
  };
}

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
  assert.doesNotMatch(
    fake.calls[1][1].body,
    /auto-merge|publish npm|create release/iu,
  );
  assert.equal(result.controller.state, "active");
  assert.equal(result.controller.settlementAction, "create-active-candidate");
  assert.equal(
    parseCandidateStateMarker(fake.calls[1][1].body).activeCandidate.sourceSha,
    SOURCE_SHA,
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
  assert.match(workflowText, /scripts\/dev-alpha-candidate-patrol\.mjs/u);
  assert.doesNotMatch(
    workflowText,
    /npm publish|gh release create|git tag|auto-merge/iu,
  );
});

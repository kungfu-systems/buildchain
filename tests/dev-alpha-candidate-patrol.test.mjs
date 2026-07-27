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
  runDevAlphaCandidatePatrol,
  selectLatestQualifiedSource,
} from "../scripts/dev-alpha-candidate-patrol.mjs";

const SOURCE_SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const OBSERVED_SHA = "c".repeat(40);
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
    ensureImmutableBranch: async (ref, sha) => calls.push(["branch", ref, sha]),
    ensurePullRequest: async (request) => {
      calls.push(["pr", request]);
      return { html_url: "https://example.invalid/pull/9" };
    },
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
  await assert.rejects(
    runDevAlphaCandidatePatrol(
      { ...patrolOptions, createPullRequest: false, dryRun: true },
      fake,
    ),
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePullRequest,
  GitHubClient,
  renderMarkdownSummary,
  runDevPrAutoMerge,
} from "../scripts/dev-pr-auto-merge.mjs";

function pr(overrides = {}) {
  return {
    number: overrides.number ?? 1,
    node_id: overrides.nodeId ?? `PR_${overrides.number ?? 1}`,
    title: overrides.title ?? "feat: ready change",
    draft: overrides.draft ?? false,
    mergeable: overrides.mergeable ?? true,
    mergeable_state: overrides.mergeable_state ?? "clean",
    labels: overrides.labels ?? [{ name: "ready" }],
    head: {
      ref: overrides.headRef ?? "feature/dev-policy",
      sha: overrides.headSha ?? `sha-${overrides.number ?? 1}`,
      repo: { full_name: overrides.headRepo ?? "kungfu-systems/buildchain" },
    },
    base: {
      ref: overrides.baseRef ?? "dev/v2/v2.6",
    },
  };
}

function client({
  pullRequests = [],
  detailedPullRequests = {},
  reviews = [{ user: { login: "reviewer" }, state: "APPROVED" }],
  checks = {
    statuses: [{ context: "check", state: "success" }],
    checkRuns: [],
  },
  branchShas = ["base-before", "base-after"],
  queueStates = [{ enabled: false, id: "", entries: [] }],
} = {}) {
  const merged = [];
  const enqueued = [];
  let branchRead = 0;
  let queueRead = 0;
  const detailReads = new Map();
  return {
    merged,
    enqueued,
    async listPullRequests() {
      return pullRequests;
    },
    async getPullRequest(number) {
      const sequence = detailedPullRequests[number];
      if (sequence) {
        const read = detailReads.get(number) || 0;
        detailReads.set(number, read + 1);
        return sequence[Math.min(read, sequence.length - 1)];
      }
      return pullRequests.find((entry) => entry.number === number) || pr({ number });
    },
    async listReviews() {
      return reviews;
    },
    async listCommitChecks() {
      return checks;
    },
    async mergePullRequest(number, { method, sha }) {
      merged.push({ number, method, sha });
      return { merged: true, sha: `merge-${number}` };
    },
    async getBranchSha() {
      const value = branchShas[Math.min(branchRead, branchShas.length - 1)];
      branchRead += 1;
      return value;
    },
    async getMergeQueueState() {
      const value = queueStates[Math.min(queueRead, queueStates.length - 1)];
      queueRead += 1;
      return value;
    },
    async enqueuePullRequest(input) {
      enqueued.push(input);
      return {
        id: "MQE_1",
        position: 0,
        state: "QUEUED",
        pullRequestNumber: 1,
        pullRequestHeadSha: input.expectedHeadOid,
      };
    },
  };
}

const baseOptions = {
  repository: "kungfu-systems/buildchain",
  targetBranch: "dev/v2/v2.6",
  dryRun: true,
  landingMode: "direct",
  maxMerges: 2,
  pollMergeableDelayMs: 0,
};

test("ready dev PR is selected in dry-run mode without merging", async () => {
  const fake = client({ pullRequests: [pr({ number: 7 })] });
  const result = await runDevPrAutoMerge(baseOptions, fake);
  assert.equal(result.evaluated.length, 1);
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].action, "would-merge");
  assert.deepEqual(fake.merged, []);
  assert.match(renderMarkdownSummary(result), /#7/);
});

test("normalized CLI options remain valid when the runner normalizes them again", async () => {
  const fake = client({ pullRequests: [pr({ number: 8 })] });
  const result = await runDevPrAutoMerge(
    {
      ...baseOptions,
      repository: {
        owner: "kungfu-systems",
        repo: "buildchain",
        fullName: "kungfu-systems/buildchain",
      },
    },
    fake,
  );
  assert.equal(result.evaluated[0].number, 8);
  assert.equal(result.evaluated[0].action, "would-merge");
});

test("policy gates reject unsafe or incomplete dev PRs", async () => {
  const options = {
    repository: "kungfu-systems/buildchain",
    targetBranch: "dev/v2/v2.6",
    readyLabel: "ready",
    blockLabels: "blocked",
    allowedHeadPrefixes: "feature/,fix/",
    requiredChecks: "check",
    requireApproval: true,
    sameRepositoryOnly: true,
    dryRun: true,
    maxMerges: 10,
    pollMergeableDelayMs: 0,
  };

  assert.equal(
    (await evaluatePullRequest(pr({ draft: true }), options, client())).reason,
    "draft",
  );
  assert.equal(
    (await evaluatePullRequest(pr({ labels: [] }), options, client())).reason,
    "missing-ready-label",
  );
  assert.equal(
    (await evaluatePullRequest(pr({ labels: [{ name: "ready" }, { name: "blocked" }] }), options, client())).reason,
    "blocked-label",
  );
  assert.equal(
    (await evaluatePullRequest(pr({ headRef: "experiment/x" }), options, client())).reason,
    "head-prefix-not-allowed",
  );
  assert.equal(
    (await evaluatePullRequest(pr({ headRepo: "someone/buildchain" }), options, client())).reason,
    "fork-or-cross-repository-head",
  );
  assert.equal(
    (
      await evaluatePullRequest(
        pr({ number: 2 }),
        options,
        client({ checks: { statuses: [{ context: "check", state: "failure" }], checkRuns: [] } }),
      )
    ).reason,
    "required-checks-not-passing",
  );
  assert.equal(
    (
      await evaluatePullRequest(
        pr({ number: 3 }),
        options,
        client({ reviews: [{ user: { login: "reviewer" }, state: "CHANGES_REQUESTED" }] }),
      )
    ).reason,
    "missing-approval",
  );
});

test("merge mode merges eligible PRs sequentially and honors max-merges", async () => {
  const fake = client({
    pullRequests: [
      pr({ number: 1, headSha: "sha-1" }),
      pr({ number: 2, headSha: "sha-2" }),
      pr({ number: 3, headSha: "sha-3" }),
    ],
  });
  const result = await runDevPrAutoMerge(
    {
      ...baseOptions,
      dryRun: false,
      maxMerges: 2,
      mergeMethod: "squash",
    },
    fake,
  );
  assert.deepEqual(fake.merged, [
    { number: 1, method: "squash", sha: "sha-1" },
    { number: 2, method: "squash", sha: "sha-2" },
  ]);
  assert.equal(result.evaluated[2].reason, "max-merges-reached");
  assert.equal(result.finalBaseSha, "base-after");
});

test("queue-enabled branches forbid direct bypass and admit only one aligned PR", async () => {
  const fake = client({
    pullRequests: [pr({ number: 2 }), pr({ number: 1 })],
    branchShas: ["base-1", "base-1", "base-1"],
    queueStates: [
      { enabled: true, id: "MQ_1", entries: [] },
      { enabled: true, id: "MQ_1", entries: [] },
    ],
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "direct", dryRun: true },
    fake,
  );

  assert.equal(result.requestedLandingMode, "direct");
  assert.equal(result.landingMode, "queue");
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].number, 1);
  assert.equal(result.actions[0].action, "would-enqueue");
  assert.equal(result.actions[0].admissionReceipt.expectedBaseSha, "base-1");
  assert.equal(result.actions[0].admissionReceipt.observedBaseSha, "base-1");
  assert.equal(result.actions[0].admissionReceipt.expectedHeadSha, "sha-1");
  assert.equal(result.evaluated[1].reason, "blocked-by-predecessor");
  assert.deepEqual(fake.enqueued, []);
});

test("queue apply binds enqueuePullRequest to the immutable PR head", async () => {
  const fake = client({
    pullRequests: [pr({ number: 1, nodeId: "PR_node_1" })],
    branchShas: ["base-1", "base-1", "base-1"],
    queueStates: [
      { enabled: true, id: "MQ_1", entries: [] },
      { enabled: true, id: "MQ_1", entries: [] },
    ],
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false },
    fake,
  );

  assert.deepEqual(fake.enqueued, [{ pullRequestId: "PR_node_1", expectedHeadOid: "sha-1" }]);
  assert.equal(result.enqueued[0].action, "enqueued");
  assert.equal(result.enqueued[0].admissionReceipt.finalSafetyBoundary, "github-merge-group");
});

test("queue admission fails closed when the target base moves", async () => {
  const fake = client({
    pullRequests: [pr({ number: 1 }), pr({ number: 2 })],
    branchShas: ["base-1", "base-2", "base-2"],
    queueStates: [
      { enabled: true, id: "MQ_1", entries: [] },
      { enabled: true, id: "MQ_1", entries: [] },
    ],
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false },
    fake,
  );

  assert.equal(result.evaluated[0].reason, "base-sha-drift");
  assert.equal(result.evaluated[0].admissionReceipt.expectedBaseSha, "base-1");
  assert.equal(result.evaluated[0].admissionReceipt.observedBaseSha, "base-2");
  assert.equal(result.evaluated[1].reason, "blocked-by-predecessor");
  assert.deepEqual(fake.enqueued, []);
});

test("queue admission fails closed when the PR head moves", async () => {
  const initial = pr({ number: 1, headSha: "sha-1" });
  const moved = pr({ number: 1, headSha: "sha-2" });
  const fake = client({
    pullRequests: [initial],
    detailedPullRequests: { 1: [initial, moved] },
    branchShas: ["base-1", "base-1", "base-1"],
    queueStates: [
      { enabled: true, id: "MQ_1", entries: [] },
      { enabled: true, id: "MQ_1", entries: [] },
    ],
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false },
    fake,
  );

  assert.equal(result.evaluated[0].reason, "head-sha-drift");
  assert.equal(result.evaluated[0].admissionReceipt.expectedHeadSha, "sha-1");
  assert.equal(result.evaluated[0].admissionReceipt.observedHeadSha, "sha-2");
  assert.deepEqual(fake.enqueued, []);
});

test("an active native queue entry blocks every open PR", async () => {
  const fake = client({
    pullRequests: [pr({ number: 2 }), pr({ number: 3 })],
    branchShas: ["base-1"],
    queueStates: [{
      enabled: true,
      id: "MQ_1",
      entries: [{
        id: "MQE_predecessor",
        state: "QUEUED",
        pullRequestNumber: 1,
        pullRequestHeadSha: "sha-1",
      }],
    }],
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "auto", dryRun: false },
    fake,
  );

  assert.deepEqual(result.evaluated.map((entry) => entry.reason), [
    "blocked-by-predecessor",
    "blocked-by-predecessor",
  ]);
  assert.equal(result.evaluated[0].admissionReceipt.predecessor.pullRequestNumber, 1);
});

test("a rejected ready predecessor blocks later PRs", async () => {
  const fake = client({
    pullRequests: [pr({ number: 1 }), pr({ number: 2 })],
    checks: { statuses: [{ context: "check", state: "failure" }], checkRuns: [] },
    branchShas: ["base-1", "base-1"],
    queueStates: [{ enabled: true, id: "MQ_1", entries: [] }],
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false },
    fake,
  );

  assert.equal(result.evaluated[0].reason, "required-checks-not-passing");
  assert.equal(result.evaluated[1].reason, "blocked-by-predecessor");
});

test("explicit queue mode rejects when the branch has no native merge queue", async () => {
  const fake = client({ pullRequests: [pr({ number: 1 })] });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false },
    fake,
  );

  assert.equal(result.evaluated[0].reason, "merge-queue-not-enabled");
  assert.deepEqual(fake.merged, []);
  assert.deepEqual(fake.enqueued, []);
});

test("GitHub client uses enqueuePullRequest with expectedHeadOid", async () => {
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      data: {
        enqueuePullRequest: {
          mergeQueueEntry: {
            id: "MQE_1",
            position: 0,
            state: "QUEUED",
            baseCommit: { oid: "base-1" },
            headCommit: { oid: "group-1" },
            pullRequest: { number: 1, headRefOid: "sha-1" },
          },
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const github = new GitHubClient({
    token: "test-token",
    repository: { owner: "kungfu-systems", repo: "buildchain" },
    fetchImpl: fakeFetch,
  });

  const entry = await github.enqueuePullRequest({
    pullRequestId: "PR_node_1",
    expectedHeadOid: "sha-1",
  });

  assert.equal(requests[0].url, "https://api.github.com/graphql");
  assert.match(requests[0].body.query, /enqueuePullRequest/);
  assert.deepEqual(requests[0].body.variables.input, {
    pullRequestId: "PR_node_1",
    expectedHeadOid: "sha-1",
  });
  assert.equal(entry.pullRequestHeadSha, "sha-1");
});

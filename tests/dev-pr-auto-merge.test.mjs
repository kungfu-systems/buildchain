import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cliOptions,
  evaluatePullRequest,
  GitHubClient,
  renderMarkdownSummary,
  runDevPrAdmission,
  runDevPrAutoMerge,
} from "../scripts/dev-pr-auto-merge.mjs";

test("targeted CLI defaults to an explicit readiness label", () => {
  const options = cliOptions([
    "--repository", "kungfu-systems/buildchain",
    "--branch", "dev/v3/v3.0",
    "--pull-request", "21",
    "--expected-head", "a".repeat(40),
  ], {});
  assert.equal(options.readyLabel, "ready");
});
test("targeted CLI preserves an explicit queue landing mode", () => {
  const options = cliOptions([
    "--repository", "kungfu-systems/buildchain",
    "--branch", "dev/v3/v3.0",
    "--pull-request", "21",
    "--expected-head", "a".repeat(40),
    "--landing-mode", "queue",
  ], {});
  assert.equal(options.landingMode, "queue");
});

function pr(overrides = {}) {
  return {
    number: overrides.number ?? 1,
    node_id: overrides.nodeId ?? `PR_${overrides.number ?? 1}`,
    title: overrides.title ?? "feat: ready change",
    state: overrides.state ?? "open",
    html_url: overrides.htmlUrl ?? `https://github.com/kungfu-systems/buildchain/pull/${overrides.number ?? 1}`,
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
    auto_merge: overrides.autoMerge ? { enabled_by: { login: "agent" } } : null,
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
  enqueueError = null,
  enqueueErrors = [],
} = {}) {
  const merged = [];
  const enqueued = [];
  const commitStatuses = [];
  const comments = [];
  let branchRead = 0;
  let queueRead = 0;
  const detailReads = new Map();
  return {
    merged,
    enqueued,
    commitStatuses,
    comments,
    async request(method, requestPath, { body } = {}) {
      commitStatuses.push({ method, requestPath, body });
      return { data: { id: commitStatuses.length } };
    },
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
      const nextError = enqueueErrors.length > 0 ? enqueueErrors.shift() : enqueueError;
      if (nextError) throw nextError;
      enqueued.push(input);
      return {
        id: "MQE_1",
        position: 0,
        state: "QUEUED",
        pullRequestNumber: 1,
        pullRequestHeadSha: input.expectedHeadOid,
      };
    },
    async addLabels(number, labels) {
      const target = pullRequests.find((entry) => entry.number === number);
      if (!target) throw new Error(`missing PR ${number}`);
      const existing = new Set((target.labels || []).map((label) => label.name || label));
      for (const label of labels) existing.add(label);
      target.labels = [...existing].map((name) => ({ name }));
      return target.labels;
    },
    async listIssueComments() {
      return comments;
    },
    async createIssueComment(number, body) {
      const comment = { id: comments.length + 1, html_url: `https://example.invalid/${number}/${comments.length + 1}`, body };
      comments.push(comment);
      return comment;
    },
    async updateIssueComment(commentId, body) {
      const comment = comments.find((entry) => entry.id === commentId);
      comment.body = body;
      return comment;
    },
    async setCommitStatus(sha, body) {
      commitStatuses.push({ method: "POST", requestPath: `statuses/${sha}`, body });
      return { id: commitStatuses.length };
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

test("queue admission accepts blocked state only after independent gates pass", async () => {
  const options = { ...baseOptions, landingMode: "queue", dryRun: true };
  const blocked = pr({ mergeable: true, mergeable_state: "blocked" });

  assert.equal(
    (await evaluatePullRequest(blocked, options, client({ pullRequests: [blocked] }))).action,
    "would-merge",
  );
  assert.equal(
    (await evaluatePullRequest(blocked, { ...options, landingMode: "direct" }, client({ pullRequests: [blocked] }))).reason,
    "not-mergeable",
  );
  const conflicted = { ...blocked, mergeable: false };
  assert.equal(
    (await evaluatePullRequest(conflicted, options, client({ pullRequests: [conflicted] }))).reason,
    "not-mergeable",
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
    { ...baseOptions, landingMode: "queue", dryRun: false, queueAdmissionContext: "Queue admission lease" },
    fake,
  );

  assert.deepEqual(fake.enqueued, [{ pullRequestId: "PR_node_1", expectedHeadOid: "sha-1" }]);
  assert.deepEqual(fake.commitStatuses, [{
    method: "POST",
    requestPath: "/repos/kungfu-systems/buildchain/statuses/sha-1",
    body: {
      state: "success",
      context: "Queue admission lease",
      description: "Buildchain admitted this exact PR head to the merge queue",
    },
  }]);
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

test("queue admission revokes the temporary lease when enqueue is rejected", async () => {
  const fake = client({
    pullRequests: [pr({ number: 1, nodeId: "PR_node_1" })],
    branchShas: ["base-1", "base-1", "base-1"],
    queueStates: [
      { enabled: true, id: "MQ_1", entries: [] },
      { enabled: true, id: "MQ_1", entries: [] },
    ],
    enqueueError: new Error("expected queue rejection"),
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false, queueAdmissionContext: "Queue admission lease" },
    fake,
  );

  assert.equal(result.evaluated[0].reason, "enqueue-rejected");
  assert.deepEqual(fake.commitStatuses.map((entry) => entry.body.state), ["success", "failure"]);
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

const exactHead = "a".repeat(40);
const movedHead = "b".repeat(40);
const targetedOptions = {
  repository: "kungfu-systems/buildchain",
  targetBranch: "dev/v2/v2.6",
  targetPullRequestNumber: 21,
  expectedHeadSha: exactHead,
  landingMode: "queue",
  queueAdmissionContext: "Queue admission lease",
  requiredChecks: "check",
  dryRun: true,
  pollMergeableDelayMs: 0,
};

const ROOT = `sha256:${"1".repeat(64)}`;

async function withWarrantResult(overrides, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-warrant-"));
  const resultPath = path.join(directory, "warrant.json");
  const warrant = {
    schema: "kungfu.buildchain.dev-delivery-warrant/v1",
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v2/v2.6",
    pullRequestNumber: 21,
    sourceHead: exactHead,
    candidateId: ROOT,
    fencingToken: ROOT,
    generation: 1,
    expectedOldStateRoot: ROOT,
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiresAt: "2099-08-04T01:00:00.000Z",
    nextAction: "Execute the protected delivery attempt.",
    ...overrides?.warrant,
  };
  const result = {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    mode: "execute",
    stateRef: "buildchain/dev-delivery-warrant/dev-v2-v2.6",
    receiptRoot: ROOT,
    after: { stateRoot: ROOT },
    warrant,
    ...overrides?.result,
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  try {
    return await callback(resultPath, result);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("targeted CLI parses qualification-only and exact Warrant inputs", () => {
  const options = cliOptions(["--repository", "kungfu-systems/buildchain", "--branch", "dev/v2/v2.6", "--pull-request", "21", "--expected-head", exactHead, "--qualification-only", "--warrant-mode", "required", "--warrant-result", "warrant.json"], {});
  assert.equal(options.qualificationOnly, true);
  assert.equal(options.warrantMode, "required");
  assert.equal(options.warrantResultPath, "warrant.json");
});

test("qualification-only proves the exact source without observing or mutating queue authority", async () => {
  const target = pr({ number: 21, headSha: exactHead });
  const fake = client({ pullRequests: [target] });
  fake.getMergeQueueState = async () => {
    throw new Error("qualification-only must not read queue authority");
  };
  const result = await runDevPrAdmission({ ...targetedOptions, landingMode: "direct", qualificationOnly: true }, fake);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "source-qualified");
  assert.equal(result.receipt.reason, "source-qualified-exact-head");
  assert.equal(result.receipt.queue, null);
  assert.deepEqual(fake.enqueued, []);
});

test("qualification-only execute may establish readiness but never admits to GitHub queue", async () => {
  const target = pr({ number: 21, headSha: exactHead, labels: [] });
  const fake = client({ pullRequests: [target] });
  fake.getMergeQueueState = async () => {
    throw new Error("qualification-only must not read queue authority");
  };
  const result = await runDevPrAdmission(
    {
      ...targetedOptions,
      landingMode: "direct",
      dryRun: false,
      qualificationOnly: true,
    },
    fake,
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, "execute");
  assert.equal(result.receipt.readiness.established, true);
  assert.equal(fake.comments.length, 1);
  assert.deepEqual(fake.enqueued, []);
});

test("required Warrant fails closed before GitHub queue admission", async () => {
  const target = pr({ number: 21, headSha: exactHead });
  const fake = client({
    pullRequests: [target],
    queueStates: [{ enabled: true, id: "MQ_1", entries: [] }],
  });
  const result = await runDevPrAdmission({ ...targetedOptions, dryRun: false, warrantMode: "required" }, fake);
  assert.equal(result.ok, false);
  assert.equal(result.receipt.reason, "missing-delivery-warrant");
  assert.deepEqual(fake.enqueued, []);
});

test("exact active Warrant authorizes only its bound PR head", async () => {
  await withWarrantResult({}, async (resultPath) => {
    const target = pr({ number: 21, headSha: exactHead });
    const fake = client({
      pullRequests: [target],
      branchShas: ["base-1", "base-1", "base-1"],
      queueStates: Array.from({ length: 3 }, () => ({
        enabled: true,
        id: "MQ_1",
        entries: [],
      })),
    });
    const result = await runDevPrAdmission(
      {
        ...targetedOptions,
        dryRun: false,
        warrantMode: "required",
        warrantResultPath: resultPath,
      },
      fake,
    );
    assert.equal(result.ok, true);
    assert.equal(result.receipt.deliveryWarrant.fencingToken, ROOT);
    assert.equal(result.receipt.deliveryWarrant.stateRoot, ROOT);
    assert.deepEqual(fake.enqueued, [{ pullRequestId: "PR_21", expectedHeadOid: exactHead }]);
  });
});

test("mismatched or expired Warrant is rejected without enqueue", async () => {
  const cases = [
    [{ warrant: { repository: "kungfu-systems/kungfu" } }, "delivery-warrant-repository-mismatch"],
    [{ warrant: { protectedBase: "dev/v3/v3.0" } }, "delivery-warrant-base-mismatch"],
    [{ warrant: { pullRequestNumber: 22 } }, "delivery-warrant-pr-mismatch"],
    [{ warrant: { sourceHead: movedHead } }, "delivery-warrant-head-mismatch"],
    [{ warrant: { expiresAt: "2026-08-04T00:00:00.000Z" } }, "delivery-warrant-expired"],
  ];
  for (const [overrides, reason] of cases) {
    await withWarrantResult(overrides, async (resultPath) => {
      const target = pr({ number: 21, headSha: exactHead });
      const fake = client({
        pullRequests: [target],
        queueStates: [{ enabled: true, id: "MQ_1", entries: [] }],
      });
      const result = await runDevPrAdmission(
        {
          ...targetedOptions,
          dryRun: false,
          warrantMode: "required",
          warrantResultPath: resultPath,
        },
        fake,
      );
      assert.equal(result.ok, false, reason);
      assert.equal(result.receipt.reason, reason);
      assert.deepEqual(fake.enqueued, []);
    });
  }
});

test("targeted plan fails visibly when explicit readiness is missing even with native auto-merge armed", async () => {
  const target = pr({ number: 21, headSha: exactHead, labels: [], autoMerge: true });
  const result = await runDevPrAdmission(targetedOptions, client({ pullRequests: [target] }));
  assert.equal(result.ok, false);
  assert.equal(result.receipt.reason, "missing-ready-label");
  assert.equal(result.receipt.autoMergeEnabled, true);
  assert.equal(result.receipt.qualification, false);
  assert.deepEqual(result.receipt.observedLabels, []);
  assert.equal(result.receipt.policy.readyLabel, "ready");
  assert.deepEqual(result.receipt.policy.requiredChecks, ["check"]);
  assert.match(result.receiptRoot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(target.labels, []);
});

test("targeted execute establishes exact-head readiness, enqueues once, and publishes an idempotent PR diagnostic", async () => {
  const target = pr({ number: 21, headSha: exactHead, labels: [] });
  const fake = client({
    pullRequests: [target],
    branchShas: ["base-1", "base-1", "base-1"],
    queueStates: Array.from({ length: 3 }, () => ({ enabled: true, id: "MQ_1", entries: [] })),
  });
  const result = await runDevPrAdmission({ ...targetedOptions, dryRun: false }, fake);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.state, "queued");
  assert.equal(result.receipt.readiness.established, true);
  assert.equal(result.controller.runKind, "targeted-admission-evaluation");
  assert.equal(result.controller.outcome, "target-action-selected");
  assert.equal(result.controller.qualification, false);
  assert.deepEqual(fake.enqueued, [{ pullRequestId: "PR_21", expectedHeadOid: exactHead }]);
  assert.equal(fake.comments.length, 1);
  assert.match(fake.comments[0].body, /Next action:/);
  assert.equal(fake.commitStatuses.at(-1).body.context, "Buildchain delivery intent");

  const duplicateClient = client({
    pullRequests: [target],
    queueStates: [{
      enabled: true,
      id: "MQ_1",
      entries: [{ id: "MQE_1", state: "QUEUED", pullRequestNumber: 21, pullRequestHeadSha: exactHead }],
    }],
  });
  const duplicate = await runDevPrAdmission({ ...targetedOptions, dryRun: false }, duplicateClient);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.receipt.reason, "already-enqueued-exact-head");
  assert.deepEqual(duplicateClient.enqueued, []);
});

test("targeted admission refuses head drift, base drift, blocked labels, and forks before readiness mutation", async () => {
  const cases = [
    [pr({ number: 21, headSha: movedHead, labels: [] }), "head-sha-drift"],
    [pr({ number: 21, headSha: exactHead, baseRef: "dev/v3/v3.0", labels: [] }), "base-branch-drift"],
    [pr({ number: 21, headSha: exactHead, labels: [{ name: "blocked" }] }), "blocked-label"],
    [pr({ number: 21, headSha: exactHead, headRepo: "other/buildchain", labels: [] }), "fork-or-cross-repository-head"],
  ];
  for (const [target, reason] of cases) {
    const fake = client({ pullRequests: [target] });
    const result = await runDevPrAdmission({ ...targetedOptions, dryRun: false }, fake);
    assert.equal(result.ok, false);
    assert.equal(result.receipt.reason, reason);
    assert.equal(result.receipt.readiness.established, false);
    assert.equal(fake.comments.length, 1);
    assert.match(fake.comments[0].body, new RegExp(reason));
  }
});

test("targeted admission reports approval, checks, and queue contention as non-qualifying states", async () => {
  const ready = pr({ number: 21, headSha: exactHead });
  const missingApproval = await runDevPrAdmission(
    { ...targetedOptions, dryRun: false },
    client({ pullRequests: [ready], reviews: [], queueStates: Array.from({ length: 2 }, () => ({ enabled: true, id: "MQ_1", entries: [] })) }),
  );
  assert.equal(missingApproval.receipt.state, "waiting-approval");
  assert.equal(missingApproval.ok, false);

  const failingChecks = await runDevPrAdmission(
    { ...targetedOptions, dryRun: false },
    client({
      pullRequests: [ready],
      checks: { statuses: [{ context: "check", state: "failure" }], checkRuns: [] },
      queueStates: Array.from({ length: 2 }, () => ({ enabled: true, id: "MQ_1", entries: [] })),
    }),
  );
  assert.equal(failingChecks.receipt.state, "waiting-checks");

  const queue = { enabled: true, id: "MQ_1", entries: [{ id: "MQE_9", state: "QUEUED", pullRequestNumber: 9, pullRequestHeadSha: movedHead }] };
  const predecessor = await runDevPrAdmission(
    { ...targetedOptions, dryRun: false },
    client({ pullRequests: [ready], queueStates: [queue, queue] }),
  );
  assert.equal(predecessor.receipt.state, "waiting-queue");
});

test("readiness label removal is repaired and enqueue rejection can retry without a duplicate enqueue", async () => {
  const target = pr({ number: 21, headSha: exactHead, labels: [] });
  const fake = client({
    pullRequests: [target],
    branchShas: Array(6).fill("base-1"),
    queueStates: Array.from({ length: 6 }, () => ({ enabled: true, id: "MQ_1", entries: [] })),
    enqueueErrors: [new Error("transient rejection")],
  });
  const rejected = await runDevPrAdmission({ ...targetedOptions, dryRun: false }, fake);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.receipt.reason, "enqueue-rejected");
  target.labels = [];
  const retry = await runDevPrAdmission({ ...targetedOptions, dryRun: false }, fake);
  assert.equal(retry.ok, true);
  assert.equal(fake.enqueued.length, 1);
  assert.equal(fake.comments.length, 1);
});

test("cadence patrol distinguishes zero candidates and all-skipped no-op from qualification", async () => {
  const zero = await runDevPrAutoMerge(baseOptions, client({ pullRequests: [] }));
  assert.equal(zero.outcome, "no-op-no-candidates");
  assert.equal(zero.qualification, false);
  const skipped = await runDevPrAutoMerge(baseOptions, client({ pullRequests: [pr({ draft: true })] }));
  assert.equal(skipped.outcome, "no-op-all-skipped");
  assert.equal(skipped.qualification, false);
});

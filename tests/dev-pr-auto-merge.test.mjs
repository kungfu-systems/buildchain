import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectCutReplayProof, createSourceQualificationProof } from "../packages/core/dev-delivery-warrant.js";
import {
  cliOptions,
  evaluatePullRequest,
  GhCliClient,
  GitHubClient,
  renderMarkdownSummary,
  runDevPrAdmission,
  runDevPrAutoMerge,
} from "../scripts/dev-pr-auto-merge.mjs";
import { readCurrentDeliveryQueueState } from "../scripts/dev-pr-delivery-warrant.mjs";

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
      ...(overrides.baseSha ? { sha: overrides.baseSha } : {}),
    },
    ...(overrides.mergeCommitSha ? { merge_commit_sha: overrides.mergeCommitSha } : {}),
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
  currentDeliveryQueue,
  statusReadbackLag = 0,
  baseDelta = null,
  commitTrees = {},
} = {}) {
  const merged = [];
  const enqueued = [];
  const commitStatuses = [];
  const comments = [];
  let branchRead = 0;
  let queueRead = 0;
  let statusReadbackCount = 0;
  const detailReads = new Map();
  const fake = {
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
      if (commitStatuses.length > 0 && statusReadbackCount < statusReadbackLag) {
        statusReadbackCount += 1;
        return checks;
      }
      const latestStatuses = new Map();
      for (const status of commitStatuses) {
        if (status.body?.context) latestStatuses.set(status.body.context, status.body);
      }
      return {
        ...checks,
        statuses: [...latestStatuses.values(), ...(checks.statuses || [])],
      };
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
    async getBaseDelta() {
      if (baseDelta instanceof Error) throw baseDelta;
      return baseDelta;
    },
    async getCommitTree(commitSha) {
      return commitTrees[commitSha] || "";
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
  if (currentDeliveryQueue !== undefined) {
    fake.getDevDeliveryQueueState = async () => currentDeliveryQueue;
  }
  return fake;
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

test("queue admission accepts blocked state but requires exact Project Cut proof for behind", async () => {
  const options = { ...baseOptions, landingMode: "queue", dryRun: true };
  const blocked = pr({ mergeable: true, mergeable_state: "blocked" });
  const behindHead = "a".repeat(40);
  const currentBase = "b".repeat(40);
  const behind = pr({ mergeable: true, mergeable_state: "behind", headSha: behindHead });

  assert.equal(
    (await evaluatePullRequest(blocked, options, client({ pullRequests: [blocked] }))).action,
    "would-merge",
  );
  assert.equal(
    (await evaluatePullRequest(behind, options, client({ pullRequests: [behind] }))).action,
    "skip",
  );
  assert.equal(
    (await evaluatePullRequest(behind, options, client({ pullRequests: [behind] }))).reason,
    "project-cut-proof-required",
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-project-cut-"));
  const proofPath = path.join(directory, "proof.json");
  const proof = createProjectCutReplayProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v2/v2.6",
    pullRequestNumber: 1,
    sourceHead: behindHead,
    sourcePatchRoot: ROOT,
    currentBase,
    replayTree: "c".repeat(40),
    qualificationReceipt: {
      schema: "project.cut.merge-queue-admission/v1",
      ok: true,
      decision: "qualified",
      baseCommitOid: currentBase,
      headCommitOid: behindHead,
      candidateCommitOid: "d".repeat(40),
      candidateTreeOid: "c".repeat(40),
      replayedCommitCount: 1,
      compositionChanged: false,
      reasonCodes: [],
    },
    requiredContextRoots: [ROOT],
    verifiedAt: "2026-08-04T00:10:00Z",
  });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
  try {
    const qualified = await evaluatePullRequest(
      behind,
      { ...options, projectCutProofPath: proofPath, sourcePatchRoot: ROOT },
      client({ pullRequests: [behind], branchShas: [currentBase] }),
    );
    assert.equal(qualified.action, "would-merge");
    assert.equal(qualified.projectCut.proofRoot, proof.proofRoot);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(
    (await evaluatePullRequest(blocked, { ...options, landingMode: "direct" }, client({ pullRequests: [blocked] }))).reason,
    "not-mergeable",
  );
  assert.equal(
    (await evaluatePullRequest(behind, { ...options, landingMode: "direct" }, client({ pullRequests: [behind] }))).reason,
    "not-mergeable",
  );
  const conflicted = { ...blocked, mergeable: false };
  assert.equal(
    (await evaluatePullRequest(conflicted, options, client({ pullRequests: [conflicted] }))).reason,
    "pre-enqueue-merge-conflict",
  );
});

test("reusable admission retains immutable Warrant and Project Cut readback coordinates", () => {
  const workflow = fs.readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/dev-pr-auto-merge.yml"), "utf8");
  assert.match(workflow, /project-cut-proof-json:/u);
  assert.match(workflow, /dev-delivery-proof\.mjs verify-replay/u);
  assert.match(workflow, /\.after\.commitSha \| test\("\^\[0-9a-f\]\{40\}\$"\)/u);
  assert.match(workflow, /\.warrant == \.observation\.activeWarrant/u);
  assert.match(workflow, /\.observation\.activeCandidate\.candidateId == \.observation\.activeWarrant\.candidateId/u);
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
      { enabled: true, id: "MQ_1", entries: [] }, { enabled: true, id: "MQ_1", entries: [
        { id: "MQE_stale", pullRequestNumber: 1, pullRequestHeadSha: "sha-stale" }] },
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

test("queue admission receipt retains the exact Project Cut proof root", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-project-cut-receipt-"));
  const proofPath = path.join(directory, "proof.json");
  const sourceHead = "a".repeat(40);
  const currentBase = "b".repeat(40);
  const proof = createProjectCutReplayProof({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v2/v2.6",
    pullRequestNumber: 1,
    sourceHead,
    sourcePatchRoot: ROOT,
    currentBase,
    replayTree: "c".repeat(40),
    qualificationReceipt: {
      schema: "project.cut.merge-queue-admission/v1",
      ok: true,
      decision: "qualified",
      baseCommitOid: currentBase,
      headCommitOid: sourceHead,
      candidateCommitOid: "d".repeat(40),
      candidateTreeOid: "c".repeat(40),
      replayedCommitCount: 1,
      compositionChanged: false,
      reasonCodes: [],
    },
    requiredContextRoots: [ROOT],
    verifiedAt: "2026-08-04T00:10:00Z",
  });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
  try {
    const candidate = pr({ mergeable_state: "behind", headSha: sourceHead });
    const fake = client({
      pullRequests: [candidate],
      branchShas: [currentBase, currentBase, currentBase, currentBase],
      queueStates: [
        { enabled: true, id: "MQ_1", entries: [] },
        { enabled: true, id: "MQ_1", entries: [] },
      ],
    });
    const result = await runDevPrAutoMerge(
      { ...baseOptions, landingMode: "queue", projectCutProofPath: proofPath, sourcePatchRoot: ROOT },
      fake,
    );
    assert.equal(result.actions[0].admissionReceipt.projectCut.proofRoot, proof.proofRoot);
    assert.equal(result.actions[0].admissionReceipt.projectCut.currentBase, currentBase);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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
  assert.match(result.enqueued[0].atomicAdmissionReceiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.enqueued[0].atomicAdmissionReceipt.decision, "qualified");
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

test("queue admission waits for status readback before enqueue", async () => {
  const fake = client({
    pullRequests: [pr({ number: 1, nodeId: "PR_node_1" })],
    branchShas: ["base-1", "base-1", "base-1"],
    queueStates: [
      { enabled: true, id: "MQ_1", entries: [] },
      { enabled: true, id: "MQ_1", entries: [] },
    ],
    statusReadbackLag: 2,
  });
  const result = await runDevPrAutoMerge(
    {
      ...baseOptions,
      landingMode: "queue",
      dryRun: false,
      queueAdmissionContext: "Queue admission lease",
      pollMergeableAttempts: 3,
    },
    fake,
  );

  assert.equal(result.evaluated[0].reason, "enqueued-with-expected-head");
  assert.equal(result.evaluated[0].atomicAdmissionReadbackAttempts, 3);
  assert.equal(fake.enqueued.length, 1);
});

test("post-lease base or predecessor drift fails before enqueue", async () => {
  const empty = { enabled: true, id: "MQ_1", entries: [] };
  const predecessor = {
    ...empty,
    entries: [{
      id: "MQE_other",
      pullRequestNumber: 2,
      pullRequestHeadSha: "sha-2",
      state: "QUEUED",
    }],
  };
  const cases = [
    {
      reason: "base-sha-drift-after-lease-readback",
      branchShas: ["base-1", "base-1", "base-2", "base-2"],
      queueStates: Array(4).fill(empty),
    },
    {
      reason: "queue-predecessor-after-lease-readback",
      branchShas: Array(4).fill("base-1"),
      queueStates: [empty, empty, predecessor, predecessor],
    },
  ];
  for (const scenario of cases) {
    const fake = client({
      ...scenario,
      pullRequests: [pr({ number: 1, nodeId: "PR_node_1" })],
    });
    const result = await runDevPrAutoMerge({
      ...baseOptions,
      landingMode: "queue",
      dryRun: false,
      queueAdmissionContext: "Queue admission lease",
      activeLeaseContext: "Queue family lease/exact",
    }, fake);
    assert.equal(result.evaluated[0].reason, scenario.reason);
    assert.deepEqual(fake.enqueued, []);
    assert.deepEqual(
      fake.commitStatuses.map((entry) => entry.body.state),
      ["pending", "success", "failure", "failure"],
    );
  }
});

test("required prequeue guard reuses only a disjoint attributed base move and binds a distinct Project Cut", async () => {
  const previousBase = "b".repeat(40);
  const currentBase = "c".repeat(40);
  const mergeCommitSha = "d".repeat(40);
  const replayTree = "e".repeat(40);
  const root = (digit) => `sha256:${digit.repeat(64)}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "buildchain-prequeue-source-proof-"));
  const proofPath = path.join(directory, "source-proof.json");
  const proof = createSourceQualificationProof({
    repository: "kungfu-systems/buildchain", protectedBase: "dev/v2/v2.6", sourceHead: exactHead,
    sourceIdentityRoot: root("1"), sourcePatchRoot: root("2"), planRoot: root("3"), closureRoot: root("4"), dependencyRoot: root("5"), toolchainRoot: root("6"),
    affectedPaths: ["packages/native/runtime.cc"], shardEvidenceRoots: [root("f")], qualifiedAt: "2026-08-14T00:00:30Z",
  });
  fs.writeFileSync(proofPath, `${JSON.stringify(proof)}\n`);
  try {
    await withWarrantResult({ warrant: { sourceProofRoot: proof.proofRoot } }, async (resultPath, warrantResult) => {
      const target = pr({ number: 21, headSha: exactHead, baseSha: currentBase, mergeCommitSha, mergeable_state: "blocked" });
      const authority = { activeWarrant: warrantResult.warrant, candidates: [{ candidateId: warrantResult.warrant.candidateId, sourceHead: exactHead, status: "qualified" }] };
      const run = (fake) => runDevPrAdmission({ ...targetedOptions, dryRun: false, warrantMode: "required", warrantResultPath: resultPath, sourceProofPath: proofPath }, fake);
      const fake = client({ pullRequests: [target], branchShas: [previousBase, currentBase, currentBase, currentBase, currentBase], queueStates: Array.from({ length: 6 }, () => ({ enabled: true, id: "MQ_1", entries: [] })), baseDelta: { status: "ahead", merge_base_commit: { sha: previousBase }, files: [{ status: "modified", filename: "docs/guide.md" }] }, commitTrees: { [mergeCommitSha]: replayTree }, currentDeliveryQueue: authority });
      const result = await run(fake);
      assert.equal(result.ok, true);
      const transaction = result.receipt.queue.admissionTransaction;
      assert.equal(transaction.frozenBase, previousBase);
      assert.equal(transaction.admittedBase, currentBase);
      assert.equal(transaction.preEnqueueProjectCut.sourceHeadMutationRequired, false);
      assert.equal(transaction.preEnqueueProjectCut.composition.replayTree, replayTree);
      assert.equal(transaction.preEnqueueProjectCut.baseMoved, true);
      assert.match(transaction.preEnqueueProjectCut.sourceProofReuseDecisionRoot, /^sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(fake.enqueued, [{ pullRequestId: "PR_21", expectedHeadOid: exactHead }]);

      const overlap = client({ pullRequests: [target], branchShas: [previousBase, currentBase, currentBase], queueStates: Array.from({ length: 5 }, () => ({ enabled: true, id: "MQ_1", entries: [] })), baseDelta: { status: "ahead", merge_base_commit: { sha: previousBase }, files: [{ status: "modified", filename: "packages/native/runtime.cc" }] }, commitTrees: { [mergeCommitSha]: replayTree }, currentDeliveryQueue: authority });
      const overlapResult = await run(overlap);
      assert.equal(overlapResult.receipt.reason, "pre-enqueue-base-delta-overlap");
      assert.deepEqual(overlap.enqueued, []);

      const postReplayDrift = client({ pullRequests: [target], branchShas: [previousBase, currentBase, currentBase, "f".repeat(40), "f".repeat(40)], queueStates: Array.from({ length: 6 }, () => ({ enabled: true, id: "MQ_1", entries: [] })), baseDelta: { status: "ahead", merge_base_commit: { sha: previousBase }, files: [{ status: "modified", filename: "docs/guide.md" }] }, commitTrees: { [mergeCommitSha]: replayTree }, currentDeliveryQueue: authority });
      const driftResult = await run(postReplayDrift);
      assert.equal(driftResult.receipt.reason, "base-sha-drift-after-project-cut");
      assert.deepEqual(postReplayDrift.enqueued, []);

      const changedComposition = pr({ number: 21, headSha: exactHead, baseSha: currentBase, mergeCommitSha: "a".repeat(40), mergeable_state: "blocked" });
      const compositionDrift = client({ pullRequests: [target], detailedPullRequests: { 21: [target, target, target, target, changedComposition] }, branchShas: [previousBase, currentBase, currentBase, currentBase, currentBase], queueStates: Array.from({ length: 6 }, () => ({ enabled: true, id: "MQ_1", entries: [] })), baseDelta: { status: "ahead", merge_base_commit: { sha: previousBase }, files: [{ status: "modified", filename: "docs/guide.md" }] }, commitTrees: { [mergeCommitSha]: replayTree, [changedComposition.merge_commit_sha]: "9".repeat(40) }, currentDeliveryQueue: authority });
      const compositionResult = await run(compositionDrift);
      assert.equal(compositionResult.receipt.reason, "pre-enqueue-project-cut-composition-drift");
      assert.deepEqual(compositionDrift.enqueued, []);

      const conflictedAfterReplay = { ...target, mergeable: false };
      const conflictDrift = client({ pullRequests: [target], detailedPullRequests: { 21: [target, target, target, target, conflictedAfterReplay] }, branchShas: [previousBase, currentBase, currentBase, currentBase, currentBase], queueStates: Array.from({ length: 6 }, () => ({ enabled: true, id: "MQ_1", entries: [] })), baseDelta: { status: "ahead", merge_base_commit: { sha: previousBase }, files: [{ status: "modified", filename: "docs/guide.md" }] }, commitTrees: { [mergeCommitSha]: replayTree }, currentDeliveryQueue: authority });
      const conflictResult = await run(conflictDrift);
      assert.equal(conflictResult.receipt.reason, "pre-enqueue-merge-conflict-after-project-cut");
      assert.deepEqual(conflictDrift.enqueued, []);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("required prequeue guard rejects unknown attribution and merge conflict before enqueue", async () => {
  const previousBase = "b".repeat(40);
  const currentBase = "c".repeat(40);
  const target = pr({ number: 21, headSha: exactHead, baseSha: currentBase, mergeCommitSha: "d".repeat(40), mergeable_state: "blocked" });
  const cases = [
    ["pre-enqueue-base-attribution-unknown", true],
    ["pre-enqueue-merge-conflict", false],
  ];
  await withWarrantResult({}, async (resultPath, warrantResult) => {
    for (const [reason, mergeable] of cases) {
      const candidate = { ...target, mergeable };
      const fake = client({ pullRequests: [candidate], branchShas: [previousBase, currentBase, currentBase], queueStates: Array.from({ length: 5 }, () => ({ enabled: true, id: "MQ_1", entries: [] })), currentDeliveryQueue: { activeWarrant: warrantResult.warrant, candidates: [{ candidateId: warrantResult.warrant.candidateId, sourceHead: exactHead, status: "qualified" }] } });
      const result = await runDevPrAdmission({ ...targetedOptions, dryRun: false, warrantMode: "required", warrantResultPath: resultPath }, fake);
      assert.equal(result.receipt.reason, reason);
      assert.deepEqual(fake.enqueued, []);
    }
  });
});

test("enqueue error reconciliation requires an exact PR head queue readback", async () => {
  const exact = { id: "MQE_exact", state: "AWAITING_CHECKS", pullRequestNumber: 1, pullRequestHeadSha: "sha-1" };
  const empty = { enabled: true, id: "MQ_1", entries: [] };
  const fake = client({
    pullRequests: [pr({ number: 1, nodeId: "PR_node_1" })],
    branchShas: Array(3).fill("base-1"),
    queueStates: [empty, empty, { ...empty, entries: [exact] }],
    enqueueError: new Error("Pull request is already in the queue"),
  });
  const result = await runDevPrAutoMerge(
    { ...baseOptions, landingMode: "queue", dryRun: false, queueAdmissionContext: "Queue admission lease" }, fake);
  assert.equal(result.evaluated[0].reason, "already-enqueued-exact-head");
  assert.deepEqual(result.evaluated[0].queueEntry, exact);
  assert.deepEqual(fake.commitStatuses.map((entry) => entry.body.state), ["success"]);
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
  activeLeaseContext: "Queue family lease/exact",
  requiredChecks: "check",
  dryRun: true,
  pollMergeableDelayMs: 0,
};

const ROOT = `sha256:${"1".repeat(64)}`;

test("gh CLI client preserves authenticated REST fallback for current Warrant readback", async () => {
  const queue = { activeWarrant: { candidateId: ROOT } };
  const responses = [
    { object: { sha: "c".repeat(40) } },
    { tree: { sha: "tree-sha" } },
    { tree: [{ path: "queue.json", type: "blob", sha: "blob-sha" }] },
    { encoding: "base64", content: Buffer.from(JSON.stringify(queue)).toString("base64") },
  ];
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(options);
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) };
  };
  const github = new GhCliClient({ repository: { owner: "kungfu-systems", repo: "buildchain" }, token: "test-token", fetchImpl });
  assert.deepEqual(await readCurrentDeliveryQueueState(github, github.repository, "dev/v4/v4.0"), queue);
  assert.equal(requests[0].headers.authorization, "Bearer test-token");
});

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
    after: { commitSha: "b".repeat(40), stateRoot: ROOT },
    warrant,
    observation: {
      schema: "kungfu.buildchain.dev-delivery-queue-observation/v1",
      stateRoot: ROOT,
      activeWarrant: warrant,
      activeCandidate: {
        candidateId: warrant.candidateId,
        pullRequestNumber: warrant.pullRequestNumber,
        sourceHead: warrant.sourceHead,
      },
    },
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

test("qualification-only accepts a mergeable PR blocked only before queue admission", async () => {
  const target = pr({ number: 21, headSha: exactHead, mergeable_state: "blocked" });
  const fake = client({ pullRequests: [target] });
  fake.getMergeQueueState = async () => {
    throw new Error("qualification-only must not read queue authority");
  };
  const result = await runDevPrAdmission(
    { ...targetedOptions, landingMode: "queue", qualificationOnly: true },
    fake,
  );
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "source-qualified");
  assert.equal(result.receipt.reason, "source-qualified-exact-head");
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
  await withWarrantResult({}, async (resultPath, warrantResult) => {
    const target = pr({ number: 21, headSha: exactHead });
    const fake = client({
      pullRequests: [target],
      branchShas: ["base-1", "base-1", "base-1"],
      queueStates: Array.from({ length: 3 }, () => ({
        enabled: true,
        id: "MQ_1",
        entries: [],
      })),
      currentDeliveryQueue: {
        activeWarrant: warrantResult.warrant,
        candidates: [{
          candidateId: warrantResult.warrant.candidateId,
          sourceHead: warrantResult.warrant.sourceHead,
          status: "selected",
        }],
      },
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

test("required Warrant rejects current generation drift before enqueue", async () => {
  await withWarrantResult({}, async (resultPath, warrantResult) => {
    const target = pr({ number: 21, headSha: exactHead });
    const candidate = {
      candidateId: warrantResult.warrant.candidateId,
      sourceHead: warrantResult.warrant.sourceHead,
      status: "selected",
    };
    const current = {
      activeWarrant: warrantResult.warrant,
      candidates: [candidate],
    };
    const fake = client({
      pullRequests: [target],
      branchShas: Array(4).fill("base-1"),
      queueStates: Array.from({ length: 4 }, () => ({
        enabled: true,
        id: "MQ_1",
        entries: [],
      })),
    });
    let warrantRead = 0;
    fake.getDevDeliveryQueueState = async () => warrantRead++ === 0
      ? current
      : {
        activeWarrant: { ...warrantResult.warrant, generation: 2 },
        candidates: [candidate],
      };
    const result = await runDevPrAdmission({
      ...targetedOptions,
      dryRun: false,
      warrantMode: "required",
      warrantResultPath: resultPath,
    }, fake);

    assert.equal(result.receipt.reason, "delivery-warrant-current-generation-mismatch");
    assert.deepEqual(fake.enqueued, []);
    assert.deepEqual(
      fake.commitStatuses.slice(0, 4).map((entry) => entry.body.state),
      ["pending", "success", "failure", "failure"],
    );
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

test("required Warrant rejects missing immutable commit and active-candidate readback", async () => {
  const cases = [
    [{ result: { after: { stateRoot: ROOT } } }, "delivery-warrant-commit-readback-missing"],
    [{
      result: {
        observation: {
          schema: "kungfu.buildchain.dev-delivery-queue-observation/v1",
          stateRoot: ROOT,
          activeWarrant: null,
          activeCandidate: null,
        },
      },
    }, "delivery-warrant-missing"],
  ];
  for (const [overrides, reason] of cases) {
    await withWarrantResult(overrides, async (resultPath) => {
      const target = pr({ number: 21, headSha: exactHead });
      const fake = client({
        pullRequests: [target],
        queueStates: [{ enabled: true, id: "MQ_1", entries: [] }],
      });
      const result = await runDevPrAdmission({
        ...targetedOptions,
        dryRun: false,
        warrantMode: "required",
        warrantResultPath: resultPath,
      }, fake);
      assert.equal(result.ok, false);
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

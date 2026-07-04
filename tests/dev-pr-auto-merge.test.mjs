import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePullRequest,
  renderMarkdownSummary,
  runDevPrAutoMerge,
} from "../scripts/dev-pr-auto-merge.mjs";

function pr(overrides = {}) {
  return {
    number: overrides.number ?? 1,
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
      ref: "dev/v2/v2.5",
    },
  };
}

function client({
  pullRequests = [],
  reviews = [{ user: { login: "reviewer" }, state: "APPROVED" }],
  checks = {
    statuses: [{ context: "Verify", state: "success" }],
    checkRuns: [],
  },
} = {}) {
  const merged = [];
  return {
    merged,
    async listPullRequests() {
      return pullRequests;
    },
    async getPullRequest(number) {
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
      return "base-after";
    },
  };
}

const baseOptions = {
  repository: "kungfu-systems/buildchain",
  targetBranch: "dev/v2/v2.5",
  dryRun: true,
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

test("policy gates reject unsafe or incomplete dev PRs", async () => {
  const options = {
    repository: "kungfu-systems/buildchain",
    targetBranch: "dev/v2/v2.5",
    readyLabel: "ready",
    blockLabels: "blocked",
    allowedHeadPrefixes: "feature/,fix/",
    requiredChecks: "Verify",
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
        client({ checks: { statuses: [{ context: "Verify", state: "failure" }], checkRuns: [] } }),
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

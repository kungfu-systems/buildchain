import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePatrolOptions,
  renderPatrolMarkdownSummary,
  runBuildchainPatrol,
} from "../scripts/buildchain-patrol.mjs";

function pr(overrides = {}) {
  return {
    number: overrides.number ?? 1,
    title: overrides.title ?? "feat: ready change",
    draft: false,
    mergeable: true,
    mergeable_state: "clean",
    labels: [{ name: "ready" }],
    head: {
      ref: overrides.headRef ?? "feature/patrol",
      sha: overrides.headSha ?? `sha-${overrides.number ?? 1}`,
      repo: { full_name: "kungfu-systems/buildchain" },
    },
  };
}

function client({ pullRequests = [] } = {}) {
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
      return [{ user: { login: "reviewer" }, state: "APPROVED" }];
    },
    async listCommitChecks() {
      return {
        statuses: [{ context: "check", state: "success" }],
        checkRuns: [],
      };
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

test("daily patrol defaults to inspect plus ready dev PR maintenance", async () => {
  const fake = client({ pullRequests: [pr({ number: 11 })] });
  const result = await runBuildchainPatrol(
    {
      repository: "kungfu-systems/buildchain",
      targetBranch: "dev/v2/v2.6",
      cadence: "daily",
      dryRun: true,
      maxActions: 1,
    },
    fake,
  );

  assert.deepEqual(result.capabilities, ["inspect", "merge-ready-dev-prs"]);
  assert.equal(result.summary.evaluatedCount, 1);
  assert.equal(result.summary.actionCount, 1);
  assert.equal(result.actions[0].status, "planned");
  assert.deepEqual(fake.merged, []);
  assert.match(renderPatrolMarkdownSummary(result), /Buildchain patrol/);
  assert.match(renderPatrolMarkdownSummary(result), /#11/);
});

test("weekly and monthly patrol expose stable planned check slots", async () => {
  const weekly = await runBuildchainPatrol({
    repository: "kungfu-systems/buildchain",
    targetBranch: "dev/v2/v2.6",
    cadence: "weekly",
    dryRun: true,
  });
  const monthly = await runBuildchainPatrol({
    repository: "kungfu-systems/buildchain",
    targetBranch: "dev/v2/v2.6",
    cadence: "monthly",
    dryRun: true,
  });

  assert.deepEqual(weekly.capabilities, ["inspect", "release-health", "stale-state-health"]);
  assert.equal(weekly.summary.plannedCount, 2);
  assert.deepEqual(monthly.capabilities, ["inspect", "governance-health", "workflow-drift-health"]);
  assert.equal(monthly.summary.plannedCount, 2);
});

test("patrol rejects unsupported cadence, mode, and target branches", () => {
  assert.throws(
    () => normalizePatrolOptions({ repository: "kungfu-systems/buildchain", cadence: "hourly" }),
    /cadence must be one of/,
  );
  assert.throws(
    () => normalizePatrolOptions({ repository: "kungfu-systems/buildchain", mode: "publish" }),
    /mode must be one of/,
  );
  assert.throws(
    () => normalizePatrolOptions({ repository: "kungfu-systems/buildchain", targetBranch: "main" }),
    /target-branch must be a semver dev branch/,
  );
});

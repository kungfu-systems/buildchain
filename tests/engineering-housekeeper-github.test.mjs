import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubHousekeeperClient,
  GitHubHousekeeperProviderError,
  applyGitHubHousekeeperPlan,
  collectGitHubHousekeeperInventory,
  formatGitHubHousekeeperPlan,
  runGitHubHousekeeper,
} from "../packages/core/engineering-housekeeper-github.js";

const repository = "kungfu-systems/buildchain";
const targetBranch = "dev/v3/v3.0";
const observedAt = "2026-08-09T13:00:00.000Z";
const appliedAt = "2026-08-09T13:01:00.000Z";
const oid = (value) => String(value).repeat(40).slice(0, 40);

function clone(value) {
  return structuredClone(value);
}

function branch(name, sha) {
  return { name, commit: { sha } };
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    state: "open",
    draft: false,
    updated_at: "2026-06-01T00:00:00.000Z",
    head: {
      ref: "feature/stale",
      sha: oid("c"),
      repo: { full_name: repository },
    },
    labels: [],
    ...overrides,
  };
}

class FakeGitHubClient {
  constructor({
    branches,
    pullRequests = [],
    ancestors,
    ancestorPairs,
    associatedPullRequests,
    defaultBranch = targetBranch,
    comparisonDelayMs = 0,
  } = {}) {
    this.branches = new Map(
      (
        branches || [
          branch(targetBranch, oid("b")),
          branch("feature/merged", oid("a")),
        ]
      ).map((entry) => [entry.name, clone(entry)]),
    );
    this.pullRequests = pullRequests.map(clone);
    this.ancestors = new Set(ancestors || [oid("a"), oid("b")]);
    this.ancestorPairs = new Set(ancestorPairs || []);
    const defaultAssociatedPullRequests = {
      [oid("a")]: [
        pullRequest({
          state: "closed",
          merged_at: observedAt,
          head: {
            ref: "feature/merged",
            sha: oid("a"),
            repo: { full_name: repository },
          },
          base: { ref: targetBranch },
        }),
      ],
    };
    this.associatedPullRequests = new Map(
      Object.entries(
        associatedPullRequests === undefined
          ? defaultAssociatedPullRequests
          : associatedPullRequests,
      ),
    );
    this.associatedLookups = [];
    this.closedPullRequestLookups = 0;
    this.comparisons = [];
    this.comparisonDelayMs = comparisonDelayMs;
    this.activeComparisons = 0;
    this.maxActiveComparisons = 0;
    this.defaultBranch = defaultBranch;
    this.deleted = [];
    this.labelsAdded = [];
    this.failDelete = null;
  }

  async getRepository() {
    return { default_branch: this.defaultBranch };
  }

  async listBranches() {
    return [...this.branches.values()].map(clone);
  }

  async listOpenPullRequests() {
    return this.pullRequests
      .filter((entry) => entry.state === "open")
      .map(clone);
  }

  async listClosedPullRequests() {
    this.closedPullRequestLookups += 1;
    return [...this.associatedPullRequests.values()].flat().map(clone);
  }

  async getBranch(_repository, name) {
    const current = this.branches.get(name);
    if (!current) {
      throw new GitHubHousekeeperProviderError(`branch ${name} not found`, {
        operation: "get-branch",
        status: 404,
      });
    }
    return clone(current);
  }

  async getPullRequest(_repository, number) {
    const current = this.pullRequests.find((entry) => entry.number === number);
    if (!current) throw new Error(`pull request ${number} not found`);
    return clone(current);
  }

  async listPullRequestsForCommit(_repository, commitOid) {
    this.associatedLookups.push(commitOid);
    return clone(this.associatedPullRequests.get(commitOid) || []);
  }

  async compareCommits(_repository, baseOid, targetOid) {
    this.comparisons.push(`${baseOid}:${targetOid}`);
    this.activeComparisons += 1;
    this.maxActiveComparisons = Math.max(
      this.maxActiveComparisons,
      this.activeComparisons,
    );
    try {
      if (this.comparisonDelayMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.comparisonDelayMs),
        );
      }
      return {
        merge_base_commit: {
          sha:
            this.ancestors.has(baseOid) ||
            this.ancestorPairs.has(`${baseOid}:${targetOid}`)
              ? baseOid
              : oid("f"),
        },
      };
    } finally {
      this.activeComparisons -= 1;
    }
  }

  async deleteBranch(_repository, name) {
    if (this.failDelete) throw this.failDelete;
    this.deleted.push(name);
    this.branches.delete(name);
  }

  async addLabels(_repository, number, labels) {
    this.labelsAdded.push({ number, labels });
    const current = this.pullRequests.find((entry) => entry.number === number);
    current.labels.push(...labels.map((name) => ({ name })));
  }
}

async function planWith(client, options = {}) {
  return collectGitHubHousekeeperInventory({
    client,
    repository,
    targetBranch,
    observedAt,
    ...options,
  });
}

test("GitHub client paginates every branch and pull-request page", async () => {
  const requests = [];
  const responses = new Map([
    [
      `https://api.github.test/repos/kungfu-systems/buildchain/branches?per_page=100`,
      {
        body: [branch("feature/one", oid("1"))],
        link: '<https://api.github.test/branches?page=2>; rel="next"',
      },
    ],
    [
      "https://api.github.test/branches?page=2",
      { body: [branch("feature/two", oid("2"))] },
    ],
    [
      `https://api.github.test/repos/kungfu-systems/buildchain/pulls?state=open&sort=updated&direction=asc&per_page=100`,
      {
        body: [pullRequest({ number: 1 })],
        link: '<https://api.github.test/pulls?page=2>; rel="next"',
      },
    ],
    [
      "https://api.github.test/pulls?page=2",
      { body: [pullRequest({ number: 2 })] },
    ],
    [
      `https://api.github.test/repos/kungfu-systems/buildchain/commits/${oid(
        "a",
      )}/pulls?per_page=100`,
      { body: [pullRequest({ number: 3, merged_at: observedAt })] },
    ],
    [
      `https://api.github.test/repos/kungfu-systems/buildchain/pulls?state=closed&sort=updated&direction=asc&per_page=100`,
      {
        body: [
          pullRequest({ number: 4, state: "closed", merged_at: observedAt }),
        ],
      },
    ],
  ]);
  const client = new GitHubHousekeeperClient({
    token: "test-token",
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      const response = responses.get(url);
      assert.ok(response, url);
      return new Response(JSON.stringify(response.body), {
        status: 200,
        headers: response.link ? { link: response.link } : {},
      });
    },
  });
  assert.deepEqual(
    (await client.listBranches(repository)).map((entry) => entry.name),
    ["feature/one", "feature/two"],
  );
  assert.deepEqual(
    (await client.listOpenPullRequests(repository)).map(
      (entry) => entry.number,
    ),
    [1, 2],
  );
  assert.deepEqual(
    (await client.listPullRequestsForCommit(repository, oid("a"))).map(
      (entry) => entry.number,
    ),
    [3],
  );
  assert.deepEqual(
    (await client.listClosedPullRequests(repository)).map(
      (entry) => entry.number,
    ),
    [4],
  );
  assert.equal(requests.length, 6);
  assert.ok(requests.every((entry) => entry.method === "GET"));
});

test("GitHub delete performs a final exact-head fence before ref mutation", async () => {
  const requests = [];
  const client = new GitHubHousekeeperClient({
    token: "test-token",
    apiUrl: "https://api.github.test",
    fetchImpl: async (url, options) => {
      requests.push(options.method);
      assert.match(url, /feature\/merged$/);
      return new Response(JSON.stringify(branch("feature/merged", oid("c"))), {
        status: 200,
      });
    },
  });
  await assert.rejects(
    client.deleteBranch(repository, "feature/merged", {
      expectedHeadOid: oid("a"),
    }),
    (error) =>
      error instanceof GitHubHousekeeperProviderError && error.status === 409,
  );
  assert.deepEqual(requests, ["GET"]);
});

test("GitHub pagination never forwards credentials to another origin", async () => {
  const client = new GitHubHousekeeperClient({
    token: "test-token",
    apiUrl: "https://api.github.test",
    fetchImpl: async () =>
      new Response("[]", {
        status: 200,
        headers: {
          link: '<https://attacker.invalid/branches?page=2>; rel="next"',
        },
      }),
  });
  await assert.rejects(
    client.listBranches(repository),
    (error) =>
      error instanceof GitHubHousekeeperProviderError &&
      /cannot leave API origin/.test(error.message),
  );
});

test("inventory is deterministic for the same observation and retains unsafe refs", async () => {
  const branchStates = [
    branch("feature/unmerged", oid("d")),
    branch("feature/merged", oid("a")),
    branch(targetBranch, oid("b")),
    branch("release/v3/v3.0", oid("e")),
  ];
  const first = new FakeGitHubClient({ branches: branchStates });
  const second = new FakeGitHubClient({
    branches: [...branchStates].reverse(),
  });
  const left = await planWith(first);
  const right = await planWith(second);
  assert.deepEqual(left, right);
  assert.deepEqual(
    left.actions
      .filter((entry) => entry.kind === "delete-branch")
      .map((entry) => entry.name),
    ["feature/merged"],
  );
  assert.deepEqual(first.comparisons, [`${oid("a")}:${oid("b")}`]);
  assert.ok(
    left.inventory
      .find((entry) => entry.name === "feature/unmerged")
      .reasonCodes.includes("branch.not-merged"),
  );
  assert.match(formatGitHubHousekeeperPlan(left), /feature\/merged/);
});

test("empty target discovers every protected mainline but mutates only allowlisted temporary families", async () => {
  const v4Branch = "dev/v4/v4.0";
  const client = new FakeGitHubClient({
    branches: [
      branch(targetBranch, oid("b")),
      branch(v4Branch, oid("e")),
      branch("feature/v4-merged", oid("a")),
      branch("experiment/v4-merged", oid("c")),
    ],
    ancestors: [],
    ancestorPairs: [`${oid("a")}:${oid("e")}`, `${oid("c")}:${oid("e")}`],
    associatedPullRequests: {
      [oid("a")]: [
        pullRequest({
          number: 11,
          merged_at: observedAt,
          head: {
            ref: "feature/v4-merged",
            sha: oid("a"),
            repo: { full_name: repository },
          },
          base: { ref: v4Branch },
        }),
      ],
    },
  });
  const plan = await planWith(client, { targetBranch: "" });
  assert.equal(plan.target.name, targetBranch);
  assert.deepEqual(
    plan.actions
      .filter((entry) => entry.kind === "delete-branch")
      .map((entry) => ({ name: entry.name, target: entry.targetName })),
    [{ name: "feature/v4-merged", target: v4Branch }],
  );
  const unknown = plan.inventory.find(
    (entry) => entry.name === "experiment/v4-merged",
  );
  assert.equal(unknown.decision, "retain");
  assert.ok(unknown.reasonCodes.includes("branch.not-temporary-development"));
  assert.equal(client.closedPullRequestLookups, 1);
  assert.deepEqual(client.associatedLookups, []);
  assert.deepEqual(client.comparisons, [`${oid("a")}:${oid("e")}`]);
});

test("repository-wide ancestry inventory uses bounded concurrency and stable output order", async () => {
  const featureOids = Array.from({ length: 20 }, (_, index) =>
    String(index + 1).padStart(40, "0"),
  );
  const client = new FakeGitHubClient({
    branches: [
      branch(targetBranch, oid("b")),
      ...featureOids.map((sha, index) => branch(`feature/${index}`, sha)),
    ],
    ancestors: featureOids,
    associatedPullRequests: Object.fromEntries(
      featureOids.map((sha, index) => [
        sha,
        [
          pullRequest({
            number: 100 + index,
            state: "closed",
            merged_at: observedAt,
            head: {
              ref: `feature/${index}`,
              sha,
              repo: { full_name: repository },
            },
            base: { ref: targetBranch },
          }),
        ],
      ]),
    ),
    comparisonDelayMs: 5,
  });
  const plan = await planWith(client, { targetBranch: "" });
  assert.equal(client.maxActiveComparisons, 8);
  assert.deepEqual(
    plan.actions.map((entry) => entry.name),
    Array.from({ length: 20 }, (_, index) => `feature/${index}`).sort(),
  );
});

test("run defaults to dry-run and never mutates the repository", async () => {
  const client = new FakeGitHubClient();
  const result = await runGitHubHousekeeper({
    client,
    repository,
    targetBranch,
    observedAt,
    appliedAt,
  });
  assert.deepEqual(client.deleted, []);
  assert.deepEqual(client.labelsAdded, []);
  assert.ok(
    result.receipt.outcomes.every((entry) => entry.status === "dry-run"),
  );
});

test("apply deletes an exact merged branch after current-state revalidation", async () => {
  const client = new FakeGitHubClient();
  const plan = await planWith(client);
  const receipt = await applyGitHubHousekeeperPlan({
    client,
    plan,
    dryRun: false,
    appliedAt,
  });
  assert.deepEqual(client.deleted, ["feature/merged"]);
  assert.equal(receipt.outcomes[0].status, "deleted");
  assert.match(receipt.outcomes[0].outcomeRoot, /^sha256:[0-9a-f]{64}$/);
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/);
});

test("head, target, active-PR, ancestry, and rename races fail closed", async (t) => {
  const original = new FakeGitHubClient();
  const plan = await planWith(original);
  const cases = [
    {
      name: "head advanced",
      mutate(client) {
        client.branches.set(
          "feature/merged",
          branch("feature/merged", oid("c")),
        );
      },
      reason: "branch.head-advanced",
    },
    {
      name: "target advanced",
      mutate(client) {
        client.branches.set(targetBranch, branch(targetBranch, oid("c")));
      },
      reason: "branch.target-advanced",
    },
    {
      name: "active pull request",
      mutate(client) {
        client.pullRequests.push(
          pullRequest({
            number: 9,
            updated_at: observedAt,
            head: {
              ref: "feature/merged",
              sha: oid("a"),
              repo: { full_name: repository },
            },
          }),
        );
      },
      reason: "branch.open-pr-head",
    },
    {
      name: "ambiguous ancestry",
      mutate(client) {
        client.ancestors.delete(oid("a"));
      },
      reason: "branch.not-merged",
    },
    {
      name: "provider protection enabled",
      mutate(client) {
        client.branches.set("feature/merged", {
          ...branch("feature/merged", oid("a")),
          protected: true,
        });
      },
      reason: "branch.protected",
    },
    {
      name: "renamed branch",
      mutate(client) {
        client.branches.delete("feature/merged");
        client.branches.set(
          "feature/renamed",
          branch("feature/renamed", oid("a")),
        );
      },
      reason: "branch.renamed",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = new FakeGitHubClient();
      scenario.mutate(client);
      const receipt = await applyGitHubHousekeeperPlan({
        client,
        plan,
        dryRun: false,
        appliedAt,
      });
      assert.deepEqual(client.deleted, []);
      assert.equal(receipt.outcomes[0].status, "rejected");
      assert.ok(receipt.outcomes[0].reasonCodes.includes(scenario.reason));
    });
  }
});

test("stale pull requests are reported and optionally labeled but never closed", async () => {
  const client = new FakeGitHubClient({ pullRequests: [pullRequest()] });
  const plan = await planWith(client, {
    policy: { pullRequests: { reportStale: true, label: "stale" } },
  });
  assert.deepEqual(
    plan.actions
      .filter((entry) => entry.number === 7)
      .map((entry) => entry.kind),
    ["label-pull-request", "report-pull-request"],
  );
  const receipt = await applyGitHubHousekeeperPlan({
    client,
    plan,
    dryRun: false,
    appliedAt,
  });
  assert.deepEqual(client.labelsAdded, [{ number: 7, labels: ["stale"] }]);
  assert.deepEqual(
    receipt.outcomes
      .filter((entry) => entry.action.includes("#7"))
      .map((entry) => entry.status),
    ["labeled", "reported"],
  );
  assert.equal(client.pullRequests[0].state, "open");
});

test("replays are no-ops and provider failures remain explicit in rooted receipts", async () => {
  const client = new FakeGitHubClient();
  const plan = await planWith(client);
  client.failDelete = new GitHubHousekeeperProviderError("permission denied", {
    operation: "delete-ref",
    status: 403,
  });
  const failed = await applyGitHubHousekeeperPlan({
    client,
    plan,
    dryRun: false,
    appliedAt,
  });
  assert.equal(failed.outcomes[0].status, "provider-error");
  assert.equal(failed.outcomes[0].providerError.status, 403);
  const replay = await applyGitHubHousekeeperPlan({
    client,
    plan,
    dryRun: false,
    priorReceipt: failed,
    appliedAt: "2026-08-09T13:02:00.000Z",
  });
  assert.equal(replay.outcomes[0].status, "no-op");
  assert.equal(client.deleted.length, 0);
});

test("inventory provider failures are typed and require no live credentials", async () => {
  const client = new FakeGitHubClient();
  client.listBranches = async () => {
    throw new Error("network unavailable");
  };
  await assert.rejects(
    planWith(client),
    (error) =>
      error instanceof GitHubHousekeeperProviderError &&
      error.operation === `inventory ${repository}`,
  );
});

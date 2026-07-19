import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubStableCandidateClient,
  normalizeStableCandidatePatrolOptions,
  runStableCandidatePatrol,
} from "../scripts/stable-candidate-patrol.mjs";

const SHA4 = "4".repeat(40);
const SHA5 = "5".repeat(40);

function client() {
  const writes = [];
  const branches = [];
  const pullRequests = [];
  const variables = new Map();
  return {
    writes,
    branches,
    pullRequests,
    variables,
    async readLedger() { return undefined; },
    async listAlphaTags() { return []; },
    async writeLedger(ref, ledgerPath, ledger) { writes.push({ ref, ledgerPath, ledger }); },
    async listReleases() {
      return [
        { tag_name: "v2.12.0-alpha.5", prerelease: true, published_at: "2026-07-11T02:50:00Z", html_url: "https://example.test/a5" },
        { tag_name: "v2.12.0-alpha.4", prerelease: true, published_at: "2026-07-11T00:00:00Z", html_url: "https://example.test/a4" },
      ];
    },
    async resolveTagSha(tag) { return tag.endsWith("alpha.4") ? SHA4 : SHA5; },
    async getCommitEvidence(sha) {
      const completed = sha === SHA4 ? "2026-07-11T00:10:00Z" : "2026-07-11T02:55:00Z";
      return { statuses: [{ context: "consumer-canary", state: "success", updated_at: completed }], checkRuns: [] };
    },
    async ensureBranch(ref, sha) { branches.push({ ref, sha }); },
    async ensurePromotionPullRequest(input) {
      const pull = { ...input, node_id: "PR_node", html_url: "https://example.test/pr/1" };
      pullRequests.push(pull);
      return pull;
    },
    async enableAutoMerge(pull) { pull.autoMerge = true; },
    async setVariable(name, value) { variables.set(name, value); },
    async deleteVariable(name) { variables.delete(name); },
  };
}

function clientWithPublishedStable() {
  const fake = client();
  const listReleases = fake.listReleases.bind(fake);
  fake.listReleases = async () => [
    ...(await listReleases()),
    { tag_name: "v2.12.0", prerelease: false, published_at: "2026-07-11T03:30:00Z", html_url: "https://example.test/stable" },
  ];
  fake.resolveTagSha = async (tag) => tag === "v2.12.0" ? "a".repeat(40) : tag.endsWith("alpha.4") ? SHA4 : SHA5;
  return fake;
}

test("scheduled patrol promotes the previous qualified alpha while the newest soaks", async () => {
  const fake = client();
  const result = await runStableCandidatePatrol({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    requiredChecks: "consumer-canary",
    minimumSoakSeconds: 3600,
    now: "2026-07-11T03:00:00Z",
    dryRun: false,
    autoPromote: true,
    autoMerge: true,
  }, fake);

  assert.equal(result.selection.candidate.version, "2.12.0-alpha.4");
  assert.equal(result.selection.reason, "latest-qualified");
  assert.deepEqual(fake.branches, [{
    ref: "publish-gate/release/v2/v2.12/2.12.0-alpha.4",
    sha: SHA4,
  }]);
  assert.equal(fake.pullRequests[0].base, "release/v2/v2.12");
  assert.equal(fake.pullRequests[0].autoMerge, true);
  assert.equal(fake.writes.length, 1);
});

test("dry-run selects without writing refs, PRs, or ledger", async () => {
  const fake = client();
  const result = await runStableCandidatePatrol({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    requiredChecks: "consumer-canary",
    now: "2026-07-11T03:00:00Z",
    dryRun: true,
    autoPromote: true,
  }, fake);
  assert.equal(result.selection.selected, true);
  assert.deepEqual(fake.branches, []);
  assert.deepEqual(fake.pullRequests, []);
  assert.deepEqual(fake.writes, []);
});

test("patrol defaults are fail-safe and line-scoped", () => {
  const options = normalizeStableCandidatePatrolOptions({
    repository: "kungfu-systems/example",
    targetBranch: "release/v3/v3.4",
  });
  assert.equal(options.dryRun, true);
  assert.equal(options.autoPromote, false);
  assert.equal(options.ledgerRef, "buildchain/candidate-ledger/v3/v3.4");
  assert.deepEqual(options.requiredChecks, ["alpha-release"]);
});

test("release-now automatically projects exact human authority", async () => {
  const fake = client();
  const result = await runStableCandidatePatrol({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    requiredChecks: "consumer-canary",
    minimumSoakSeconds: 3600,
    now: "2026-07-11T03:00:00Z",
    releaseNow: "2.12.0-alpha.5",
    dryRun: false,
    autoPromote: true,
  }, fake);
  assert.equal(result.selection.reason, "human-release-now");
  assert.equal(fake.variables.get("BUILDCHAIN_STABLE_RELEASE_NOW"), "2.12.0-alpha.5");
  assert.match(fake.variables.get("BUILDCHAIN_STABLE_RELEASE_REASON"), /human release-now/);
});

test("first ledger run reconstructs an already consumed stable version", async () => {
  const fake = clientWithPublishedStable();
  const result = await runStableCandidatePatrol({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    requiredChecks: "consumer-canary",
    now: "2026-07-11T04:00:00Z",
    dryRun: true,
  }, fake);
  assert.equal(result.selection.reason, "no-qualified-candidate");
  assert.ok(result.ledger.candidates.every((candidate) => candidate.state === "revoked"));
  assert.ok(result.ledger.candidates.every((candidate) => candidate.decision.reason === "stable-version-already-published:v2.12.0"));
});

test("tag-only candidates qualify with repository checks when alpha-release is not required", async () => {
  const fake = client();
  fake.listReleases = async () => [];
  fake.listAlphaTags = async () => [{
    version: "2.12.1-alpha.0",
    sha: SHA4,
    publishedAt: "2026-07-11T00:00:00Z",
    releasePublished: false,
  }];
  const result = await runStableCandidatePatrol({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    requiredChecks: "consumer-canary",
    now: "2026-07-11T02:00:00Z",
    dryRun: true,
  }, fake);
  assert.equal(result.selection.candidate.version, "2.12.1-alpha.0");

  const guarded = await runStableCandidatePatrol({
    repository: "kungfu-systems/example",
    targetBranch: "release/v2/v2.12",
    requiredChecks: "alpha-release,consumer-canary",
    now: "2026-07-11T02:00:00Z",
    dryRun: true,
  }, fake);
  assert.equal(guarded.selection.reason, "no-qualified-candidate");
});

test("GitHub client fails closed when auto-merge GraphQL returns errors", async () => {
  const github = createGitHubStableCandidateClient({
    repository: "kungfu-systems/example",
    token: "test-token",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          data: { enablePullRequestAutoMerge: null },
          errors: [{ message: "Pull request Auto merge is not allowed for this repository" }],
        });
      },
    }),
  });

  await assert.rejects(
    github.enableAutoMerge({ node_id: "PR_node" }),
    /GitHub GraphQL POST \/graphql failed: Pull request Auto merge is not allowed/,
  );
});

test("GitHub client reconciles a divergent stable target with an exact-tree source-lock commit", async () => {
  const candidateSha = "c".repeat(40);
  const targetSha = "t".repeat(40);
  const mergeSha = "m".repeat(40);
  const calls = [];
  const responses = [
    [404, { message: "Not Found" }],
    [200, { sha: candidateSha, tree: { sha: "candidate-tree" } }],
    [200, { object: { sha: targetSha } }],
    [200, { status: "diverged" }],
    [201, { sha: mergeSha }],
    [201, { object: { sha: mergeSha } }],
  ];
  const github = createGitHubStableCandidateClient({
    repository: "kungfu-systems/example",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
      const [status, payload] = responses.shift();
      return {
        ok: status >= 200 && status < 300,
        status,
        async text() { return JSON.stringify(payload); },
      };
    },
  });

  await github.ensureBranch("publish-gate/release/v2/v2.14/candidate", candidateSha, "release/v2/v2.14");

  assert.equal(responses.length, 0);
  assert.deepEqual(calls[4].body.parents, [candidateSha, targetSha]);
  assert.equal(calls[4].body.tree, "candidate-tree");
  assert.match(calls[4].body.message, /Signed-off-by: Buildchain Patrol/);
  assert.deepEqual(calls[5].body, {
    ref: "refs/heads/publish-gate/release/v2/v2.14/candidate",
    sha: mergeSha,
  });
});

test("GitHub client reuses an exact-tree source-lock that already contains the stable target", async () => {
  const candidateSha = "c".repeat(40);
  const sourceSha = "s".repeat(40);
  const targetSha = "t".repeat(40);
  const calls = [];
  const responses = [
    [200, { object: { sha: sourceSha } }],
    [200, { sha: candidateSha, tree: { sha: "candidate-tree" } }],
    [200, { sha: sourceSha, tree: { sha: "candidate-tree" } }],
    [200, { status: "ahead" }],
    [200, { object: { sha: targetSha } }],
    [200, { status: "ahead" }],
  ];
  const github = createGitHubStableCandidateClient({
    repository: "kungfu-systems/example",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      const [status, payload] = responses.shift();
      return {
        ok: true,
        status,
        async text() { return JSON.stringify(payload); },
      };
    },
  });

  const result = await github.ensureBranch("publish-gate/release/v2/v2.14/candidate", candidateSha, "release/v2/v2.14");

  assert.equal(result.object.sha, sourceSha);
  assert.equal(responses.length, 0);
  assert.ok(calls.every((call) => call.method === "GET"));
});

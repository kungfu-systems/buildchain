import assert from "node:assert/strict";
import test from "node:test";

import {
  commitContainsReleaseState,
  createV4GithubProductAdapters,
} from "../actions/v4-release-candidate-promote/product-provider-github-adapters.js";

function octokit({ status = "diverged", trees = {} } = {}) {
  return {
    rest: {
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { status } }),
      },
      git: {
        getCommit: async ({ commit_sha: commitSha }) => ({
          data: { tree: { sha: trees[commitSha] } },
        }),
      },
    },
  };
}

test("accepts a protected rebase whose resulting tree equals the release state", async () => {
  const client = octokit({
    trees: { state: "tree:release", rebased: "tree:release" },
  });

  assert.equal(
    await commitContainsReleaseState(
      client,
      "kungfu-systems/buildchain",
      "state",
      "rebased",
    ),
    true,
  );
});

test("rejects an unrelated protected commit with different content", async () => {
  const client = octokit({
    trees: { state: "tree:release", unrelated: "tree:other" },
  });

  assert.equal(
    await commitContainsReleaseState(
      client,
      "kungfu-systems/buildchain",
      "state",
      "unrelated",
    ),
    false,
  );
});

test("accepts normal ancestry without fetching commit trees", async () => {
  let getCommitCalls = 0;
  const client = octokit({ status: "ahead" });
  client.rest.git.getCommit = async () => {
    getCommitCalls += 1;
    throw new Error("tree lookup should not run");
  };

  assert.equal(
    await commitContainsReleaseState(
      client,
      "kungfu-systems/buildchain",
      "state",
      "descendant",
    ),
    true,
  );
  assert.equal(getCommitCalls, 0);
});

test("protected dev finalization overlays version files and retains release-state ancestry", async () => {
  const repository = "kungfu-systems/buildchain";
  const sourceSha = "1".repeat(40);
  const stateSha = "2".repeat(40);
  const alphaSha = "3".repeat(40);
  const devSha = "4".repeat(40);
  const pullRequestSha = "5".repeat(40);
  const stateRef = `refs/heads/buildchain/v4-product-state/${sourceSha}-4-0-2-alpha-11`;
  const legacyHead =
    "chore/v4-product-pr/dev-v4-v4.0/" +
    `${stateSha.slice(0, 12)}-${devSha.slice(0, 12)}`;
  const legacyHeadSha = "8".repeat(40);
  const refs = new Map([
    [stateRef.replace(/^refs\//u, ""), stateSha],
    ["heads/alpha/v4/v4.0", alphaSha],
    ["heads/dev/v4/v4.0", devSha],
    [`heads/${legacyHead}`, legacyHeadSha],
  ]);
  const trees = new Map([
    [stateSha, "tree:release-state"],
    [alphaSha, "tree:release-state"],
    [devSha, "tree:current-dev-with-unrelated-work"],
  ]);
  const versionFiles = [
    { path: "package.json", content: '{"version":"4.0.2-alpha.11"}\n' },
    {
      path: "dist/site/publication-registry.json",
      content: '{"version":"4.0.2-alpha.11"}\n',
    },
  ];
  const createdTrees = [];
  const createdCommits = [];
  const createdPullRequests = [];
  const checks = [];
  let blob = 0;
  const client = {
    rest: {
      git: {
        getRef: async ({ ref }) => {
          if (refs.has(ref))
            return { data: { object: { sha: refs.get(ref) } } };
          throw Object.assign(new Error("not found"), { status: 404 });
        },
        getCommit: async ({ commit_sha: sha }) => ({
          data: { tree: { sha: trees.get(sha) } },
        }),
        createBlob: async () => ({ data: { sha: `blob:${++blob}` } }),
        createTree: async (input) => {
          createdTrees.push(input);
          return { data: { sha: "tree:protected-dev-finalization" } };
        },
        createCommit: async (input) => {
          createdCommits.push(input);
          return { data: { sha: pullRequestSha } };
        },
        createRef: async ({ ref, sha }) => {
          refs.set(ref.replace(/^refs\//u, ""), sha);
          return { data: {} };
        },
        updateRef: async ({ ref }) => {
          if (ref === "heads/dev/v4/v4.0")
            throw Object.assign(new Error("protected branch"), { status: 422 });
          throw new Error(`unexpected ref update: ${ref}`);
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => ({
          data: {
            status: basehead.endsWith(`...${alphaSha}`) ? "ahead" : "diverged",
          },
        }),
      },
      checks: {
        create: async (input) => {
          checks.push(input);
          return { data: {} };
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async (input) => {
          createdPullRequests.push(input);
          return { data: { html_url: "https://example.invalid/pull/1" } };
        },
      },
    },
  };
  const operationRoot = "sha256:" + "6".repeat(64);
  const operation = {
    id: "product.refs.converge",
    adapter: "github-release-refs",
    operationRoot,
    target: {
      repository,
      sourceSha,
      stateRef,
      references: [
        { ref: "refs/tags/v4.0.2-alpha.11", target: "source" },
        { ref: "refs/heads/alpha/v4/v4.0", target: "version-state" },
        { ref: "refs/heads/dev/v4/v4.0", target: "version-state" },
        { ref: "refs/tags/v4.0-alpha", target: "version-state" },
      ],
    },
  };
  const context = {
    request: {
      octokit: client,
      mutationOctokit: client,
      requiredStatusCheck: "check",
    },
    plan: { operations: [operation] },
    intent: {
      exactTag: "v4.0.2-alpha.11",
      targetRef: "alpha/v4/v4.0",
      sourceTimestamp: "2026-09-01T00:00:00.000Z",
    },
    versionFiles,
    updates: [],
  };

  await createV4GithubProductAdapters(context).adapters[
    "github-release-refs"
  ].apply({
    capabilityId: operation.id,
    adapter: operation.adapter,
    targetRoot: operationRoot,
    subjectRoot: "sha256:" + "7".repeat(64),
  });

  assert.equal(createdTrees.length, 1);
  assert.equal(createdTrees[0].base_tree, trees.get(devSha));
  assert.deepEqual(
    createdTrees[0].tree.map(({ path }) => path),
    versionFiles.map(({ path }) => path),
  );
  assert.deepEqual(createdCommits[0].parents, [devSha, stateSha]);
  assert.equal(createdCommits[0].tree, "tree:protected-dev-finalization");
  assert.equal(createdPullRequests[0].base, "dev/v4/v4.0");
  assert.equal(
    createdPullRequests[0].head,
    `${legacyHead}-${pullRequestSha.slice(0, 12)}`,
  );
  assert.equal(refs.get(`heads/${legacyHead}`), legacyHeadSha);
  assert.equal(checks.at(-1).head_sha, pullRequestSha);
});

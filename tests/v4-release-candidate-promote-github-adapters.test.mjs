import assert from "node:assert/strict";
import test from "node:test";

import { commitContainsReleaseState } from "../actions/v4-release-candidate-promote/product-provider-github-adapters.js";

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

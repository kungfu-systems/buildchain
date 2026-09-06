import assert from "node:assert/strict";
import test from "node:test";

import { retryGithubMutation } from "../actions/v4-release-candidate-promote/product-provider-adapters.js";
import { createV4GithubProductAdapters } from "../actions/v4-release-candidate-promote/product-provider-github-adapters.js";

const SOURCE = "a".repeat(40);
const STATE = "b".repeat(40);
const BASE_TREE = "c".repeat(40);
const ROOT = `sha256:${"d".repeat(64)}`;
const STATE_REF = `refs/heads/buildchain/v4-product-state/${SOURCE}-0-2-0-alpha-9`;

test("zero-delta version state reuses the source tree without creating an empty tree", async () => {
  let stateSha = "";
  let createdCommit;
  const rest = {
    git: {
      async getRef() {
        if (!stateSha)
          throw Object.assign(new Error("not found"), { status: 404 });
        return { data: { object: { sha: stateSha } } };
      },
      async getCommit({ commit_sha: sha }) {
        if (sha === SOURCE)
          return { data: { sha, tree: { sha: BASE_TREE }, parents: [] } };
        return { data: createdCommit };
      },
      async createBlob() {
        assert.fail("zero-delta materialization must not create blobs");
      },
      async createTree() {
        assert.fail("zero-delta materialization must not create an empty tree");
      },
      async createCommit(input) {
        createdCommit = {
          ...input,
          sha: STATE,
          tree: { sha: input.tree },
          parents: input.parents.map((sha) => ({ sha })),
        };
        return { data: createdCommit };
      },
      async createRef({ sha }) {
        stateSha = sha;
        return { data: { object: { sha } } };
      },
      async getTree() {
        return { data: { tree: [] } };
      },
    },
  };
  const octokit = { rest };
  const operation = {
    id: "product.version-state.materialize",
    adapter: "github-version-state",
    operationRoot: ROOT,
    target: {
      repository: "kungfu-systems/agent-hub-demo",
      sourceSha: SOURCE,
      sourceTimestamp: "2026-09-03T09:37:51.000Z",
      stateRef: STATE_REF,
    },
  };
  const context = {
    request: { octokit, mutationOctokit: octokit },
    plan: { operations: [operation] },
    versionFiles: [],
    intent: { exactTag: "v0.2.0-alpha.9", version: "0.2.0-alpha.9" },
    updates: [],
    githubMutation: (mutation) => mutation(),
  };
  const effect = {
    capabilityId: operation.id,
    adapter: operation.adapter,
    targetRoot: ROOT,
  };
  const adapters = createV4GithubProductAdapters(context);
  await adapters.adapters["github-version-state"].apply(effect);
  assert.equal(createdCommit.tree.sha, BASE_TREE);
  assert.equal(stateSha, STATE);
});

test("GitHub mutation failures retain a safe status-scoped provider code", async () => {
  await assert.rejects(
    retryGithubMutation(
      async () => {},
      async () => {
        throw Object.assign(new Error("provider validation details"), {
          status: 422,
        });
      },
    ),
    (error) =>
      error.message === "GitHub provider mutation failed" &&
      error.releaseTailClass === "transient" &&
      error.releaseTailCode === "github-mutation-422" &&
      error.status === 422,
  );
});

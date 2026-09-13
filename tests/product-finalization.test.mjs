import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createGithubProductAdapters } from "../packages/core/release/promote-candidate/product-provider-github-adapters.js";
import { githubProvider, SOURCE, VERSION_STATE, REBASED_VERSION_STATE } from "./helpers/product-provider-fixtures.mjs";

function scenario({ mergedAt = 48, verifiedAt = 52, mutate = () => {} } = {}) {
  const github = githubProvider();
  const branch = "release/v4/v4.0";
  const repository = "kungfu-systems/buildchain";
  const stateRef = `refs/heads/buildchain/v4-product-state/${SOURCE}-4-0-2`;
  github.refs.set(`heads/${branch}`, SOURCE);
  github.refs.set(stateRef.slice(5), VERSION_STATE);
  github.commits.set(VERSION_STATE, { sha: VERSION_STATE, tree: { sha: "version-tree" }, parents: [{ sha: SOURCE }] });
  github.protectedRefs.add(`heads/${branch}`);
  let polls = 0, creates = 0;
  const original = github.octokit.rest.pulls.create;
  github.octokit.rest.pulls.create = async (input) => {
    creates += 1;
    await original(input);
    github.pullRequests.at(-1).number = 12;
    return { data: { number: 12 } };
  };
  // The isolated fixture has already materialized version state, so its first
  // generated commit uses VERSION_STATE. Give it a distinct realistic PR SHA.
  github.octokit.rest.git.createCommit = async ({ tree, parents }) => {
    const commit = { sha: REBASED_VERSION_STATE, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) };
    github.commits.set(commit.sha, commit);
    return { data: commit };
  };
  const pull = {
    number: 12, state: "open", draft: false,
    head: { sha: REBASED_VERSION_STATE, repo: { full_name: repository } },
    base: { ref: branch, repo: { full_name: repository } },
  };
  github.octokit.rest.pulls.get = async () => {
    polls += 1;
    if (polls >= mergedAt) {
      pull.merged_at = "2026-09-08T00:00:00Z";
      pull.merge_commit_sha = REBASED_VERSION_STATE;
      github.refs.set(`heads/${branch}`, REBASED_VERSION_STATE);
    }
    mutate({ pull, github, polls });
    return { data: pull };
  };
  github.octokit.rest.checks.listForRef = async () => ({ data: { check_runs: [{
    name: "check", head_sha: REBASED_VERSION_STATE, app: { slug: "github-actions" },
    details_url: `https://github.com/${repository}/actions/runs/13/job/123`, status: "completed", conclusion: "success",
  }] } });
  github.octokit.rest.actions = { getWorkflowRun: async () => ({ data: {
    id: 13, path: ".github/workflows/self-build-verify.yml", event: "push",
    head_sha: REBASED_VERSION_STATE, head_branch: branch,
    status: polls >= verifiedAt ? "completed" : "in_progress", conclusion: "success",
  } }) };
  const operation = { id: "refs", adapter: "github-release-refs", operationRoot: "root", target: {
    repository, sourceSha: SOURCE, stateRef, references: [
      { ref: "refs/tags/v4.0.2", target: "source" },
      { ref: `refs/heads/${branch}`, target: "version-state" },
      { ref: "refs/tags/v4", target: "channel" },
    ],
  } };
  const waits = [];
  const context = {
    request: { octokit: github.octokit, mutationOctokit: github.octokit },
    plan: { operations: [operation] }, versionFiles: [], updates: [],
    intent: { channel: "stable", targetRef: branch, exactTag: "v4.0.2", version: "4.0.2" },
    wait: async (ms) => waits.push(ms),
  };
  return { github, context, waits, counts: () => ({ polls, creates }),
    adapter: createGithubProductAdapters(context).adapters[operation.adapter],
    effect: { capabilityId: "refs", adapter: operation.adapter, targetRoot: "root" },
  };
}

test("stable provider waits beyond ten minutes and completes floating refs in the same invocation", async () => {
  const s = scenario();
  await s.adapter.apply(s.effect);
  assert.equal(s.github.refs.get("tags/v4"), REBASED_VERSION_STATE);
  assert.equal(s.github.refs.get("tags/v4.0.2"), SOURCE);
  assert.deepEqual(s.counts(), { polls: 52, creates: 1 });
  assert.equal(s.waits.length, 51);
  assert.equal((await s.adapter.readback(s.effect)).outcome, "observed");
  await s.adapter.apply(s.effect);
  assert.equal(s.counts().creates, 1);
});

test("closed, changed-head and changed-base finalization never moves floating refs", async () => {
  for (const mutate of [
    ({ pull }) => { pull.state = "closed"; },
    ({ pull }) => { pull.head.sha = SOURCE; },
    ({ github }) => { github.refs.set("heads/release/v4/v4.0", "9".repeat(40)); },
  ]) {
    const s = scenario({ mutate });
    await assert.rejects(s.adapter.apply(s.effect), (error) => error.releaseTailClass === "conflict");
    assert.equal(s.github.refs.has("tags/v4"), false);
  }
});

test("failed final protected verification cannot complete floating refs", async () => {
  const s = scenario({ mergedAt: 1 });
  s.github.octokit.rest.actions.getWorkflowRun = async () => ({ data: {
    id: 13, path: ".github/workflows/self-build-verify.yml", event: "push",
    head_sha: REBASED_VERSION_STATE, head_branch: "release/v4/v4.0",
    status: "completed", conclusion: "failure",
  } });
  await assert.rejects(s.adapter.apply(s.effect), (error) => error.releaseTailCode === "protected-finalization-check-failed");
  assert.equal(s.github.refs.has("tags/v4"), false);
});

test("missing finalization is bounded and retains the original exact tag for recovery", async () => {
  const s = scenario({ mergedAt: Infinity });
  await assert.rejects(s.adapter.apply(s.effect), (error) => error.releaseTailCode === "protected-finalization-timeout");
  assert.equal(s.counts().polls, 160);
  assert.equal(s.github.refs.get("tags/v4.0.2"), SOURCE);
  assert.equal(s.github.refs.has("tags/v4"), false);
  s.github.octokit.rest.pulls.get = async () => {
    s.github.refs.set("heads/release/v4/v4.0", REBASED_VERSION_STATE);
    return { data: { state: "closed", merged_at: "2026-09-08T00:00:00Z", merge_commit_sha: REBASED_VERSION_STATE,
      head: { sha: REBASED_VERSION_STATE, repo: { full_name: "kungfu-systems/buildchain" } },
      base: { ref: "release/v4/v4.0", repo: { full_name: "kungfu-systems/buildchain" } },
    } };
  };
  await s.adapter.apply(s.effect);
  assert.equal(s.counts().creates, 1);
  assert.equal(s.github.refs.get("tags/v4"), REBASED_VERSION_STATE);
});

test("ordinary protected stable Verify enters promotion and its generated PR enters independent review", () => {
  const workflow = fs.readFileSync(".github/workflows/self-release-promote.yml", "utf8");
  for (const section of [workflow.split("  classify-workflow-run:")[1].split("  promote:")[0], workflow.split("  promote:")[1]])
    assert.match(section, /startsWith\(github.event.workflow_run.head_branch, 'release\/'\)/u);
  assert.match(fs.readFileSync(".github/workflows/self-release-next-development.yml", "utf8"), /chore\/v4-product-pr\/release-/u);
});

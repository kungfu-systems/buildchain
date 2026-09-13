import test from "node:test";
import assert from "node:assert/strict";
import { githubPipelineIntegration } from "../packages/core/providers/github/pipeline-integration.js";
import { pipelineHostFixture } from "./helpers/pipeline-host.mjs";

function fixture() {
  const f = pipelineHostFixture();
  const commit = "9".repeat(40),
    tree = "8".repeat(40);
  const pr = {
    merged: true,
    head: { sha: f.f.source.commit, repo: { full_name: f.host.repository } },
    base: {
      ref: f.f.intent.source.targetBranch,
      repo: { full_name: f.host.repository },
    },
    merge_commit_sha: commit,
  };
  const run = {
    id: 42,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "merge_group",
    head_sha: commit,
    path: ".github/workflows/buildchain.yml",
  };
  let contained = true;
  const request = async (url) => {
    if (url.includes("/pulls/")) return structuredClone(pr);
    if (url.includes("/compare/"))
      return {
        status: contained ? "ahead" : "diverged",
        merge_base_commit: { sha: commit },
      };
    if (url.includes("/actions/runs?"))
      return { total_count: 1, workflow_runs: [run] };
    throw new Error(url);
  };
  const source = {
    branchHead: async () => "7".repeat(40),
    source: async () => ({
      identity: { ...f.f.source, commit, tree },
      plan: f.admission.plan,
    }),
  };
  const runs = {
    read: async () => ({ run }),
    build: async (_id, _attempt, identity, platforms) => ({
      source: identity,
      platforms,
      outcome: "success",
    }),
  };
  const provider = githubPipelineIntegration(
    request,
    f.host.repository,
    source,
    runs,
  );
  const observe = () =>
    provider.observe({ intent: f.f.intent, generation: f.f.generation });
  return {
    pr,
    run,
    observe,
    diverge: () => {
      contained = false;
    },
  };
}

test("integration requires exact source PR, protected ancestry and a successful merge-group run", async () => {
  const f = fixture();
  const proof = await f.observe();
  assert.equal(proof.sourceHead, f.pr.head.sha);
  assert.equal(proof.mergeCommit, f.pr.merge_commit_sha);
  f.diverge();
  await assert.rejects(f.observe(), /not contained/);
});

test("different-head merge, wrong event and incomplete execution cannot become integration proof", async () => {
  const f = fixture();
  f.run.event = "pull_request";
  await assert.rejects(f.observe(), /execution changed/);
  f.run.event = "merge_group";
  f.run.status = "in_progress";
  await assert.rejects(f.observe(), /no successful/);
  f.pr.head.sha = "0".repeat(40);
  await assert.rejects(f.observe(), /exact source PR/);
});

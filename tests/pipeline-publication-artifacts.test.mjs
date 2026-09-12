import test from "node:test";
import assert from "node:assert/strict";
import {
  githubPipelinePublicationArtifacts,
  pipelinePublicationArtifactName,
} from "../packages/core/providers/github/pipeline-publication-artifacts.js";

function fixture(change = () => {}) {
  const plan = {
    root: `sha256:${"a".repeat(64)}`,
    outputs: [{ platform: "linux-x64" }, { platform: "windows-x64" }],
  };
  const run = { id: 8, head_sha: "b".repeat(40), run_attempt: 2 };
  const jobs = plan.outputs.map(({ platform }, index) => ({
    id: index + 1,
    name: `Products / Build publication (${platform})`,
    run_id: 8,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
  }));
  const artifacts = plan.outputs.map(({ platform }, index) => ({
    id: index + 10,
    name: pipelinePublicationArtifactName(plan, platform),
    expired: false,
    digest: `sha256:${"c".repeat(64)}`,
    workflow_run: { id: 8, head_sha: run.head_sha },
  }));
  const state = { run, jobs, artifacts, total_count: 2 };
  change(state);
  let reads = 0;
  const provider = githubPipelinePublicationArtifacts({
    repository: "example/product",
    token: "test",
    request: async () => ({
      artifacts: state.artifacts,
      total_count: state.total_count,
    }),
    runs: {
      read: async () => {
        reads++;
        return {
          run: structuredClone(state.run),
          jobs: structuredClone(state.jobs),
        };
      },
    },
  });
  return {
    provider,
    state,
    reads: () => reads,
    context: {
      plan,
      materialization: { source: { commit: "d".repeat(40) } },
      runId: 8,
      runAttempt: 2,
    },
  };
}

test("publication independently rereads every completed platform and exact provider artifact", async () => {
  const { provider, context, reads } = fixture();
  const { build } = await provider.buildReadback(context);
  assert.deepEqual(build.artifactIds, [10, 11]);
  assert.equal(build.source.commit, "d".repeat(40));
  assert.equal(build.providerSource, "b".repeat(40));
  assert.equal(reads(), 2);
});

test("publication rejects incomplete inventories, old jobs, duplicate or expired artifacts and unrelated run sources", async () => {
  for (const change of [
    (state) => state.jobs.pop(),
    (state) => {
      state.jobs[0].run_attempt = 1;
    },
    (state) => {
      state.jobs[0].conclusion = "skipped";
    },
    (state) => {
      state.artifacts[0].expired = true;
    },
    (state) => {
      state.artifacts[0].workflow_run.head_sha = "e".repeat(40);
    },
    (state) => {
      state.artifacts[0].name = state.artifacts[1].name;
    },
    (state) => {
      state.total_count = 3;
    },
  ]) {
    const { provider, context } = fixture(change);
    await assert.rejects(provider.buildReadback(context), /Publication/);
  }
});

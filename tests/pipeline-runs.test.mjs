import test from "node:test";
import assert from "node:assert/strict";
import { githubPipelineRuns } from "../packages/core/providers/github/pipeline-runs.js";
import { identities } from "./helpers/business-attempt.mjs";

function fixture(event = "pull_request") {
  const f = identities();
  const run = {
    id: 100,
    run_attempt: 1,
    event,
    status: "in_progress",
    repository: { full_name: f.intent.repository },
    head_sha:
      event === "repository_dispatch" ? "f".repeat(40) : f.source.commit,
    referenced_workflows: [
      {
        path: "kungfu-systems/buildchain/.github/workflows/public-ops-pipeline.yml@v4",
        sha: "a".repeat(40),
      },
    ],
  };
  const jobs = [
    {
      id: 11,
      run_id: 100,
      run_attempt: 1,
      name: "consumer / Buildchain pipeline controller",
      status: "in_progress",
    },
    {
      id: 12,
      run_id: 100,
      run_attempt: 1,
      name: "consumer / Build product (linux-x64)",
      status: "completed",
      conclusion: "success",
    },
  ];
  const request = async (url) =>
    url.includes("/jobs?")
      ? { jobs: structuredClone(jobs) }
      : structuredClone(run);
  return {
    ...f,
    run,
    jobs,
    reader: githubPipelineRuns(request, f.intent.repository),
  };
}

test("provider readback binds one actual writer and every declared product job", async () => {
  const f = fixture();
  assert.equal(
    (await f.reader.writer(100, 1, "Buildchain pipeline controller")).jobId,
    "11",
  );
  assert.equal(
    (await f.reader.build(100, 1, f.source, ["linux-x64"])).outcome,
    "success",
  );
  await assert.rejects(
    f.reader.build(100, 1, f.source, ["linux-x64", "windows-x64"]),
    /one exact/,
  );
  f.jobs.push({ ...f.jobs[1], id: 13 });
  await assert.rejects(
    f.reader.build(100, 1, f.source, ["linux-x64"]),
    /one exact/,
  );
});

test("attempt wakes verify source-bound jobs without misidentifying the default branch HEAD", async () => {
  const f = fixture("repository_dispatch");
  const result = await f.reader.build(100, 1, f.source, ["linux-x64"]);
  assert.equal(result.source.commit, f.source.commit);
  assert.notEqual(result.source.commit, f.run.head_sha);
  f.run.run_attempt = 2;
  await assert.rejects(
    f.reader.build(100, 1, f.source, ["linux-x64"]),
    /attempt changed/,
  );
});

test("predecessor workflow completion is bounded and never accepted from a different rerun", async () => {
  const f = fixture();
  let polls = 0;
  await assert.rejects(
    f.reader.completed(100, 1, {
      sleep: async () => {
        polls++;
      },
    }),
    /bounded/,
  );
  assert.equal(polls, 20);
  f.run.status = "completed";
  assert.equal((await f.reader.completed(100, 1)).status, "completed");
  f.run.run_attempt = 2;
  await assert.rejects(f.reader.completed(100, 1), /attempt changed/);
});

import test from "node:test";
import { createHash } from "node:crypto";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
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
    head_repository: { full_name: f.intent.repository },
    path: ".github/workflows/buildchain.yml",
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
  const bytes = Buffer.from(
    consumerWorkflows()[".github/workflows/buildchain.yml"],
  );
  const file = {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    sha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
    content: bytes.toString("base64"),
  };
  const request = async (url) =>
    url.includes("/contents/")
      ? structuredClone(file)
      : url.includes("/jobs?")
        ? { jobs: structuredClone(jobs) }
        : structuredClone(run);
  return {
    ...f,
    run,
    jobs,
    file,
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

test("a referenced public entry cannot qualify lookalike jobs added to a modified caller", async () => {
  const f = fixture();
  const bytes = Buffer.from(
    Buffer.from(f.file.content, "base64").toString() +
      "# additional untrusted orchestration\n",
  );
  f.file.content = bytes.toString("base64");
  f.file.size = bytes.length;
  f.file.sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  await assert.rejects(
    f.reader.build(100, 1, f.source, ["linux-x64"]),
    /trusted minimal workflow/,
  );
});

test("a trusted recovery caller qualifies repaired product jobs without original-workflow equality", async () => {
  const f = fixture("workflow_dispatch");
  f.run.path = ".github/workflows/buildchain-recover.yml";
  f.run.referenced_workflows[0].path =
    "kungfu-systems/buildchain/.github/workflows/public-ops-recover.yml@v4";
  const bytes = Buffer.from(consumerWorkflows()[f.run.path]);
  f.file.content = bytes.toString("base64");
  f.file.size = bytes.length;
  f.file.sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assert.equal(
    (await f.reader.build(100, 1, f.source, ["linux-x64"])).outcome,
    "success",
  );
  f.run.head_repository.full_name = "fork/consumer";
  await assert.rejects(
    f.reader.build(100, 1, f.source, ["linux-x64"]),
    /fork boundary/,
  );
});

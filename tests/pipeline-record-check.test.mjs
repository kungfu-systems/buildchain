import test from "node:test";
import assert from "node:assert/strict";
import { projectRecordedPipelineCheck } from "../packages/core/workflow/pipeline/record-check.js";
import { recordDigest } from "../packages/core/release/discussion/envelope.js";
import { PIPELINE_ENTRY } from "../packages/core/consumer/contract/entries.js";

function fixture(current = false) {
  const repository = "acme/product",
    commit = "a".repeat(40);
  const source = { repository, commit, configPath: "buildchain.toml" };
  const platforms = ["linux-x64", "macos-arm64", "windows-x64"];
  const entry = {
    path: `kungfu-systems/buildchain/${PIPELINE_ENTRY}@v4-alpha`,
    sha: "b".repeat(40),
  };
  const run = {
    id: 10,
    run_attempt: 1,
    head_sha: commit,
    event: "pull_request",
    path: ".github/workflows/buildchain.yml",
    referenced_workflows: [entry],
    status: current ? "in_progress" : "completed",
    conclusion: current ? null : "success",
    check_suite_id: 30,
    repository: { id: 42, full_name: repository },
  };
  const job = {
    id: 20,
    run_id: 10,
    run_attempt: 1,
    name: "buildchain / execute / Record product build",
    status: run.status,
    conclusion: run.conclusion,
    check_run_url: `https://api.github.com/repos/${repository}/check-runs/20`,
  };
  const check = {
    id: 20,
    name: job.name,
    head_sha: commit,
    app: { id: 15368 },
    status: job.status,
    conclusion: job.conclusion,
    external_id: "original-job",
    check_suite: { id: 30 },
  };
  const suite = {
    id: 30,
    head_sha: commit,
    app: { id: 15368 },
    pull_requests: [{ head: { sha: commit, repo: { id: 42 } } }],
  };
  const body = {
    schema: "buildchain.pipeline-build-readback/v1",
    source,
    runId: 10,
    runAttempt: 1,
    entry,
    jobs: platforms.map((platform, i) => ({
      id: 100 + i,
      run_id: 10,
      run_attempt: 1,
      name: `Build product (${platform})`,
      status: "completed",
      conclusion: "success",
    })),
    outcome: "success",
  };
  const readback = { ...body, root: recordDigest(body) },
    writes = [];
  const host = {
    repository,
    runId: current ? 10 : 11,
    runAttempt: 1,
    writer: { jobId: "20" },
    source: {
      source: async () => ({
        identity: source,
        plan: { products: [{ platforms }] },
      }),
    },
    runs: {
      build: async () => structuredClone(readback),
      read: async () => ({ run, jobs: [job] }),
    },
    request: async (url, options) => {
      if (options) {
        writes.push({ url, ...options });
        return { ...check, ...options.body };
      }
      return structuredClone(url.includes("check-suites") ? suite : check);
    },
  };
  return { source, readback, host, run, job, check, suite, writes };
}

test("recovery projects a real successful PR aggregate without rewriting execution or conclusion", async () => {
  const f = fixture();
  const recovered = {
    source: f.source,
    outcome: "success",
    segments: [{ readback: f.readback }],
  };
  const result = await projectRecordedPipelineCheck(
    f.source,
    recovered,
    f.host,
  );
  assert.equal(result.after.id, 20);
  assert.equal(result.after.external_id, "original-job");
  assert.deepEqual(f.writes, [
    {
      url: "/repos/acme/product/check-runs/20",
      method: "PATCH",
      body: { name: "check" },
    },
  ]);
  assert.equal(result.before.conclusion, result.after.conclusion);
});

test("normal active aggregate remains in progress and naturally owns its final outcome", async () => {
  const f = fixture(true);
  const result = await projectRecordedPipelineCheck(
    f.source,
    f.readback,
    f.host,
  );
  assert.equal(result.after.status, "in_progress");
  assert.equal(result.after.conclusion, null);
  assert.deepEqual(f.writes[0].body, { name: "check" });
});

for (const [name, change] of [
  [
    "source",
    (f) => {
      f.run.head_sha = "c".repeat(40);
    },
  ],
  [
    "failed aggregate",
    (f) => {
      f.job.conclusion = "failure";
    },
  ],
  [
    "failed original run",
    (f) => {
      f.run.conclusion = "failure";
    },
  ],
  [
    "provider job",
    (f) => {
      f.job.run_id++;
    },
  ],
  [
    "job URL",
    (f) => {
      f.job.check_run_url += "0";
    },
  ],
  [
    "App",
    (f) => {
      f.check.app.id++;
    },
  ],
  [
    "suite",
    (f) => {
      f.check.check_suite.id++;
    },
  ],
  [
    "PR association",
    (f) => {
      f.suite.pull_requests = [];
    },
  ],
  [
    "provider conclusion",
    (f) => {
      f.check.conclusion = "neutral";
    },
  ],
  [
    "reverified result",
    (f) => {
      f.host.runs.build = async () => ({ ...f.readback, outcome: "failure" });
    },
  ],
])
  test(`recorder rejects changed ${name} without a metadata write`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(
      projectRecordedPipelineCheck(f.source, f.readback, f.host),
    );
    assert.equal(f.writes.length, 0);
  });

test("partial platform segments cannot relabel an original incomplete aggregate", async () => {
  const f = fixture();
  const { root, ...body } = f.readback;
  body.jobs = body.jobs.slice(0, 1);
  const partial = { ...body, root: recordDigest(body) };
  assert.equal(
    await projectRecordedPipelineCheck(f.source, partial, f.host),
    null,
  );
  assert.equal(f.writes.length, 0);
});

test("dispatch-only build retains diagnostics without claiming an eligible PR job", async () => {
  const f = fixture();
  f.run.event = "workflow_dispatch";
  assert.equal(
    await projectRecordedPipelineCheck(f.source, f.readback, f.host),
    null,
  );
  assert.equal(f.writes.length, 0);
});

test("provider response cannot silently change original execution evidence", async () => {
  const f = fixture(),
    request = f.host.request;
  f.host.request = async (url, options) => {
    const result = await request(url, options);
    return options ? { ...result, external_id: "different" } : result;
  };
  await assert.rejects(
    projectRecordedPipelineCheck(f.source, f.readback, f.host),
    /execution evidence/,
  );
});

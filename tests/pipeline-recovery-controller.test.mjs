import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recoveryBuildFixture } from "./helpers/pipeline-recovery.mjs";
import { consumerWorkflows } from "../packages/core/consumer/contract/entries.js";
import { controlPipelineRecovery } from "../packages/core/workflow/pipeline/recovery-controller.js";

async function fixture() {
  const f = await recoveryBuildFixture({ open: false });
  const run = {
    id: 300,
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null,
    repository: { full_name: f.host.repository },
    head_repository: { full_name: f.host.repository },
    head_sha: "8".repeat(40),
    path: ".github/workflows/buildchain-recover.yml",
    referenced_workflows: [
      {
        path: `kungfu-systems/buildchain/${f.entry.workflow}@v4`,
        sha: f.entry.sha,
      },
    ],
  };
  const oldRun = {
    ...run,
    id: 100,
    status: "completed",
    conclusion: "failure",
  };
  f.host.runs.read = async (id) => ({
    run: structuredClone(id === 300 ? run : oldRun),
    jobs: [],
  });
  f.host.selection.source.repository = f.host.repository;
  const bytes = Buffer.from(consumerWorkflows()[run.path]);
  const request = f.host.request;
  f.host.request = async (url, options) =>
    url.includes("/contents/.github/workflows/")
      ? {
          type: "file",
          encoding: "base64",
          size: bytes.length,
          content: bytes.toString("base64"),
          sha: createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex"),
        }
      : request(url, options);
  return { ...f, run, oldRun };
}

test("the sole attempt selector opens a new source-bound recovery and repeated requests retain that successor", async () => {
  const f = await fixture();
  const original = f.selected.observed.attempt;
  const before = structuredClone(f.snapshot().records);
  const result = await controlPipelineRecovery(original, f.entry.sha, f.host);
  assert.equal(result.operation, "build");
  assert.deepEqual(
    result.context.platforms.map((item) => item.platform),
    ["windows-x64"],
  );
  assert.notEqual(result.attempt, original);
  assert.equal(f.observed().history.at(-1).identity.predecessor, original);
  assert.deepEqual(f.snapshot().records.slice(0, before.length), before);
  const opened = structuredClone(f.snapshot().records);
  const duplicate = await controlPipelineRecovery(
    original,
    f.entry.sha,
    f.host,
  );
  assert.equal(duplicate.operation, "wait");
  assert.equal(duplicate.attempt, result.attempt);
  assert.match(duplicate.reason, /already selected/);
  assert.deepEqual(f.snapshot().records, opened);
});

test("recovery neither forks active predecessor runs nor executes a changed protected source", async () => {
  const f = await fixture();
  const before = structuredClone(f.snapshot().records);
  f.oldRun.status = "in_progress";
  f.oldRun.conclusion = null;
  const result = await controlPipelineRecovery(
    f.selected.observed.attempt,
    f.entry.sha,
    f.host,
  );
  assert.equal(result.operation, "wait");
  assert.match(result.reason, /still active/);
  assert.deepEqual(f.snapshot().records, before);
  f.oldRun.status = "completed";
  f.oldRun.conclusion = "cancelled";
  f.admission.live.baseCommit = "9".repeat(40);
  await assert.rejects(
    controlPipelineRecovery(f.selected.observed.attempt, f.entry.sha, f.host),
    /superseded or rebased/,
  );
  assert.deepEqual(f.snapshot().records, before);
});

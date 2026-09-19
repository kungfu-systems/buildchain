import test from "node:test";
import assert from "node:assert/strict";
import {
  githubPipelineWorker,
  PIPELINE_WORKER,
} from "../packages/core/providers/github/pipeline-worker.js";
import { identities } from "./helpers/business-attempt.mjs";

function fixture() {
  const f = identities();
  const current = {
    intent: f.intent,
    identity: f.attempt,
    generation: f.generation,
  };
  const warrant = {
    candidateId: "candidate",
    fencingToken: "fence",
    generation: 2,
  };
  const binding = {
    schema: PIPELINE_WORKER,
    repository: f.intent.repository,
    attempt: f.attempt.id,
    generation: f.generation.id,
    sourceHead: f.source.commit,
    candidateId: warrant.candidateId,
    fencingToken: warrant.fencingToken,
    leaseGeneration: 2,
    runId: 100,
    runAttempt: 1,
    nativeJobId: 101,
    sealJobId: 102,
  };
  const run = {
    id: 100,
    run_attempt: 1,
    repository: { full_name: f.intent.repository },
    status: "completed",
    conclusion: "success",
  };
  const jobs = [101, 102].map((id) => ({
    id,
    run_id: 100,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    completed_at: "2026-09-12T00:00:00Z",
  }));
  const provider = githubPipelineWorker(async (url) =>
    url.includes("/jobs?") ? { jobs } : { ...run },
  );
  return { current, warrant, binding, run, jobs, provider };
}

test("terminal worker readback covers exact run attempt and both separate jobs", async () => {
  const f = fixture();
  const result = await f.provider.observe(f.binding, f.current, f.warrant);
  assert.equal(result.status, "completed");
  f.jobs[0].status = "in_progress";
  assert.equal(
    (await f.provider.observe(f.binding, f.current, f.warrant)).status,
    "in_progress",
  );
  f.jobs[0].status = "completed";
  f.run.run_attempt = 2;
  await assert.rejects(
    f.provider.observe(f.binding, f.current, f.warrant),
    /terminality is unproved/,
  );
});

test("a different candidate, generation or duplicate job cannot prove worker stop", async () => {
  const f = fixture();
  await assert.rejects(
    f.provider.observe(f.binding, f.current, { ...f.warrant, generation: 3 }),
    /active pipeline Warrant/,
  );
  await assert.rejects(
    f.provider.observe(
      { ...f.binding, candidateId: "another" },
      f.current,
      f.warrant,
    ),
    /active pipeline Warrant/,
  );
  f.jobs.push(f.jobs[0]);
  await assert.rejects(
    f.provider.observe(f.binding, f.current, f.warrant),
    /exact job identity drift/,
  );
});

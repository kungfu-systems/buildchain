import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcilePipeline,
  pipelineCandidateRoot,
} from "../packages/core/workflow/pipeline/reconcile.js";
import { identities } from "./helpers/business-attempt.mjs";

function fixture() {
  const f = identities();
  const candidate = {
    candidateId: "candidate",
    pullRequestNumber: 23,
    sourceHead: f.source.commit,
    sourceRoot: pipelineCandidateRoot({
      intent: f.intent,
      generation: f.generation,
      identity: f.attempt,
    }),
    status: "queued",
  };
  return {
    current: {
      intent: f.intent,
      generation: f.generation,
      identity: f.attempt,
    },
    live: {
      pullRequest: 23,
      source: f.source,
      baseCommit: f.generation.baseCommit,
      state: "open",
      merged: false,
      ready: true,
      draft: false,
    },
    queue: {
      repository: f.intent.repository,
      protectedBase: f.intent.source.targetBranch,
      candidates: [candidate],
      activeWarrant: { candidateId: "another-candidate" },
    },
    worker: { status: "in_progress" },
    evidence: {
      build: { sourceHead: f.source.commit, outcome: "success" },
      review: true,
      checks: true,
    },
  };
}

test("closing a queued candidate never settles another active Warrant", () => {
  const f = fixture();
  f.live.state = "closed";
  const before = structuredClone(f);
  const result = reconcilePipeline(f);
  assert.equal(result.operation, "cancel-queued");
  assert.equal(result.candidateId, "candidate");
  assert.deepEqual(f, before);
  assert.deepEqual(reconcilePipeline(f), result);
});

test("a terminal candidate from an earlier same-source attempt cannot prevent a fresh reservation", () => {
  const f = fixture();
  f.queue.candidates[0].sourceRoot = `sha256:${"9".repeat(64)}`;
  f.queue.candidates[0].status = "cancelled";
  f.queue.activeWarrant = null;
  assert.equal(reconcilePipeline(f).operation, "reserve");
});

test("active cancellation and expiry require terminal worker evidence", () => {
  const f = fixture();
  f.live.state = "closed";
  f.queue.activeWarrant = {
    candidateId: "candidate",
    expiresAt: "2000-01-01T00:00:00Z",
  };
  assert.equal(reconcilePipeline(f).operation, "stop-worker");
  f.worker = null;
  assert.equal(reconcilePipeline(f).operation, "stop-worker");
  f.worker = { status: "completed" };
  assert.equal(reconcilePipeline(f).operation, "settle-cancelled");
});

test("source drift, base advancement and dequeue cancel old work before recovery", () => {
  for (const change of [
    (f) => {
      f.live.source = { ...f.live.source, commit: "f".repeat(40) };
    },
    (f) => {
      f.live.baseCommit = "f".repeat(40);
    },
    (f) => {
      f.live.dequeued = true;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(reconcilePipeline(f).operation, "cancel-queued");
  }
});

test("native failure, review and terminal readback cannot become merge authority", () => {
  const f = fixture();
  f.queue.activeWarrant = { candidateId: "candidate", phase: "qualified" };
  delete f.evidence.review;
  assert.equal(
    reconcilePipeline(f).reason,
    "independent-protected-review-required",
  );
  f.evidence.review = true;
  f.evidence.build.outcome = "failure";
  assert.equal(reconcilePipeline(f).operation, "stop-worker");
  f.worker.status = "completed";
  assert.equal(reconcilePipeline(f).operation, "settle-failure");
  f.live.state = "closed";
  f.live.merged = true;
  assert.equal(reconcilePipeline(f).operation, "wait");
  f.evidence.integration = { sourceHead: f.live.source.commit };
  assert.equal(reconcilePipeline(f).operation, "settle-merged");
  f.queue.candidates[0].status = "merged";
  assert.equal(reconcilePipeline(f).operation, "wait");
  f.evidence.settlement = { candidateId: "candidate" };
  assert.equal(reconcilePipeline(f).operation, "wake-publication");
});

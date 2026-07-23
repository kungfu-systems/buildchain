import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BUILDCHAIN_CANDIDATE_TIMELINE_CONTRACT,
  createCandidateTimeline,
  formatCandidateTimelineReport,
} from "../packages/core/candidate-timeline.js";

const candidate = {
  repository: "kungfu-systems/kungfu",
  baseBranch: "dev/v4/v4.0",
  sourceSha: "a".repeat(40),
  pullRequest: 1262,
};

function event(id, attemptId, phase, startSecond, endSecond, extras = {}) {
  return {
    id,
    attempt: {
      id: attemptId,
      index: Number(attemptId.slice(-1)),
      kind: "merge-queue",
    },
    phase,
    status: "success",
    timing: {
      startedAt: `2026-07-23T00:00:${String(startSecond).padStart(2, "0")}.000Z`,
      completedAt: `2026-07-23T00:00:${String(endSecond).padStart(2, "0")}.000Z`,
      clock: "provider-wall",
      precisionMs: 1000,
    },
    attributes: { sourceSha: candidate.sourceSha },
    ...extras,
  };
}

test("candidate timeline never sums nested or parallel spans", () => {
  const timeline = createCandidateTimeline({
    candidate,
    generatedAt: "2026-07-23T01:00:00.000Z",
    events: [
      event("job", "mq-0", "authoritative-build", 0, 20),
      event("build", "mq-0", "authoritative-build", 2, 14, {
        span: { id: "build", parentId: "job" },
      }),
      event("wire", "mq-0", "sdk-wire", 10, 18, {
        span: { id: "wire", parentId: "job" },
      }),
    ],
  });
  assert.equal(timeline.contract, BUILDCHAIN_CANDIDATE_TIMELINE_CONTRACT);
  assert.equal(timeline.attempts[0].criticalPath.durationMs, 20_000);
  assert.equal(timeline.attempts[0].criticalPath.activeIntervalUnionMs, 20_000);
  assert.equal(
    timeline.attempts[0].phases["authoritative-build"].intervalUnionMs,
    20_000,
  );
  assert.equal(timeline.attempts[0].phases["sdk-wire"].intervalUnionMs, 8_000);
});

test("candidate timeline exposes lane skew, cache state, and a falsifiable target", () => {
  const timeline = createCandidateTimeline({
    candidate,
    events: [
      event("partition-0-build", "mq-0", "core-build", 0, 20, {
        category: "workflow-step",
        attributes: {
          sourceSha: candidate.sourceSha,
          laneId: "affected-native/partition-0",
        },
        gate: {
          id: "source.changed-scope",
          platform: "linux",
          partition: 0,
        },
      }),
      event("partition-1-build", "mq-0", "native-build", 0, 8, {
        category: "workflow-step",
        attributes: {
          sourceSha: candidate.sourceSha,
          laneId: "affected-native/partition-1",
        },
        gate: {
          id: "source.changed-scope",
          platform: "linux",
          partition: 1,
        },
      }),
      {
        id: "compiler-cache",
        attempt: { id: "mq-0", index: 0, kind: "merge-queue" },
        phase: "cache-validation",
        category: "cache-evidence",
        status: "not-required",
        cache: { layer: "compiler", outcome: "hit-exact" },
        criticalPathEligible: false,
        attributes: { sourceSha: candidate.sourceSha },
      },
    ],
  });
  const optimization = timeline.attempts[0].optimization;
  assert.equal(optimization.laneSkew.measuredLaneCount, 2);
  assert.equal(
    optimization.laneSkew.slowestLane,
    "affected-native/partition-0",
  );
  assert.equal(optimization.laneSkew.skewMs, 12_000);
  assert.deepEqual(optimization.cacheOutcomes, { "compiler:hit-exact": 1 });
  assert.equal(
    optimization.nextOptimizationTarget.eventId,
    "partition-0-build",
  );
  assert.match(
    optimization.nextOptimizationTarget.falsifier,
    /same source-bound cohort/,
  );
  assert.match(
    formatCandidateTimelineReport(timeline),
    /next-target=partition-0-build 20000ms/,
  );
});

test("candidate timeline isolates retries into independent attempts", () => {
  const timeline = createCandidateTimeline({
    candidate,
    events: [
      event("first", "mq-0", "queue-residence", 0, 10, { status: "failure" }),
      event("second", "mq-1", "queue-residence", 20, 30),
    ],
  });
  assert.equal(timeline.attempts.length, 2);
  assert.deepEqual(
    timeline.attempts.map((attempt) => attempt.criticalPath.durationMs),
    [10_000, 10_000],
  );
  assert.equal(timeline.summary.criticalPathScope, "per-attempt-only");
});

test("candidate timeline preserves non-executed states without fake timings", () => {
  const timeline = createCandidateTimeline({
    candidate,
    events: [
      event("preflight", "mq-0", "preflight", 0, 2),
      {
        id: "wire-rust",
        attempt: { id: "mq-0", index: 0, kind: "merge-queue" },
        phase: "sdk-wire-rust",
        status: "dependency-blocked",
        attributes: { sourceSha: candidate.sourceSha },
      },
      {
        id: "not-required",
        attempt: { id: "mq-0", index: 0, kind: "merge-queue" },
        phase: "cache-save",
        status: "not-required",
        attributes: { sourceSha: candidate.sourceSha },
      },
    ],
  });
  assert.equal(timeline.summary.measuredEventCount, 1);
  assert.equal(timeline.attempts[0].status, "observed");
  assert.equal(timeline.attempts[0].phases["sdk-wire-rust"].intervalUnionMs, 0);
});

test("candidate timeline rejects terminal execution without an interval", () => {
  assert.throws(
    () =>
      createCandidateTimeline({
        candidate,
        events: [
          {
            id: "gate",
            attempt: { id: "mq-0" },
            phase: "gate",
            status: "success",
          },
        ],
      }),
    /requires a measured interval/,
  );
});

test("compact report makes precision gaps visible", () => {
  const timeline = createCandidateTimeline({
    candidate,
    events: [event("preflight", "mq-0", "preflight", 0, 2)],
  });
  const report = formatCandidateTimelineReport(timeline);
  assert.match(report, /attempt=mq-0/);
  assert.match(report, /phase=preflight union=2000ms measured=1\/1/);
});

test("candidate timeline CLI writes the machine artifact and compact report", () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-candidate-timeline-"),
  );
  try {
    const output = path.join(temporary, "timeline.json");
    const input = JSON.stringify({
      candidate,
      generatedAt: "2026-07-23T01:00:00.000Z",
      events: [event("preflight", "mq-0", "preflight", 0, 2)],
    });
    const result = spawnSync(
      process.execPath,
      [
        "bin/buildchain.mjs",
        "candidate",
        "timeline",
        "--input",
        input,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /attempt=mq-0/);
    assert.equal(
      JSON.parse(fs.readFileSync(output, "utf8")).contract,
      BUILDCHAIN_CANDIDATE_TIMELINE_CONTRACT,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

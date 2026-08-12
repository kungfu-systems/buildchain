import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  advanceDevDeliveryQualificationBase,
  cancelDevDeliveryQualificationCandidate,
  createDevDeliveryQualificationState,
  heartbeatDevDeliveryQualificationLane,
  issueDevDeliveryLandingWarrant,
  normalizeDevDeliveryQualificationState,
  observeDevDeliveryQualificationState,
  recoverExpiredDevDeliveryLandingWarrant,
  scheduleDevDeliveryQualificationLanes,
  settleDevDeliveryLandingWarrant,
  settleDevDeliveryQualificationLane,
  submitDevDeliveryQualificationCandidate,
} from "../packages/core/dev-delivery-qualification-lanes.js";
import { devDeliveryContentRoot } from "../packages/core/dev-delivery-common.js";
import { runParallelQualificationDogfood } from "../scripts/dev-delivery-parallel-dogfood.mjs";

const SHA = {
  base: "a".repeat(40),
  advanced: "b".repeat(40),
};
const root = (label) => devDeliveryContentRoot({ label });

function initial(policy = {}) {
  return createDevDeliveryQualificationState({
    repository: "kungfu-systems/buildchain",
    protectedBase: "dev/v3/v3.0",
    protectedBaseHead: SHA.base,
    policy: {
      maxQualificationLanes: 2,
      laneLeaseSeconds: 60,
      warrantLeaseSeconds: 60,
      ...policy,
    },
    now: "2026-08-12T00:00:00Z",
  });
}

function candidate(number, overrides = {}) {
  const digit = ((number % 8) + 1).toString(16);
  return {
    pullRequestNumber: number,
    sourceHead: digit.repeat(40),
    assignmentRoot: root(`assignment-${number}`),
    nativeProofRoot: root(`native-proof-${number}`),
    sourceIdentityRoot: root(`source-${number}`),
    sourcePatchRoot: root(`patch-${number}`),
    planRoot: root(`plan-${number}`),
    closureRoot: root(`closure-${number}`),
    dependencyRoot: root(`dependency-${number}`),
    toolchainRoot: root("toolchain"),
    delta: "disjoint",
    deltaEvidenceRoot: root(`delta-${number}`),
    conflictKeys: [`assignment/${number}`],
    ...overrides,
  };
}

function submit(state, number, at, overrides = {}) {
  return submitDevDeliveryQualificationCandidate(
    state,
    candidate(number, overrides),
    { now: at },
  );
}

function settleQualified(state, lane, at, label = lane.candidateId) {
  return settleDevDeliveryQualificationLane(
    state,
    {
      laneId: lane.laneId,
      fencingToken: lane.fencingToken,
      generation: lane.generation,
      outcome: "qualified",
      proofRoot: root(`qualification-${label}`),
    },
    { now: at },
  );
}

test("bounded production lanes qualify two disjoint PRs concurrently", () => {
  let state = submit(initial(), 2501, "2026-08-12T00:00:01Z").state;
  state = submit(state, 2502, "2026-08-12T00:00:02Z").state;
  state = submit(state, 2503, "2026-08-12T00:00:03Z").state;

  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:04Z",
  });
  assert.equal(scheduled.lanes.length, 2);
  assert.equal(
    new Set(scheduled.lanes.map((lane) => lane.candidateId)).size,
    2,
  );
  assert.equal(
    scheduled.state.candidates.filter((entry) => entry.status === "queued")
      .length,
    1,
  );
  const observation = observeDevDeliveryQualificationState(scheduled.state, {
    now: "2026-08-12T00:00:05Z",
  });
  assert.equal(observation.activeQualificationLaneCount, 2);
  assert.equal(observation.activeLandingWarrantCount, 0);
  assert.equal(observation.telemetry.maxObservedQualificationLanes, 2);
});

test("slow earlier work does not block a later disjoint fast candidate or starve", () => {
  let state = submit(initial(), 2510, "2026-08-12T00:00:01Z").state;
  state = submit(state, 2511, "2026-08-12T00:00:02Z").state;
  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:03Z",
  });
  const [slow, fast] = scheduled.lanes;

  const fastDone = settleQualified(
    scheduled.state,
    fast,
    "2026-08-12T00:00:10Z",
    "fast",
  );
  const firstWarrant = issueDevDeliveryLandingWarrant(fastDone.state, {
    now: "2026-08-12T00:00:11Z",
  });
  assert.equal(firstWarrant.warrant.candidateId, fast.candidateId);
  assert.equal(firstWarrant.state.lanes.length, 1);

  const landedFast = settleDevDeliveryLandingWarrant(
    firstWarrant.state,
    {
      fencingToken: firstWarrant.warrant.fencingToken,
      generation: firstWarrant.warrant.generation,
      outcome: "landed",
      evidenceRoot: root("fast-protected-dev-readback"),
    },
    { now: "2026-08-12T00:00:20Z" },
  );
  const slowDone = settleQualified(
    landedFast.state,
    slow,
    "2026-08-12T00:00:30Z",
    "slow",
  );
  const secondWarrant = issueDevDeliveryLandingWarrant(slowDone.state, {
    now: "2026-08-12T00:00:31Z",
  });
  assert.equal(secondWarrant.warrant.candidateId, slow.candidateId);
  assert.equal(secondWarrant.state.telemetry.maxObservedLandingWarrants, 1);
});

test("overlapping and unknown deltas fail closed without occupying a lane", () => {
  let state = submit(initial(), 2520, "2026-08-12T00:00:01Z", {
    delta: "overlapping",
  }).state;
  state = submit(state, 2521, "2026-08-12T00:00:02Z", {
    delta: "unknown",
  }).state;
  state = submit(state, 2522, "2026-08-12T00:00:03Z").state;
  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:04Z",
  });
  assert.equal(scheduled.lanes.length, 1);
  assert.deepEqual(
    scheduled.state.candidates.slice(0, 2).map((entry) => entry.status),
    ["failed", "failed"],
  );
  assert.match(
    scheduled.state.candidates[0].terminal.reason,
    /overlapping-delta-fails-closed/u,
  );
  assert.match(
    scheduled.state.candidates[1].terminal.reason,
    /unknown-delta-fails-closed/u,
  );
});

test("conflicting queued work waits while a disjoint later candidate progresses", () => {
  let state = submit(initial(), 2530, "2026-08-12T00:00:01Z", {
    conflictKeys: ["packages/core"],
  }).state;
  state = submit(state, 2531, "2026-08-12T00:00:02Z", {
    conflictKeys: ["packages/core"],
  }).state;
  state = submit(state, 2532, "2026-08-12T00:00:03Z", {
    conflictKeys: ["docs"],
  }).state;
  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:04Z",
  });
  assert.deepEqual(
    scheduled.lanes.map(
      (lane) =>
        scheduled.state.candidates.find(
          (entry) => entry.candidateId === lane.candidateId,
        ).pullRequestNumber,
    ),
    [2530, 2532],
  );
  assert.equal(scheduled.state.candidates[1].status, "queued");
});

test("heartbeat, lease expiry, runner loss, and retry converge with fencing", () => {
  const submitted = submit(initial(), 2540, "2026-08-12T00:00:01Z");
  const scheduled = scheduleDevDeliveryQualificationLanes(submitted.state, {
    now: "2026-08-12T00:00:02Z",
  });
  const first = scheduled.lanes[0];
  const heartbeat = heartbeatDevDeliveryQualificationLane(
    scheduled.state,
    first,
    { now: "2026-08-12T00:00:30Z" },
  );
  assert.equal(heartbeat.lane.heartbeatAt, "2026-08-12T00:00:30.000Z");

  const recovered = scheduleDevDeliveryQualificationLanes(heartbeat.state, {
    now: "2026-08-12T00:02:00Z",
  });
  const second = recovered.lanes[0];
  assert.notEqual(second.fencingToken, first.fencingToken);
  assert.equal(recovered.state.telemetry.recoveredLaneCount, 1);
  assert.throws(
    () =>
      heartbeatDevDeliveryQualificationLane(recovered.state, first, {
        now: "2026-08-12T00:02:01Z",
      }),
    /qualification lane is not active|stale qualification lane/u,
  );
  assert.throws(
    () => settleQualified(heartbeat.state, first, "2026-08-12T00:02:01Z"),
    /qualification lane lease expired/u,
  );

  const runnerLoss = settleDevDeliveryQualificationLane(
    recovered.state,
    {
      ...second,
      outcome: "failed",
      failureClass: "runner-loss",
      evidenceRoot: root("runner-loss"),
    },
    { now: "2026-08-12T00:02:02Z" },
  );
  assert.equal(runnerLoss.receipt.action, "retry-converged");
  assert.equal(runnerLoss.receipt.evidenceRoot, root("runner-loss"));
  assert.equal(runnerLoss.state.candidates[0].status, "queued");
  assert.equal(runnerLoss.state.candidates[0].attempts, 2);
});

test("exact-head change retains native proof but invalidates source qualification", () => {
  const firstInput = candidate(2550);
  const first = submitDevDeliveryQualificationCandidate(initial(), firstInput, {
    now: "2026-08-12T00:00:01Z",
  });
  const moved = submitDevDeliveryQualificationCandidate(
    first.state,
    {
      ...firstInput,
      sourceHead: "f".repeat(40),
      headChangeEvidenceRoot: root("head-change"),
    },
    { now: "2026-08-12T00:00:02Z" },
  );
  assert.equal(moved.receipt.nativeProofRetained, true);
  assert.equal(moved.state.candidates[0].status, "superseded");
  assert.equal(moved.state.candidates[1].status, "queued");
  assert.equal(
    moved.state.candidates[1].nativeProofRoot,
    first.state.candidates[0].nativeProofRoot,
  );
  assert.equal(moved.state.candidates[1].qualificationProof, null);
});

test("same exact-head rejects evidence drift instead of treating it as a duplicate", () => {
  const firstInput = candidate(2551);
  const first = submitDevDeliveryQualificationCandidate(initial(), firstInput, {
    now: "2026-08-12T00:00:01Z",
  });
  assert.throws(
    () =>
      submitDevDeliveryQualificationCandidate(
        first.state,
        { ...firstInput, nativeProofRoot: root("drifted-native-proof") },
        { now: "2026-08-12T00:00:02Z" },
      ),
    /duplicate qualification candidate evidence drift/u,
  );
});

test("cancellation closes a queued or qualifying lane without affecting its peer", () => {
  let state = submit(initial(), 2555, "2026-08-12T00:00:01Z").state;
  state = submit(state, 2556, "2026-08-12T00:00:02Z").state;
  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:03Z",
  });
  const cancelledLane = scheduled.lanes[0];
  const cancelled = cancelDevDeliveryQualificationCandidate(
    scheduled.state,
    {
      candidateId: cancelledLane.candidateId,
      sourceHead: cancelledLane.sourceHead,
      evidenceRoot: root("cancelled-run"),
      reason: "workflow cancelled",
    },
    { now: "2026-08-12T00:00:04Z" },
  );
  assert.equal(cancelled.receipt.action, "qualification-candidate-cancelled");
  assert.equal(cancelled.state.lanes.length, 1);
  assert.equal(cancelled.state.candidates[0].status, "cancelled");
  assert.equal(cancelled.state.candidates[1].status, "qualifying");
});

test("Dev advance reuses rooted disjoint proof and fails closed otherwise", () => {
  let state = submit(initial(), 2560, "2026-08-12T00:00:01Z").state;
  state = submit(state, 2561, "2026-08-12T00:00:02Z").state;
  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:03Z",
  });
  const firstDone = settleQualified(
    scheduled.state,
    scheduled.lanes[0],
    "2026-08-12T00:00:04Z",
  );
  const secondDone = settleQualified(
    firstDone.state,
    scheduled.lanes[1],
    "2026-08-12T00:00:05Z",
  );
  const [first, second] = secondDone.state.candidates;
  const advanced = advanceDevDeliveryQualificationBase(
    secondDone.state,
    {
      protectedBaseHead: SHA.advanced,
      candidateDeltas: {
        [first.candidateId]: "disjoint",
        [second.candidateId]: "unknown",
      },
      evidenceRoot: root("dev-advance"),
    },
    { now: "2026-08-12T00:00:06Z" },
  );
  assert.equal(advanced.state.candidates[0].status, "qualified");
  assert.equal(
    advanced.state.candidates[0].qualificationProof.protectedBaseHead,
    SHA.advanced,
  );
  assert.equal(advanced.state.candidates[1].status, "failed");
  assert.equal(advanced.state.telemetry.reusedProofCount, 1);
  assert.equal(advanced.receipt.action, "qualification-base-advanced");
  assert.equal(advanced.receipt.evidenceRoot, root("dev-advance"));
});

test("duplicate controllers are fenced by exact expected-old root", () => {
  const submitted = submit(initial(), 2570, "2026-08-12T00:00:01Z");
  const expectedStateRoot = submitted.state.stateRoot;
  const winner = scheduleDevDeliveryQualificationLanes(submitted.state, {
    now: "2026-08-12T00:00:02Z",
    expectedStateRoot,
  });
  assert.throws(
    () =>
      scheduleDevDeliveryQualificationLanes(winner.state, {
        now: "2026-08-12T00:00:03Z",
        expectedStateRoot,
      }),
    /stale qualification controller expected-old state root/u,
  );
});

test("only one Landing Warrant exists and retry reuses sealed proof", () => {
  let state = submit(initial(), 2580, "2026-08-12T00:00:01Z").state;
  state = submit(state, 2581, "2026-08-12T00:00:02Z").state;
  const scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:03Z",
  });
  const one = settleQualified(
    scheduled.state,
    scheduled.lanes[0],
    "2026-08-12T00:00:04Z",
  );
  const two = settleQualified(
    one.state,
    scheduled.lanes[1],
    "2026-08-12T00:00:05Z",
  );
  const issued = issueDevDeliveryLandingWarrant(two.state, {
    now: "2026-08-12T00:00:06Z",
  });
  const duplicate = issueDevDeliveryLandingWarrant(issued.state, {
    now: "2026-08-12T00:00:07Z",
  });
  assert.equal(duplicate.action, "active-warrant-retained");
  assert.deepEqual(duplicate.warrant, issued.warrant);
  assert.equal(duplicate.state.telemetry.maxObservedLandingWarrants, 1);
  assert.throws(
    () =>
      normalizeDevDeliveryQualificationState({
        ...duplicate.state,
        landingWarrant: {
          ...duplicate.state.landingWarrant,
          sourceHead: "f".repeat(40),
        },
        stateRoot: undefined,
      }),
    /Landing Warrant must bind one landing candidate/u,
  );
  assert.throws(
    () =>
      normalizeDevDeliveryQualificationState({
        ...duplicate.state,
        telemetry: {
          ...duplicate.state.telemetry,
          maxObservedLandingWarrants: 2,
        },
        stateRoot: undefined,
      }),
    /more than one Landing Warrant/u,
  );

  const retried = settleDevDeliveryLandingWarrant(
    duplicate.state,
    {
      fencingToken: issued.warrant.fencingToken,
      generation: issued.warrant.generation,
      outcome: "retry",
      evidenceRoot: root("merge-group-runner-loss"),
    },
    { now: "2026-08-12T00:00:08Z" },
  );
  const candidateAfterRetry = retried.state.candidates.find(
    (entry) => entry.candidateId === issued.warrant.candidateId,
  );
  assert.equal(candidateAfterRetry.status, "qualified");
  assert.ok(candidateAfterRetry.qualificationProof.reusable);
  assert.equal(retried.state.telemetry.reusedProofCount, 1);

  const reissued = issueDevDeliveryLandingWarrant(retried.state, {
    now: "2026-08-12T00:00:09Z",
  });
  assert.throws(
    () =>
      settleDevDeliveryLandingWarrant(
        reissued.state,
        {
          fencingToken: reissued.warrant.fencingToken,
          generation: reissued.warrant.generation,
          outcome: "landed",
          evidenceRoot: root("late-protected-dev-readback"),
        },
        { now: "2026-08-12T00:02:00Z" },
      ),
    /Landing Warrant lease expired/u,
  );
  const expired = recoverExpiredDevDeliveryLandingWarrant(
    reissued.state,
    { evidenceRoot: root("landing-lease-expiry") },
    { now: "2026-08-12T00:02:00Z" },
  );
  assert.equal(expired.receipt.action, "landing-warrant-settled");
  assert.equal(expired.receipt.outcome, "retry");
  assert.equal(expired.state.landingWarrant, null);
});

test("Buildchain-only dogfood report passes model checks but does not forge hosted acceptance", () => {
  const report = runParallelQualificationDogfood();
  assert.ok(Object.values(report.checks).every(Boolean));
  assert.equal(report.hostedContext.hosted, false);
  assert.equal(report.hostedAcceptance.status, "local-model-only");
  assert.equal(report.hostedAcceptance.protectedDevExactReadback, null);
  assert.equal(report.hostedAcceptance.mergeGroupEvidence, null);
  assert.deepEqual(report.hostedAcceptance.fiveChildAssignments, []);
  assert.equal(report.hostedAcceptance.reviewed, false);
  assert.equal(report.hostedAcceptance.consumerPilotDecision, "not-authorized");
  assert.equal(report.convergenceEvidence.expiredWorkerFenced, true);
  assert.match(
    report.convergenceEvidence.heartbeatFailure.evidenceRoot,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.equal(
    report.convergenceEvidence.reusableProofRoot,
    report.convergenceEvidence.reusedProofRoot,
  );
  assert.match(
    report.hostedContext.reusableWorkflow,
    /^kungfu-systems\/buildchain\/\.github\/workflows\/dev-pr-auto-merge\.yml@dev\/v3\/v3\.0$/u,
  );
});

test("Buildchain self-dogfood calls the checked-in reusable workflow through an exact remote ref", () => {
  const rootPath = path.resolve(import.meta.dirname, "..");
  const caller = fs.readFileSync(
    path.join(rootPath, ".github/workflows/buildchain-dev-delivery.yml"),
    "utf8",
  );
  assert.match(
    caller,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/dev-pr-auto-merge\.yml@dev\/v3\/v3\.0/u,
  );
  assert.doesNotMatch(caller, /uses: \.\/\.github\/workflows\//u);
  assert.match(caller, /dev-delivery-parallel-dogfood\.mjs/u);
  assert.match(caller, /hostedAcceptance\.protectedDevExactReadback == null/u);
  assert.match(caller, /consumerPilotDecision == "not-authorized"/u);
});

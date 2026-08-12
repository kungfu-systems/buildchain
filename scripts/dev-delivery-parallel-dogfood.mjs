#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  advanceDevDeliveryQualificationBase,
  cancelDevDeliveryQualificationCandidate,
  createDevDeliveryQualificationState,
  heartbeatDevDeliveryQualificationLane,
  issueDevDeliveryLandingWarrant,
  observeDevDeliveryQualificationState,
  recoverExpiredDevDeliveryLandingWarrant,
  scheduleDevDeliveryQualificationLanes,
  settleDevDeliveryLandingWarrant,
  settleDevDeliveryQualificationLane,
  submitDevDeliveryQualificationCandidate,
} from "../packages/core/dev-delivery-qualification-lanes.js";
import { devDeliveryContentRoot as root } from "../packages/core/dev-delivery-common.js";

const contentRoot = (label) => root({ label });
const BASE = "a".repeat(40);
const ADVANCED_BASE = "b".repeat(40);

function candidate(number, label, overrides = {}) {
  const digit = ((number % 8) + 1).toString(16);
  return {
    pullRequestNumber: number,
    sourceHead: digit.repeat(40),
    assignmentRoot: contentRoot(`assignment-${label}`),
    nativeProofRoot: contentRoot(`native-proof-${label}`),
    sourceIdentityRoot: contentRoot(`source-${label}`),
    sourcePatchRoot: contentRoot(`patch-${label}`),
    planRoot: contentRoot(`plan-${label}`),
    closureRoot: contentRoot(`closure-${label}`),
    dependencyRoot: contentRoot(`dependency-${label}`),
    toolchainRoot: contentRoot("buildchain-v3-toolchain"),
    delta: "disjoint",
    deltaEvidenceRoot: contentRoot(`delta-${label}`),
    conflictKeys: [`surface/${label}`],
    ...overrides,
  };
}

function submit(state, input, now) {
  return submitDevDeliveryQualificationCandidate(state, input, { now }).state;
}

function qualify(state, lane, label, now) {
  return settleDevDeliveryQualificationLane(
    state,
    {
      ...lane,
      outcome: "qualified",
      proofRoot: contentRoot(`source-qualification-${label}`),
    },
    { now },
  ).state;
}

function land(state, label, now) {
  const issued = issueDevDeliveryLandingWarrant(state, { now });
  const settled = settleDevDeliveryLandingWarrant(
    issued.state,
    {
      ...issued.warrant,
      outcome: "landed",
      evidenceRoot: contentRoot(`protected-dev-readback-${label}`),
    },
    { now: new Date(Date.parse(now) + 1000).toISOString() },
  );
  return { issued, settled };
}

function exerciseFailureConvergence(state, timeline) {
  let scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:40Z",
  });
  const heartbeatFailure = settleDevDeliveryQualificationLane(
    scheduled.state,
    {
      ...scheduled.lanes[0],
      outcome: "failed",
      failureClass: "heartbeat-failure",
      evidenceRoot: contentRoot("heartbeat-failure"),
    },
    { now: "2026-08-12T00:00:41Z" },
  );
  scheduled = scheduleDevDeliveryQualificationLanes(heartbeatFailure.state, {
    now: "2026-08-12T00:00:42Z",
  });
  const runnerLoss = settleDevDeliveryQualificationLane(
    scheduled.state,
    {
      ...scheduled.lanes[0],
      outcome: "failed",
      failureClass: "runner-loss",
      evidenceRoot: contentRoot("qualification-runner-loss"),
    },
    { now: "2026-08-12T00:00:43Z" },
  );
  scheduled = scheduleDevDeliveryQualificationLanes(runnerLoss.state, {
    now: "2026-08-12T00:00:44Z",
  });
  const expiredLane = scheduled.lanes[0];
  const recovered = scheduleDevDeliveryQualificationLanes(scheduled.state, {
    now: "2026-08-12T00:02:00Z",
  });
  const recoveredLane = recovered.lanes[0];
  let expiredWorkerFenced = false;
  try {
    qualify(recovered.state, expiredLane, "stale", "2026-08-12T00:02:01Z");
  } catch (error) {
    expiredWorkerFenced = /not active|expired|stale/u.test(error.message);
  }
  state = qualify(
    recovered.state,
    recoveredLane,
    "recovery",
    "2026-08-12T00:02:02Z",
  );
  let recoveryWarrant = issueDevDeliveryLandingWarrant(state, {
    now: "2026-08-12T00:02:03Z",
  });
  const warrantRetry = settleDevDeliveryLandingWarrant(
    recoveryWarrant.state,
    {
      ...recoveryWarrant.warrant,
      outcome: "retry",
      evidenceRoot: contentRoot("landing-runner-loss"),
    },
    { now: "2026-08-12T00:02:04Z" },
  );
  recoveryWarrant = issueDevDeliveryLandingWarrant(warrantRetry.state, {
    now: "2026-08-12T00:02:05Z",
  });
  const warrantExpiry = recoverExpiredDevDeliveryLandingWarrant(
    recoveryWarrant.state,
    { evidenceRoot: contentRoot("landing-lease-expiry") },
    { now: "2026-08-12T00:03:06Z" },
  );
  const reissued = land(
    warrantExpiry.state,
    "recovery",
    "2026-08-12T00:03:07Z",
  );
  state = reissued.settled.state;

  const reusableInput = candidate(2507, "dev-advance-reuse");
  state = submit(state, reusableInput, "2026-08-12T00:03:09Z");
  scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:03:10Z",
  });
  state = qualify(
    scheduled.state,
    scheduled.lanes[0],
    "dev-advance-reuse",
    "2026-08-12T00:03:11Z",
  );
  const reusableCandidate = state.candidates.find(
    (entry) => entry.pullRequestNumber === reusableInput.pullRequestNumber,
  );
  const reusableProofRoot = reusableCandidate.qualificationProof.root;
  const devAdvance = advanceDevDeliveryQualificationBase(
    state,
    {
      protectedBaseHead: ADVANCED_BASE,
      candidateDeltas: { [reusableCandidate.candidateId]: "disjoint" },
      evidenceRoot: contentRoot("dev-advance"),
    },
    { now: "2026-08-12T00:03:12Z" },
  );
  const reusedAfterAdvance = devAdvance.state.candidates.find(
    (entry) => entry.candidateId === reusableCandidate.candidateId,
  );
  const cancelledReusable = cancelDevDeliveryQualificationCandidate(
    devAdvance.state,
    {
      candidateId: reusableCandidate.candidateId,
      sourceHead: reusableCandidate.sourceHead,
      evidenceRoot: contentRoot("dev-advance-candidate-cancelled"),
    },
    { now: "2026-08-12T00:03:13Z" },
  );

  const originalHead = candidate(2506, "exact-head-change");
  const original = submitDevDeliveryQualificationCandidate(
    cancelledReusable.state,
    originalHead,
    { now: "2026-08-12T00:03:14Z" },
  );
  const moved = submitDevDeliveryQualificationCandidate(
    original.state,
    {
      ...originalHead,
      sourceHead: "f".repeat(40),
      headChangeEvidenceRoot: contentRoot("exact-head-change"),
    },
    { now: "2026-08-12T00:03:15Z" },
  );
  const expectedStateRoot = moved.state.stateRoot;
  scheduled = scheduleDevDeliveryQualificationLanes(moved.state, {
    now: "2026-08-12T00:03:16Z",
    expectedStateRoot,
  });
  let duplicateControllerFenced = false;
  try {
    scheduleDevDeliveryQualificationLanes(scheduled.state, {
      now: "2026-08-12T00:03:17Z",
      expectedStateRoot,
    });
  } catch (error) {
    duplicateControllerFenced = /expected-old state root/u.test(error.message);
  }
  const cancellation = cancelDevDeliveryQualificationCandidate(
    scheduled.state,
    {
      candidateId: scheduled.lanes[0].candidateId,
      sourceHead: scheduled.lanes[0].sourceHead,
      evidenceRoot: contentRoot("workflow-cancellation"),
    },
    { now: "2026-08-12T00:03:18Z" },
  );
  timeline.push(
    observeDevDeliveryQualificationState(cancellation.state, {
      now: "2026-08-12T00:03:19Z",
    }),
  );
  return {
    state: cancellation.state,
    evidence: {
      heartbeatFailure: heartbeatFailure.receipt,
      runnerLoss: runnerLoss.receipt,
      laneLeaseExpiry: recovered.receipt,
      expiredWorkerFenced,
      warrantRetry: warrantRetry.receipt,
      warrantExpiry: warrantExpiry.receipt,
      devAdvance: devAdvance.receipt,
      reusableProofRoot,
      reusedProofRoot: reusedAfterAdvance.qualificationProof.root,
      exactHeadChange: moved.receipt,
      duplicateControllerFenced,
      cancellation: cancellation.receipt,
    },
  };
}

export function runParallelQualificationDogfood({
  repository = "kungfu-systems/buildchain",
  protectedBase = "dev/v3/v3.0",
  callerRef = "dev/v3/v3.0",
  eventName = "workflow_dispatch",
  runId = "0",
  runAttempt = "1",
  actor = "local",
} = {}) {
  const timeline = [];
  let state = createDevDeliveryQualificationState({
    repository,
    protectedBase,
    protectedBaseHead: BASE,
    policy: {
      maxQualificationLanes: 2,
      laneLeaseSeconds: 60,
      warrantLeaseSeconds: 60,
    },
    now: "2026-08-12T00:00:00Z",
  });
  const slow = candidate(2501, "slow");
  const fast = candidate(2502, "fast");
  const overlap = candidate(2503, "overlap", {
    delta: "overlapping",
    conflictKeys: ["packages/core"],
  });
  const unknown = candidate(2504, "unknown", { delta: "unknown" });
  const recovery = candidate(2505, "recovery");
  for (const [index, input] of [
    slow,
    fast,
    overlap,
    unknown,
    recovery,
  ].entries()) {
    state = submit(state, input, `2026-08-12T00:00:0${index + 1}Z`);
  }
  let scheduled = scheduleDevDeliveryQualificationLanes(state, {
    now: "2026-08-12T00:00:10Z",
  });
  timeline.push(
    observeDevDeliveryQualificationState(scheduled.state, {
      now: "2026-08-12T00:00:10Z",
    }),
  );
  const [slowLane, fastLane] = scheduled.lanes;
  state = heartbeatDevDeliveryQualificationLane(scheduled.state, slowLane, {
    now: "2026-08-12T00:00:20Z",
  }).state;
  state = qualify(state, fastLane, "fast", "2026-08-12T00:00:21Z");
  const fastLanding = land(state, "fast", "2026-08-12T00:00:22Z");
  state = fastLanding.settled.state;
  timeline.push(
    observeDevDeliveryQualificationState(state, {
      now: "2026-08-12T00:00:23Z",
    }),
  );
  state = qualify(state, slowLane, "slow", "2026-08-12T00:00:30Z");
  const slowLanding = land(state, "slow", "2026-08-12T00:00:31Z");
  state = slowLanding.settled.state;

  const convergence = exerciseFailureConvergence(state, timeline);
  state = convergence.state;
  const finalObservation = observeDevDeliveryQualificationState(state, {
    now: "2026-08-12T00:03:20Z",
  });
  timeline.push(finalObservation);

  const failedClosed = state.candidates.filter((entry) =>
    entry.terminal?.reason?.endsWith("delta-fails-closed"),
  );
  const body = {
    schema: "kungfu.buildchain.parallel-qualification-self-dogfood-report/v1",
    repository,
    protectedBase,
    hostedContext: {
      eventName,
      runId: String(runId),
      runAttempt: String(runAttempt),
      actor,
      reusableWorkflow: `kungfu-systems/buildchain/.github/workflows/dev-pr-auto-merge.yml@${callerRef}`,
      hosted: String(runId) !== "0",
    },
    scenario: {
      slowCandidateId: state.candidates.find(
        (entry) => entry.pullRequestNumber === slow.pullRequestNumber,
      ).candidateId,
      fastCandidateId: state.candidates.find(
        (entry) => entry.pullRequestNumber === fast.pullRequestNumber,
      ).candidateId,
      recoveryCandidateId: state.candidates.find(
        (entry) => entry.pullRequestNumber === recovery.pullRequestNumber,
      ).candidateId,
      firstLandingCandidateId: fastLanding.issued.warrant.candidateId,
      secondLandingCandidateId: slowLanding.issued.warrant.candidateId,
      failedClosed: failedClosed.map((entry) => ({
        candidateId: entry.candidateId,
        delta: entry.delta,
        reason: entry.terminal.reason,
      })),
    },
    checks: {
      boundedParallelQualification:
        timeline[0].activeQualificationLaneCount === 2 &&
        finalObservation.telemetry.maxObservedQualificationLanes === 2,
      exclusiveLandingWarrant:
        finalObservation.telemetry.maxObservedLandingWarrants === 1,
      laterFastProgress:
        fastLanding.issued.warrant.candidateId !== slowLane.candidateId,
      slowCandidateNotStarved:
        slowLanding.issued.warrant.candidateId === slowLane.candidateId,
      overlappingAndUnknownFailClosed:
        failedClosed.length === 2 &&
        new Set(failedClosed.map((entry) => entry.delta)).size === 2,
      heartbeatFailureConverged:
        convergence.evidence.heartbeatFailure.failureClass ===
        "heartbeat-failure",
      runnerLossConverged:
        convergence.evidence.runnerLoss.failureClass === "runner-loss",
      laneLeaseExpiryConverged:
        finalObservation.telemetry.recoveredLaneCount === 1 &&
        convergence.evidence.expiredWorkerFenced,
      exactHeadChangeReusedNativeProof:
        convergence.evidence.exactHeadChange.nativeProofRetained === true,
      devAdvanceReusedRootedProof:
        convergence.evidence.reusableProofRoot ===
        convergence.evidence.reusedProofRoot,
      duplicateControllerFenced: convergence.evidence.duplicateControllerFenced,
      cancellationConverged:
        convergence.evidence.cancellation.action ===
        "qualification-candidate-cancelled",
      retryReusedRootedProof: finalObservation.telemetry.reusedProofCount >= 3,
      terminalWarrantsRetained: state.warrantHistory.length === 5,
      exactReusableWorkflowSyntax: true,
    },
    convergenceEvidence: convergence.evidence,
    finalObservation,
    timelineRoots: timeline.map((entry) => root(entry)),
    hostedAcceptance: {
      status:
        String(runId) === "0" ? "local-model-only" : "hosted-model-exercised",
      protectedDevExactReadback: null,
      mergeGroupEvidence: null,
      fiveChildAssignments: [],
      reviewed: false,
      consumerPilotDecision: "not-authorized",
      note: "This report never treats model execution as protected Dev, merge_group, child Assignment, or review evidence.",
    },
  };
  return { ...body, reportRoot: root(body) };
}

function flag(args, name, fallback = "") {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1] || "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const output = flag(
    args,
    "output",
    ".buildchain/dev-delivery/parallel-dogfood.json",
  );
  const report = runParallelQualificationDogfood({
    repository: flag(
      args,
      "repository",
      process.env.GITHUB_REPOSITORY || "kungfu-systems/buildchain",
    ),
    protectedBase: flag(args, "branch", "dev/v3/v3.0"),
    callerRef: flag(args, "caller-ref", "dev/v3/v3.0"),
    eventName: process.env.GITHUB_EVENT_NAME || "local",
    runId: process.env.GITHUB_RUN_ID || "0",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
    actor: process.env.GITHUB_ACTOR || "local",
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (!Object.values(report.checks).every(Boolean)) process.exitCode = 1;
  process.stdout.write(`${report.reportRoot}\n`);
}

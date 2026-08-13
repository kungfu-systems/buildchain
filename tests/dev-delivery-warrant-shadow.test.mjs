import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDevDeliveryQueue,
  devDeliveryContentRoot,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import {
  DEV_DELIVERY_WARRANT_SHADOW_OBSERVATION_SCHEMA,
  planDevDeliveryWarrantShadow,
  qualifyDevDeliveryWarrantShadow,
} from "../packages/core/dev-delivery-warrant-shadow.js";
import { runDevDeliveryShadowCommand } from "../scripts/dev-delivery-warrant.mjs";

const BASE_HEAD = "f".repeat(40);
const PROJECTED_BASE_ROOT = devDeliveryContentRoot({ base: BASE_HEAD });

function root(label) {
  return devDeliveryContentRoot({ label });
}

function candidate(number) {
  const digit = ((number % 8) + 1).toString(16);
  return {
    pullRequestNumber: number,
    sourceHead: digit.repeat(40),
    assignmentRoot: root(`assignment-${number}`),
    initiativeRoot: root(`initiative-${number}`),
    sourceIdentityRoot: root(`source-${number}`),
    sourcePatchRoot: root(`patch-${number}`),
    sourceProofRoot: root(`proof-${number}`),
    planRoot: root(`plan-${number}`),
    closureRoot: root(`closure-${number}`),
    dependencyRoot: root(`dependency-${number}`),
    toolchainRoot: root(`toolchain-${number}`),
    environmentRoot: root(`environment-${number}`),
    deliveryClass: "native-proof-required",
    priority: "ordinary",
  };
}

function queue(count) {
  let value = createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-09T00:00:00Z",
  });
  for (let index = 0; index < count; index += 1) {
    value = submitDevDeliveryCandidate(value, candidate(2700 + index), {
      now: `2026-08-09T00:0${index + 1}:00Z`,
    }).queue;
  }
  return value;
}

function evidence(candidateEntry, field, overrides = {}) {
  return {
    candidateId: candidateEntry.candidateId,
    sourceHead: candidateEntry.sourceHead,
    baseHead: BASE_HEAD,
    root: root(`${candidateEntry.pullRequestNumber}-${field}`),
    state: {
      projectCut: "qualified",
      approval: "approved",
      requiredChecks: "passed",
      status: "ready",
      lease: "available",
    }[field],
    ...overrides,
  };
}

function binding(queueValue, candidateEntry, overrides = {}) {
  const active = queueValue.activeWarrant;
  const isActive = active?.candidateId === candidateEntry.candidateId;
  return {
    candidateId: candidateEntry.candidateId,
    sourceHead: candidateEntry.sourceHead,
    baseHead: BASE_HEAD,
    queueGeneration: queueValue.generation,
    queueStateRoot: queueValue.stateRoot,
    projectedBaseRoot: PROJECTED_BASE_ROOT,
    warrantFencingToken: isActive ? active.fencingToken : null,
    warrantGeneration: isActive ? active.generation : null,
    projectCut: evidence(candidateEntry, "projectCut"),
    approval: evidence(candidateEntry, "approval"),
    requiredChecks: evidence(candidateEntry, "requiredChecks"),
    status: evidence(candidateEntry, "status"),
    lease: evidence(candidateEntry, "lease", {
      state: isActive ? "active" : "available",
    }),
    conflictKeys: [],
    expectedEligible: true,
    ...overrides,
  };
}

function observation(queueValue, overrides = {}) {
  return {
    schema: DEV_DELIVERY_WARRANT_SHADOW_OBSERVATION_SCHEMA,
    observationId: "fixture",
    kind: "replay",
    observedAt: "2026-08-09T01:00:00Z",
    protectedBaseHead: BASE_HEAD,
    projectedBaseRoot: PROJECTED_BASE_ROOT,
    queue: queueValue,
    nativeQueue: {
      occupied: false,
      entryCount: 0,
      root: root("native-queue-empty"),
    },
    candidateBindings: queueValue.candidates.map((entry) =>
      binding(queueValue, entry),
    ),
    metrics: {
      baselineQueueWaitSeconds: 900,
      shadowQueueWaitSeconds: 300,
      additionalCheckSeconds: 120,
      additionalRunnerSeconds: 240,
      ambiguous: false,
    },
    ...overrides,
  };
}

test("shadow planner is deterministic, effect-disabled, and empty-safe", () => {
  const input = observation(queue(0));
  const first = planDevDeliveryWarrantShadow(input);
  const second = planDevDeliveryWarrantShadow(input);
  assert.deepEqual(first, second);
  assert.equal(first.planRoot, second.planRoot);
  assert.equal(first.lanes.length, 0);
  assert.equal(first.mutationAllowed, false);
  assert.equal(first.productionAuthority, "unchanged-single-flight");
  assert.deepEqual(first.effects, []);
});

test("one lane matches the production single-flight candidate without minting authority", () => {
  const queueValue = queue(2);
  const before = structuredClone(queueValue);
  const production = selectDevDeliveryWarrant(queueValue, {
    now: "2026-08-09T01:00:00Z",
  });
  const plan = planDevDeliveryWarrantShadow(observation(queueValue), {
    maxConcurrency: 1,
  });
  assert.equal(plan.lanes.length, 1);
  assert.equal(plan.lanes[0].candidateId, production.warrant.candidateId);
  assert.equal(plan.singleFlightParity.candidateIdentityMatches, true);
  assert.equal(plan.lanes[0].accepted, true);
  assert.deepEqual(queueValue, before);
});

test("two lanes qualify independently and excess candidates remain deferred", () => {
  const plan = planDevDeliveryWarrantShadow(observation(queue(3)));
  assert.equal(plan.lanes.length, 2);
  assert.equal(plan.acceptedLaneCount, 2);
  assert.equal(new Set(plan.lanes.map((lane) => lane.laneId)).size, 2);
  assert.equal(plan.deferredCandidateIds.length, 1);
  assert.equal(plan.rolloutAuthorized, false);
});

test("stale and partial lane evidence fails closed without contaminating its peer", () => {
  const queueValue = queue(2);
  const bindings = queueValue.candidates.map((entry) =>
    binding(queueValue, entry),
  );
  bindings[0].sourceHead = "e".repeat(40);
  bindings[0].status = {
    ...bindings[0].status,
    state: "failed",
  };
  const plan = planDevDeliveryWarrantShadow(
    observation(queueValue, { candidateBindings: bindings }),
  );
  assert.equal(plan.lanes[0].accepted, false);
  assert.ok(plan.lanes[0].reasonCodes.includes("stale-source-head"));
  assert.ok(plan.lanes[0].reasonCodes.includes("status-not-ready"));
  assert.equal(plan.lanes[1].accepted, true);
});

test("stale generation, fence, and incompatible projected base are explicit", () => {
  const submitted = queue(2);
  const selected = selectDevDeliveryWarrant(submitted, {
    now: "2026-08-09T01:00:00Z",
  }).queue;
  const bindings = selected.candidates.map((entry) => binding(selected, entry));
  bindings[0].queueGeneration -= 1;
  bindings[0].warrantFencingToken = root("stale-fence");
  bindings[1].projectedBaseRoot = root("incompatible-base");
  const plan = planDevDeliveryWarrantShadow(
    observation(selected, { candidateBindings: bindings }),
  );
  assert.ok(plan.lanes[0].reasonCodes.includes("stale-queue-generation"));
  assert.ok(plan.lanes[0].reasonCodes.includes("stale-warrant-fence"));
  assert.ok(plan.lanes[1].reasonCodes.includes("incompatible-projected-base"));
});

test("cross-lane aliases and conflicts reject both lanes", () => {
  const queueValue = queue(2);
  const bindings = queueValue.candidates.map((entry) =>
    binding(queueValue, entry, { conflictKeys: ["packages/shared"] }),
  );
  bindings[1].approval.root = bindings[0].approval.root;
  const plan = planDevDeliveryWarrantShadow(
    observation(queueValue, { candidateBindings: bindings }),
  );
  for (const lane of plan.lanes) {
    assert.equal(lane.accepted, false);
    assert.ok(lane.reasonCodes.includes("cross-lane-binding-alias"));
    assert.ok(lane.reasonCodes.includes("cross-lane-conflict"));
  }
});

test("an occupied native queue blocks every shadow lane", () => {
  const queueValue = queue(2);
  const plan = planDevDeliveryWarrantShadow(
    observation(queueValue, {
      nativeQueue: {
        occupied: true,
        entryCount: 1,
        root: root("native-queue-occupied"),
      },
    }),
  );
  assert.equal(plan.acceptedLaneCount, 0);
  assert.equal(plan.decision, "hold");
  assert.ok(
    plan.lanes.every((lane) =>
      lane.reasonCodes.includes("native-queue-occupied"),
    ),
  );
});

test("qualification applies explicit benefit, cost, ambiguity, and false-positive thresholds", () => {
  const report = qualifyDevDeliveryWarrantShadow({
    observations: [observation(queue(2))],
    thresholds: {
      minObservationCount: 1,
      minEligibleOverlapCount: 1,
      minProjectedQueueWaitBenefitSeconds: 300,
      maxAdditionalRunnerSeconds: 300,
      maxAmbiguityCount: 0,
      maxFalsePositiveCount: 0,
    },
  });
  assert.equal(report.decision, "proceed");
  assert.equal(report.metrics.eligibleOverlapCount, 1);
  assert.equal(report.metrics.projectedQueueWaitBenefitSeconds, 600);
  assert.equal(report.metrics.additionalRunnerSeconds, 240);
  assert.equal(report.rolloutAuthorized, false);
  assert.match(report.qualificationRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("shadow CLI reads one immutable input and rejects execute mode", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "buildchain-warrant-shadow-"),
  );
  const inputPath = path.join(directory, "observation.json");
  fs.writeFileSync(inputPath, `${JSON.stringify(observation(queue(2)))}\n`);
  const result = runDevDeliveryShadowCommand({
    command: "shadow-plan",
    inputPath,
    maxConcurrency: 2,
  });
  assert.equal(result.acceptedLaneCount, 2);
  assert.throws(
    () =>
      runDevDeliveryShadowCommand({
        command: "shadow-plan",
        inputPath,
        maxConcurrency: 2,
        execute: true,
      }),
    /effect-disabled and rejects --execute/u,
  );
  fs.rmSync(directory, { recursive: true });
});

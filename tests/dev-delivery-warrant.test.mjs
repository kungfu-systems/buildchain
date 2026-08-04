import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDevDeliveryDelta,
  closeDevDeliveryWarrant,
  createDevDeliveryQueue,
  createIntegrationDeliveryProof,
  createProjectCutReplayPlan,
  createSourceQualificationProof,
  heartbeatDevDeliveryWarrant,
  normalizeDevDeliveryQueue,
  observeDevDeliveryQueue,
  rankDevDeliveryCandidates,
  recoverExpiredDevDeliveryWarrant,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
  verifyIntegrationDeliveryProof,
  verifySourceQualificationProof,
} from "../packages/core/dev-delivery-warrant.js";

const ROOTS = Object.fromEntries(["assignment", "initiative", "source", "patch", "proof", "plan", "closure", "dependency", "toolchain", "shard", "context", "evidence"].map((name, index) => [name, `sha256:${(index + 1).toString(16).repeat(64)}`]));

function queue(policy = {}) {
  return createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    policy: { agingSeconds: 300, leaseSeconds: 600, ...policy },
    now: "2026-08-04T00:00:00Z",
  });
}

function candidate(number, overrides = {}) {
  const digit = (number % 9) + 1;
  return {
    pullRequestNumber: number,
    sourceHead: digit.toString(16).repeat(40),
    assignmentRoot: ROOTS.assignment,
    initiativeRoot: ROOTS.initiative,
    sourceIdentityRoot: `sha256:${digit.toString(16).repeat(64)}`,
    sourcePatchRoot: ROOTS.patch,
    sourceProofRoot: ROOTS.proof,
    planRoot: ROOTS.plan,
    closureRoot: ROOTS.closure,
    dependencyRoot: ROOTS.dependency,
    toolchainRoot: ROOTS.toolchain,
    deliveryClass: "native-proof-required",
    priority: "ordinary",
    ...overrides,
  };
}

function submit(state, number, at, overrides = {}) {
  return submitDevDeliveryCandidate(state, candidate(number, overrides), {
    now: at,
  });
}

test("queue identity and state roots fail closed on drift", () => {
  const state = queue();
  assert.match(state.stateRoot, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => normalizeDevDeliveryQueue({ ...state, generation: state.generation + 1 }), /stateRoot drift/);
  assert.throws(
    () =>
      normalizeDevDeliveryQueue(state, {
        repository: "kungfu-systems/buildchain",
      }),
    /repository mismatch/,
  );
});

test("duplicate submission is idempotent and safe head repair retains queue age", () => {
  const first = submit(queue(), 100, "2026-08-04T00:00:00Z");
  const duplicate = submitDevDeliveryCandidate(first.queue, candidate(100), {
    now: "2026-08-04T00:05:00Z",
  });
  assert.equal(duplicate.receipt.action, "duplicate-noop");
  assert.equal(duplicate.queue.candidates.length, 1);
  assert.equal(duplicate.queue.candidates[0].enqueuedAt, "2026-08-04T00:00:00.000Z");

  const repaired = submitDevDeliveryCandidate(duplicate.queue, candidate(100, { sourceHead: "f".repeat(40) }), { now: "2026-08-04T00:10:00Z" });
  assert.equal(repaired.receipt.action, "safe-head-repair-retained-age");
  assert.equal(repaired.queue.candidates[0].sourceHead, "f".repeat(40));
  assert.equal(repaired.queue.candidates[0].attempts, 2);
  assert.equal(repaired.queue.candidates[0].enqueuedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(repaired.receipt.queueAgeSeconds, 600);
  assert.equal(repaired.receipt.sourceProofRoot, ROOTS.proof);
});

test("FIFO plus aging is deterministic and bounds priority overtakes", () => {
  let state = submit(queue(), 101, "2026-08-04T00:00:00Z").queue;
  state = submit(state, 102, "2026-08-04T00:01:00Z").queue;
  state = submit(state, 103, "2026-08-04T00:02:00Z", {
    priority: "expedited",
  }).queue;

  const early = rankDevDeliveryCandidates(state, {
    now: "2026-08-04T00:03:00Z",
  });
  assert.equal(early[0].candidate.pullRequestNumber, 103);
  assert.equal(early[1].candidate.pullRequestNumber, 101);

  const aged = rankDevDeliveryCandidates(state, {
    now: "2026-08-04T00:20:00Z",
  });
  assert.equal(aged[0].candidate.pullRequestNumber, 101);
  assert.equal(aged[1].candidate.pullRequestNumber, 102);
  assert.equal(aged[2].candidate.pullRequestNumber, 103);
  assert.ok(aged.every((entry) => entry.priority.score <= 2));
});

test("selected heavy candidate is non-preemptive under an unbounded stream of later arrivals", () => {
  let state = submit(queue({ leaseSeconds: 3600 }), 110, "2026-08-04T00:00:00Z").queue;
  const selected = selectDevDeliveryWarrant(state, {
    now: "2026-08-04T00:00:01Z",
    leaseSeconds: 3600,
  });
  state = selected.queue;
  const originalToken = selected.warrant.fencingToken;

  for (let minute = 5, number = 111; minute <= 40; minute += 5, number += 1) {
    state = submit(state, number, `2026-08-04T00:${String(minute).padStart(2, "0")}:00Z`).queue;
    const observed = selectDevDeliveryWarrant(state, {
      now: `2026-08-04T00:${String(minute).padStart(2, "0")}:01Z`,
    });
    assert.equal(observed.receipt.reason, "non-preemptive-active-warrant");
    assert.equal(observed.warrant.pullRequestNumber, 110);
    assert.equal(observed.warrant.fencingToken, originalToken);
    state = observed.queue;
  }
  const observation = observeDevDeliveryQueue(state, {
    now: "2026-08-04T00:40:02Z",
  });
  assert.equal(observation.activeWarrant.pullRequestNumber, 110);
  assert.equal(observation.states.selected, 1);
  assert.equal(observation.states.queued, 8);
});

test("lease expiry recovers retained age and stale controllers are fenced", () => {
  const submitted = submit(queue(), 120, "2026-08-04T00:00:00Z");
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:01Z",
    leaseSeconds: 60,
  });
  const oldWarrant = selected.warrant;
  const recovered = recoverExpiredDevDeliveryWarrant(selected.queue, {
    now: "2026-08-04T00:02:00Z",
  });
  assert.equal(recovered.receipt.action, "recovered-expired-lease");
  assert.equal(recovered.queue.candidates[0].enqueuedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(recovered.queue.candidates[0].recoveries, 1);

  const reselection = selectDevDeliveryWarrant(recovered.queue, {
    now: "2026-08-04T00:02:01Z",
    leaseSeconds: 60,
  });
  assert.notEqual(reselection.warrant.fencingToken, oldWarrant.fencingToken);
  assert.equal(reselection.warrant.generation, oldWarrant.generation + 1);
  assert.throws(
    () =>
      heartbeatDevDeliveryWarrant(reselection.queue, oldWarrant, {
        now: "2026-08-04T00:02:02Z",
      }),
    /stale fencing token/,
  );
});

test("two controllers cannot commit transitions from the same expected-old state", () => {
  const submitted = submit(queue(), 130, "2026-08-04T00:00:00Z");
  const controllerA = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:01Z",
  });
  const controllerB = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:01Z",
  });
  assert.equal(controllerA.receipt.expectedOldStateRoot, submitted.queue.stateRoot);
  assert.equal(controllerB.receipt.expectedOldStateRoot, submitted.queue.stateRoot);
  assert.equal(controllerA.queue.stateRoot, controllerB.queue.stateRoot);

  const committedStateRoot = controllerA.queue.stateRoot;
  assert.notEqual(controllerB.receipt.expectedOldStateRoot, committedStateRoot);
  assert.throws(
    () =>
      normalizeDevDeliveryQueue({
        ...controllerB.queue,
        stateRoot: submitted.queue.stateRoot,
      }),
    /stateRoot drift/,
  );
});

test("heartbeat and terminal closeout bind the current fencing generation", () => {
  const submitted = submit(queue(), 140, "2026-08-04T00:00:00Z");
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:01Z",
  });
  const heartbeat = heartbeatDevDeliveryWarrant(selected.queue, selected.warrant, {
    now: "2026-08-04T00:01:00Z",
  });
  assert.equal(heartbeat.receipt.action, "heartbeat");
  assert.equal(heartbeat.queue.candidates[0].status, "proving");

  const closed = closeDevDeliveryWarrant(heartbeat.queue, selected.warrant, {
    outcome: "merged",
    evidenceRoot: ROOTS.evidence,
    now: "2026-08-04T00:02:00Z",
  });
  assert.equal(closed.queue.activeWarrant, null);
  assert.equal(closed.queue.candidates[0].status, "merged");
  assert.equal(closed.queue.candidates[0].terminal.fencingToken, selected.warrant.fencingToken);
  assert.equal(closed.receipt.nextAction, "Select the next queued candidate, if any.");
});

test("source proof reuse is exact and unknown or overlapping deltas fail closed", () => {
  const proof = createSourceQualificationProof({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    sourceIdentityRoot: ROOTS.source,
    sourceHead: "a".repeat(40),
    sourcePatchRoot: ROOTS.patch,
    planRoot: ROOTS.plan,
    closureRoot: ROOTS.closure,
    dependencyRoot: ROOTS.dependency,
    toolchainRoot: ROOTS.toolchain,
    affectedPaths: ["framework/core", "framework/yijinjing"],
    shardEvidenceRoots: [ROOTS.shard],
    qualifiedAt: "2026-08-04T00:00:00Z",
  });
  assert.deepEqual(verifySourceQualificationProof(proof), {
    ok: true,
    reason: "exact-source-proof",
    proofRoot: proof.proofRoot,
  });
  const exact = {
    sourceIdentityRoot: ROOTS.source,
    sourcePatchRoot: ROOTS.patch,
    planRoot: ROOTS.plan,
    closureRoot: ROOTS.closure,
    dependencyRoot: ROOTS.dependency,
    toolchainRoot: ROOTS.toolchain,
    graphKnown: true,
  };
  assert.equal(
    classifyDevDeliveryDelta({
      proof,
      current: { ...exact, changedPaths: ["docs/README.md"] },
    }).action,
    "reuse-source-qualification",
  );
  assert.equal(
    classifyDevDeliveryDelta({
      proof,
      current: { ...exact, changedPaths: ["framework/core"] },
    }).action,
    "rerun-affected-source-shards",
  );
  assert.equal(
    classifyDevDeliveryDelta({
      proof,
      current: { ...exact, graphKnown: false, changedPaths: [] },
    }).action,
    "rerun-full-source-qualification",
  );
  assert.equal(
    classifyDevDeliveryDelta({
      proof,
      current: { ...exact, toolchainRoot: ROOTS.evidence, changedPaths: [] },
    }).reason,
    "toolchainRoot-changed-or-unknown",
  );
});

test("base advancement replays a Project Cut without changing the PR head", () => {
  const plan = createProjectCutReplayPlan({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    pullRequestNumber: 150,
    sourceHead: "a".repeat(40),
    previousBase: "b".repeat(40),
    currentBase: "c".repeat(40),
    sourcePatchRoot: ROOTS.patch,
    replayTree: "d".repeat(40),
  });
  assert.equal(plan.action, "replay-on-latest-base");
  assert.equal(plan.sourceHeadMutationRequired, false);
  assert.equal(plan.sourceHead, "a".repeat(40));
  assert.equal(plan.finalAuthority, "github-merge-group");
});

test("integration proof always binds the exact merge group and current Warrant", () => {
  const submitted = submit(queue(), 160, "2026-08-04T00:00:00Z");
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:01Z",
  });
  const sourceProof = createSourceQualificationProof({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    sourceIdentityRoot: ROOTS.source,
    sourceHead: "a".repeat(40),
    sourcePatchRoot: ROOTS.patch,
    planRoot: ROOTS.plan,
    closureRoot: ROOTS.closure,
    dependencyRoot: ROOTS.dependency,
    toolchainRoot: ROOTS.toolchain,
    affectedPaths: [],
    shardEvidenceRoots: [ROOTS.shard],
    qualifiedAt: "2026-08-04T00:00:00Z",
  });
  const proof = createIntegrationDeliveryProof({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    sourceProofRoot: sourceProof.proofRoot,
    currentBase: "b".repeat(40),
    replayTree: "c".repeat(40),
    mergeGroupHead: "d".repeat(40),
    mergeGroupTree: "e".repeat(40),
    warrant: selected.warrant,
    requiredContextRoots: [ROOTS.context],
    verifiedAt: "2026-08-04T00:10:00Z",
  });
  assert.equal(verifyIntegrationDeliveryProof(proof).ok, true);
  assert.equal(verifyIntegrationDeliveryProof(proof, { mergeGroupTree: "f".repeat(40) }).reason, "mergeGroupTree-mismatch");
  assert.equal(proof.warrantFencingToken, selected.warrant.fencingToken);
  assert.equal(proof.finalAuthority, "exact-github-merge-group");
});

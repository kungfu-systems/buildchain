import assert from "node:assert/strict";
import test from "node:test";

import { runDevDeliveryCommand } from "../packages/core/dev-delivery/warrant/service.js";
import {
  createDevDeliveryQueue,
  closeDevDeliveryWarrant,
  createNativeCommandContract,
  devDeliveryContentRoot,
  normalizeDevDeliveryQueue,
  observeDevDeliveryQueue,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery/dev-delivery-warrant.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

class MemoryStore {
  constructor(queue) {
    this.queue = queue;
    this.commitSha = "a".repeat(40);
    this.writes = [];
  }

  async read() {
    return { exists: true, commitSha: this.commitSha, queue: this.queue };
  }

  async write(input) {
    assert.equal(input.expectedCommitSha, this.commitSha);
    assert.equal(input.expectedStateRoot, this.queue.stateRoot);
    this.writes.push(input);
    this.queue = input.queue;
    this.commitSha = "b".repeat(40);
    return { commitSha: this.commitSha, stateRoot: this.queue.stateRoot };
  }
}

test("selection persists expired non-native lease recovery before reselection", async () => {
  const queue = createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
  const submitted = submitDevDeliveryCandidate(
    queue,
    {
      pullRequestNumber: 200,
      sourceHead: "a".repeat(40),
      sourceRoot: ROOT("1"),
      sourceIdentityRoot: ROOT("3"),
      sourcePatchRoot: ROOT("4"),
      sourceProofRoot: ROOT("5"),
      planRoot: ROOT("6"),
      closureRoot: ROOT("7"),
      dependencyRoot: ROOT("8"),
      toolchainRoot: ROOT("9"),
      affectedPaths: [],
      shardEvidenceRoots: [],
      deliveryClass: "non-native-fast",
    },
    { now: "2026-08-04T00:01:00Z" },
  );
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:02:00Z",
    leaseSeconds: 1,
  });
  const store = new MemoryStore(selected.queue);
  const result = await runDevDeliveryCommand(
    {
      command: "select",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: "2026-08-04T00:03:00Z",
      execute: true,
    },
    store,
  );
  assert.equal(store.writes.length, 2);
  assert.equal(result.receipt.selected, true);
  assert.equal(result.observation.activeWarrant.pullRequestNumber, 200);
  assert.equal(
    result.concurrencyRecovery.action,
    "expired-lease-recovered-before-reselection",
  );
});

const ROOTS = Object.fromEntries(
  [
    "assignment",
    "initiative",
    "source",
    "patch",
    "proof",
    "plan",
    "closure",
    "dependency",
    "toolchain",
    "shard",
    "context",
    "evidence",
  ].map((name, index) => [
    name,
    `sha256:${(index + 1).toString(16).repeat(64)}`,
  ]),
);

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
    sourceRoot: ROOTS.assignment,
    sourceIdentityRoot: `sha256:${digit.toString(16).repeat(64)}`,
    sourcePatchRoot: ROOTS.patch,
    sourceProofRoot: ROOTS.proof,
    planRoot: ROOTS.plan,
    closureRoot: ROOTS.closure,
    dependencyRoot: ROOTS.dependency,
    toolchainRoot: ROOTS.toolchain,
    environmentRoot: ROOTS.context,
    nativeCommandContract: createNativeCommandContract(
      "node --test tests/dev-delivery-warrant.test.mjs",
    ),
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

function terminalProducerHistory(identityRoot = ROOTS.source) {
  const submitted = submit(queue(), 99, "2026-08-04T00:00:00Z");
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:01Z",
  });
  const state = closeDevDeliveryWarrant(selected.queue, selected.warrant, {
    outcome: "dequeued",
    evidenceRoot: ROOTS.evidence,
    now: "2026-08-04T00:01:00Z",
  }).queue;
  const stored = state.candidates[0];
  delete stored.sourceRoot;
  delete stored.environmentRoot;
  delete stored.nativeCommandContract;
  stored.assignmentRoot = ROOTS.assignment;
  stored.initiativeRoot = ROOTS.initiative;
  stored.sourceIdentityRoot = identityRoot;
  stored.candidateId = devDeliveryContentRoot({
    repository: state.repository,
    protectedBase: state.protectedBase,
    pullRequestNumber: stored.pullRequestNumber,
    assignmentRoot: stored.assignmentRoot,
    initiativeRoot: stored.initiativeRoot,
    sourceIdentityRoot: stored.sourceIdentityRoot,
    deliveryClass: stored.deliveryClass,
  });
  delete state.stateRoot;
  state.stateRoot = devDeliveryContentRoot(state);
  return state;
}

test("terminal producer history retains exact identity and root without granting live authority", () => {
  const state = terminalProducerHistory();
  const original = structuredClone(state);
  assert.deepEqual(normalizeDevDeliveryQueue(state), original);
  assert.equal(observeDevDeliveryQueue(state).activeWarrant, null);
  const next = submit(state, 99, "2026-09-20T00:00:00Z");
  assert.deepEqual(next.queue.candidates[0], original.candidates[0]);
  assert.equal(next.queue.candidates[1].sourceRoot, ROOTS.assignment);
  assert.equal(
    next.queue.candidates[1].predecessorCandidateId,
    original.candidates[0].candidateId,
  );
  assert.deepEqual(state, original);
  for (const status of [
    "queued",
    "selected",
    "proving",
    "waiting",
    "blocked",
    "qualified",
  ]) {
    const live = structuredClone(state);
    live.candidates[0].status = status;
    delete live.stateRoot;
    assert.throws(() => normalizeDevDeliveryQueue(live), /sourceRoot alone/u);
  }
  assert.throws(
    () =>
      submitDevDeliveryCandidate(queue(), {
        ...candidate(99),
        sourceRoot: undefined,
        assignmentRoot: ROOTS.assignment,
        initiativeRoot: ROOTS.initiative,
        status: "dequeued",
      }),
    /sourceRoot alone/u,
  );
  const corrupted = structuredClone(state);
  corrupted.candidates[0].assignmentRoot = ROOTS.evidence;
  delete corrupted.stateRoot;
  assert.throws(
    () => normalizeDevDeliveryQueue(corrupted),
    /candidateId mismatch/u,
  );
  const missingIdentity = structuredClone(state);
  delete missingIdentity.stateRoot;
  delete missingIdentity.candidates[0].candidateId;
  assert.throws(
    () => normalizeDevDeliveryQueue(missingIdentity),
    /historical candidateId/u,
  );
});

test("unchained producer history is readable only within its original terminal cutover", () => {
  const state = terminalProducerHistory();
  state.candidates.push(terminalProducerHistory(ROOTS.evidence).candidates[0]);
  delete state.stateRoot;
  state.stateRoot = devDeliveryContentRoot(state);
  assert.equal(normalizeDevDeliveryQueue(state).stateRoot, state.stateRoot);
  const newer = structuredClone(state);
  newer.candidates[1].enqueuedAt = "2026-08-05T14:42:34.000Z";
  newer.candidates[1].updatedAt = newer.candidates[1].enqueuedAt;
  delete newer.stateRoot;
  assert.throws(() => normalizeDevDeliveryQueue(newer), /same-PR successor/u);
});

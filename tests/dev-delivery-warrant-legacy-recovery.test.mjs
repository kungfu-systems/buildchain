import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";
import {
  createDevDeliveryQueue,
  createNativeCommandContract,
  devDeliveryContentRoot,
  normalizeDevDeliveryQueue,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import { recoverLegacyTerminalDevDeliveryQueue } from "../packages/core/dev-delivery-warrant-legacy-recovery.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

function initialQueue() {
  return createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
}

function candidate(number, sourceHead, sourceWorkflowRunId) {
  return {
    pullRequestNumber: number,
    sourceHead,
    assignmentRoot: ROOT("1"),
    initiativeRoot: ROOT("2"),
    sourceIdentityRoot: ROOT(number === 200 ? "3" : "a"),
    sourcePatchRoot: ROOT("4"),
    sourceProofRoot: ROOT("9"),
    planRoot: ROOT("5"),
    closureRoot: ROOT("6"),
    dependencyRoot: ROOT("7"),
    toolchainRoot: ROOT("8"),
    environmentRoot: ROOT("0"),
    nativeCommandContract: createNativeCommandContract("native-shards"),
    deliveryClass: "native-proof-required",
    priority: "ordinary",
    sourceWorkflowRunId,
  };
}

function legacyQueue() {
  const first = submitDevDeliveryCandidate(
    initialQueue(),
    candidate(200, "a".repeat(40), 1001),
    { now: "2026-08-04T00:01:00Z" },
  );
  const selected = selectDevDeliveryWarrant(first.queue, {
    now: "2026-08-04T00:02:00Z",
  });
  const follower = submitDevDeliveryCandidate(
    selected.queue,
    candidate(201, "b".repeat(40), 1002),
    { now: "2026-08-04T00:03:00Z" },
  );
  const legacy = structuredClone(follower.queue);
  for (const entry of legacy.candidates) delete entry.nativeCommandContract;
  delete legacy.activeWarrant.nativeCommandContract;
  delete legacy.stateRoot;
  legacy.stateRoot = devDeliveryContentRoot(legacy);
  return legacy;
}

function legacyFollowerQueue() {
  const first = submitDevDeliveryCandidate(
    initialQueue(),
    candidate(200, "a".repeat(40), 1001),
    { now: "2026-08-04T00:01:00Z" },
  );
  const selected = selectDevDeliveryWarrant(first.queue, {
    now: "2026-08-04T00:02:00Z",
  });
  const follower = submitDevDeliveryCandidate(
    selected.queue,
    candidate(201, "b".repeat(40), 1002),
    { now: "2026-08-04T00:03:00Z" },
  );
  const legacy = structuredClone(follower.queue);
  delete legacy.candidates[1].nativeCommandContract;
  delete legacy.stateRoot;
  legacy.stateRoot = devDeliveryContentRoot(legacy);
  return legacy;
}

function hostedTerminalEvidence(candidateEntry, jobId, overrides = {}) {
  const runAttempt = overrides.runAttempt || 1;
  const body = {
    schema: "kungfu.buildchain.legacy-hosted-terminal-evidence/v1",
    candidateId: candidateEntry.candidateId,
    pullRequestNumber: candidateEntry.pullRequestNumber,
    sourceHead: candidateEntry.sourceHead,
    sourceWorkflowRunId: candidateEntry.sourceWorkflowRunId,
    runAttempt,
    runStatus: "completed",
    runConclusion: "failure",
    runUpdatedAt: "2026-08-04T00:10:00.000Z",
    totalJobCount: 1,
    nonterminalJobCount: 0,
    workerTerminationProven: true,
    jobs: [
      {
        id: jobId,
        name: "native shard",
        runAttempt,
        status: "completed",
        conclusion: "failure",
        completedAt: "2026-08-04T00:09:00.000Z",
      },
    ],
    reason: "The exact hosted native run completed with failure.",
    ...overrides,
  };
  return { ...body, evidenceRoot: devDeliveryContentRoot(body) };
}

function recoveryRequest(legacy) {
  return {
    schema: "kungfu.buildchain.legacy-terminal-recovery-request/v1",
    expectedOldStateRoot: legacy.stateRoot,
    evidence: legacy.candidates.map((entry, index) =>
      hostedTerminalEvidence(entry, 500 + index),
    ),
  };
}

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
    if (input.expectedCommitSha !== this.commitSha)
      throw new Error("commit CAS mismatch");
    if (input.expectedStateRoot !== this.queue.stateRoot)
      throw new Error("state CAS mismatch");
    this.writes.push(input);
    this.queue = input.queue;
    this.commitSha = "b".repeat(40);
    return { commitSha: this.commitSha, stateRoot: this.queue.stateRoot };
  }
}

test("legacy terminal recovery atomically closes the complete failed live set", () => {
  const legacy = legacyQueue();
  const request = recoveryRequest(legacy);
  assert.throws(
    () => normalizeDevDeliveryQueue(legacy),
    /live native candidate requires exact native proof/u,
  );
  assert.throws(
    () =>
      recoverLegacyTerminalDevDeliveryQueue(legacy, {
        ...request,
        evidence: request.evidence.slice(0, 1),
      }),
    /cover every live legacy native candidate exactly once/u,
  );

  const recovered = recoverLegacyTerminalDevDeliveryQueue(legacy, request, {
    now: "2026-08-04T00:11:00Z",
  });
  assert.equal(recovered.queue.activeWarrant, null);
  assert.deepEqual(
    recovered.queue.candidates.map((entry) => entry.status),
    ["terminal-failure", "terminal-failure"],
  );
  assert.equal(
    normalizeDevDeliveryQueue(recovered.queue).stateRoot,
    recovered.queue.stateRoot,
  );
  assert.equal(recovered.receipt.expectedOldStateRoot, legacy.stateRoot);
  assert.equal(recovered.receipt.nextStateRoot, recovered.queue.stateRoot);
  assert.equal(recovered.receipt.transitions.length, 2);
  assert.deepEqual(
    recovered.receipt.transitions.map((entry) => entry.priorStatus),
    ["selected", "queued"],
  );
  assert.match(recovered.receiptRoot, /^sha256:[0-9a-f]{64}$/u);
});

test("legacy follower recovery preserves an unrelated exact active Warrant", () => {
  const legacy = legacyFollowerQueue();
  const activeWarrant = structuredClone(legacy.activeWarrant);
  const legacyFollower = legacy.candidates[1];
  const request = {
    schema: "kungfu.buildchain.legacy-terminal-recovery-request/v1",
    expectedOldStateRoot: legacy.stateRoot,
    evidence: [hostedTerminalEvidence(legacyFollower, 501)],
  };

  assert.throws(
    () => normalizeDevDeliveryQueue(legacy),
    /live native candidate requires exact native proof/u,
  );

  const recovered = recoverLegacyTerminalDevDeliveryQueue(legacy, request, {
    now: "2026-08-04T00:11:00Z",
  });
  assert.deepEqual(recovered.queue.activeWarrant, activeWarrant);
  assert.deepEqual(
    recovered.queue.candidates.map((entry) => entry.status),
    ["selected", "terminal-failure"],
  );
  assert.equal(recovered.receipt.transitions[0].activeWarrant, false);
  assert.equal(
    recovered.receipt.nextAction,
    "Continue the preserved exact active Warrant.",
  );
  assert.doesNotThrow(() => normalizeDevDeliveryQueue(recovered.queue));
});

test("legacy terminal recovery rejects nonterminal provider evidence", () => {
  const legacy = legacyQueue();
  const invalid = hostedTerminalEvidence(legacy.candidates[0], 500, {
    jobs: [
      {
        id: 500,
        name: "native shard",
        runAttempt: 1,
        status: "in_progress",
        conclusion: "",
        completedAt: "2026-08-04T00:09:00.000Z",
      },
    ],
  });
  assert.throws(
    () =>
      recoverLegacyTerminalDevDeliveryQueue(legacy, {
        schema: "kungfu.buildchain.legacy-terminal-recovery-request/v1",
        expectedOldStateRoot: legacy.stateRoot,
        evidence: [invalid],
      }),
    /every provider job to be terminal/u,
  );
});

test("legacy recovery command plans and persists one strict authority update", async () => {
  const legacy = legacyQueue();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "legacy-terminal-recovery-"),
  );
  const recoveryPath = path.join(directory, "request.json");
  fs.writeFileSync(
    recoveryPath,
    `${JSON.stringify(recoveryRequest(legacy), null, 2)}\n`,
  );
  const store = new MemoryStore(legacy);
  const options = {
    command: "recover-legacy-terminal",
    repository: legacy.repository,
    branch: legacy.protectedBase,
    expectedOldStateRoot: legacy.stateRoot,
    legacyTerminalRecoveryPath: recoveryPath,
    now: "2026-08-04T00:11:00Z",
  };
  try {
    await assert.rejects(
      runDevDeliveryCommand(
        { ...options, expectedOldStateRoot: "", execute: true },
        store,
      ),
      /requires expected-old CAS/u,
    );
    const planned = await runDevDeliveryCommand(options, store);
    assert.equal(planned.mode, "plan");
    assert.equal(planned.receipt.transitions.length, 2);
    assert.equal(store.writes.length, 0);

    const executed = await runDevDeliveryCommand(
      { ...options, execute: true },
      store,
    );
    assert.equal(executed.mutationApplied, true);
    assert.equal(executed.observation.states["terminal-failure"], 2);
    assert.equal(store.writes.length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

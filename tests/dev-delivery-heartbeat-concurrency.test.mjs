import assert from "node:assert/strict";
import test from "node:test";

import {
  createDevDeliveryQueue,
  devDeliveryContentRoot,
  createNativeCommandContract,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import {
  runDevDeliveryProviderHeartbeat,
  verifyDevDeliveryProviderHeartbeat,
} from "../packages/core/dev-delivery-provider-heartbeat.js";
import { runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const REPOSITORY = "kungfu-systems/kungfu";

function admission() {
  return {
    observation: {
      repository: REPOSITORY,
      protectedBase: "dev/v4/v4.0",
      stateRoot: ROOT("1"),
      activeWarrant: {
        candidateId: ROOT("2"),
        fencingToken: ROOT("3"),
        generation: 4,
        issuedAt: "2026-08-15T00:00:00.000Z",
        heartbeatAt: "2026-08-15T00:00:00.000Z",
        expiresAt: "2026-08-15T00:01:00.000Z",
      },
    },
  };
}

function jobs() {
  const job = (id, name, runner, labels) => ({
    id,
    name,
    status: "completed",
    conclusion: "success",
    runner_name: runner,
    runner_group_name: "GitHub Actions",
    labels,
    started_at: "2026-08-15T00:00:00.000Z",
    completed_at: "2026-08-15T00:00:05.000Z",
  });
  return {
    jobs: [
      job(10, "Reserve exact delivery candidate", "GitHub Actions 10", [
        "ubuntu-24.04",
        "X64",
      ]),
      job(11, "Credentialless native execution", "GitHub Actions 11", [
        "ubuntu-24.04",
        "X64",
      ]),
      job(12, "Credentialless native evidence seal", "GitHub Actions 12", [
        "ubuntu-24.04",
        "X64",
      ]),
      job(
        13,
        "Credentialed independent Warrant heartbeat",
        "GitHub Actions 13",
        ["macos-15", "ARM64"],
      ),
      {
        ...job(14, "Credentialed provider finalizer", "GitHub Actions 14", [
          "ubuntu-24.04",
          "X64",
        ]),
        status: "in_progress",
        conclusion: null,
        completed_at: null,
      },
    ],
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
    this.writes.push(input);
    this.queue = input.queue;
    this.commitSha = "b".repeat(40);
    return { commitSha: this.commitSha, stateRoot: this.queue.stateRoot };
  }
}

function selectedQueue() {
  const queue = createDevDeliveryQueue({
    repository: REPOSITORY,
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
  const submitted = submitDevDeliveryCandidate(
    queue,
    {
      pullRequestNumber: 200,
      sourceHead: "a".repeat(40),
      assignmentRoot: ROOT("1"),
      initiativeRoot: ROOT("2"),
      sourceIdentityRoot: ROOT("3"),
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
    },
    { now: "2026-08-04T00:01:00Z" },
  );
  return selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:02:00Z",
  });
}

test("heartbeat command rebases stale shared state under the exact fence", async () => {
  const selected = selectedQueue();
  const store = new MemoryStore(selected.queue);
  const result = await runDevDeliveryCommand(
    {
      command: "heartbeat",
      repository: REPOSITORY,
      branch: "dev/v4/v4.0",
      expectedOldStateRoot: ROOT("f"),
      fencingToken: selected.warrant.fencingToken,
      leaseGeneration: selected.warrant.generation,
      leaseSeconds: 60,
      now: "2026-08-04T00:03:00Z",
      execute: true,
    },
    store,
  );
  assert.equal(result.before.stateRoot, selected.queue.stateRoot);
  assert.equal(result.receipt.expectedOldStateRoot, selected.queue.stateRoot);
  assert.equal(result.concurrencyRecovery.requestedStateRoot, ROOT("f"));
  assert.equal(
    result.concurrencyRecovery.observedStateRoot,
    selected.queue.stateRoot,
  );
  assert.equal(store.writes.length, 1);
});

test("provider receipt preserves an unrelated shared-state rebase", async () => {
  let beat = 0;
  const result = await runDevDeliveryProviderHeartbeat(
    {
      admission: admission(),
      workflowRunId: 90,
      workflowRunAttempt: 2,
      leaseSeconds: 60,
      heartbeatSeconds: 10,
    },
    {
      wait: async () => {},
      heartbeat: async ({ expectedOldStateRoot }) => {
        beat += 1;
        const rebasedRoot = beat === 2 ? ROOT("e") : expectedOldStateRoot;
        const nextRoot = beat === 1 ? ROOT("4") : ROOT("f");
        const heartbeatAt = `2026-08-15T00:00:0${beat}.000Z`;
        const receipt = {
          action: "heartbeat",
          candidateId: ROOT("2"),
          fencingToken: ROOT("3"),
          leaseGeneration: 4,
          expiresAt: "2026-08-15T00:01:00.000Z",
          expectedOldStateRoot: rebasedRoot,
          nextStateRoot: nextRoot,
        };
        return {
          before: { stateRoot: rebasedRoot },
          after: { stateRoot: nextRoot },
          concurrencyRecovery:
            rebasedRoot === expectedOldStateRoot
              ? null
              : {
                  action: "heartbeat-state-root-rebased",
                  requestedStateRoot: expectedOldStateRoot,
                  observedStateRoot: rebasedRoot,
                },
          receipt,
          receiptRoot: devDeliveryContentRoot(receipt),
          observation: {
            stateRoot: nextRoot,
            activeWarrant: {
              candidateId: ROOT("2"),
              fencingToken: ROOT("3"),
              generation: 4,
              heartbeatAt,
              expiresAt: receipt.expiresAt,
            },
          },
        };
      },
      readJobs: async () =>
        beat > 1 ? jobs() : { jobs: jobs().jobs.slice(0, 2) },
    },
  );
  assert.equal(result.heartbeats[1].previousStateRoot, ROOT("4"));
  assert.equal(result.heartbeats[1].expectedOldStateRoot, ROOT("e"));
  assert.equal(
    verifyDevDeliveryProviderHeartbeat(result, {
      admission: admission(),
      jobsReadback: jobs(),
      liveObservation: {
        stateRoot: ROOT("f"),
        activeWarrant: { fencingToken: ROOT("3"), generation: 4 },
      },
      workflowRunId: 90,
      workflowRunAttempt: 2,
      observedAt: "2026-08-15T00:00:10.000Z",
    }).ok,
    true,
  );
});

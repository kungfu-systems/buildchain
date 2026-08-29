import assert from "node:assert/strict";
import test from "node:test";
import {
  createDevDeliveryQueue,
  createNativeCommandContract,
  DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT,
  devDeliveryContentRoot,
  fenceDevDeliveryWriterProtocol,
  normalizeDevDeliveryQueue,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import { runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;

function legacyQueue() {
  const queue = createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
  delete queue.policy.minimumWriterProtocolRoot;
  delete queue.stateRoot;
  queue.stateRoot = devDeliveryContentRoot(queue);
  return queue;
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

test("idle legacy queues install a durable minimum writer protocol fence", () => {
  const fenced = fenceDevDeliveryWriterProtocol(legacyQueue(), {
    now: "2026-08-04T00:00:01Z",
  });
  assert.equal(fenced.receipt.action, "minimum-writer-protocol-fenced");
  assert.equal(
    fenced.queue.policy.minimumWriterProtocolRoot,
    DEV_DELIVERY_MINIMUM_WRITER_PROTOCOL_ROOT,
  );
  assert.equal(
    normalizeDevDeliveryQueue(fenced.queue).stateRoot,
    fenced.queue.stateRoot,
  );

  const staleWriterProjection = structuredClone(fenced.queue);
  delete staleWriterProjection.policy.minimumWriterProtocolRoot;
  assert.throws(
    () => normalizeDevDeliveryQueue(staleWriterProjection),
    /stateRoot drift/u,
  );
});

test("minimum writer protocol fencing preserves active queue authority", () => {
  const live = submitDevDeliveryCandidate(
    legacyQueue(),
    {
      pullRequestNumber: 99,
      sourceHead: "a".repeat(40),
      assignmentRoot: ROOT("1"),
      initiativeRoot: ROOT("2"),
      sourceIdentityRoot: ROOT("3"),
      sourcePatchRoot: ROOT("4"),
      sourceProofRoot: ROOT("5"),
      planRoot: ROOT("6"),
      closureRoot: ROOT("7"),
      dependencyRoot: ROOT("8"),
      toolchainRoot: ROOT("9"),
      environmentRoot: ROOT("a"),
      nativeCommandContract: createNativeCommandContract("native-shards"),
      deliveryClass: "native-proof-required",
    },
    { now: "2026-08-04T00:00:01Z" },
  );
  assert.throws(
    () =>
      fenceDevDeliveryWriterProtocol(live.queue, {
        now: "2026-08-04T00:00:02Z",
      }),
    /only while the queue is idle/u,
  );
});

test("writer protocol fence command is CAS-bound and idempotent", async () => {
  const queue = legacyQueue();
  const store = new MemoryStore(queue);
  const options = {
    command: "fence-writer-protocol",
    repository: queue.repository,
    branch: queue.protectedBase,
    execute: true,
    now: "2026-08-04T00:00:01Z",
  };
  await assert.rejects(
    runDevDeliveryCommand(options, store),
    /requires expected-old CAS/u,
  );
  const result = await runDevDeliveryCommand(
    { ...options, expectedOldStateRoot: queue.stateRoot },
    store,
  );
  assert.equal(result.mutationApplied, true);
  assert.equal(result.receipt.action, "minimum-writer-protocol-fenced");

  const duplicate = await runDevDeliveryCommand(
    {
      ...options,
      expectedOldStateRoot: result.after.stateRoot,
      now: "2026-08-04T00:00:02Z",
    },
    store,
  );
  assert.equal(duplicate.mutationApplied, false);
  assert.equal(
    duplicate.receipt.action,
    "minimum-writer-protocol-already-fenced",
  );
});

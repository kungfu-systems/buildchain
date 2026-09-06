import assert from "node:assert/strict";
import test from "node:test";

import { runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";
import {
  createDevDeliveryQueue,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";

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
      assignmentRoot: ROOT("1"),
      initiativeRoot: ROOT("2"),
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

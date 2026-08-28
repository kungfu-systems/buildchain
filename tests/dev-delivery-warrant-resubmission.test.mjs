import assert from "node:assert/strict";
import test from "node:test";
import { runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";
import {
  createDevDeliveryQueue,
  createNativeCommandContract,
  selectDevDeliveryWarrant,
  submitDevDeliveryCandidate,
} from "../packages/core/dev-delivery-warrant.js";
import { validateDevDeliveryCandidateChain } from "../packages/core/dev-delivery-candidate-identity.js";

const root = (digit) => `sha256:${digit.repeat(64)}`;
const options = {
  command: "submit",
  repository: "kungfu-systems/kungfu",
  branch: "dev/v4/v4.0",
  pullRequestNumber: 200,
  sourceHead: "a".repeat(40),
  assignmentRoot: root("1"),
  initiativeRoot: root("2"),
  sourceIdentityRoot: root("3"),
  sourcePatchRoot: root("4"),
  sourceProofRoot: root("9"),
  planRoot: root("5"),
  closureRoot: root("6"),
  dependencyRoot: root("7"),
  toolchainRoot: root("8"),
  environmentRoot: root("0"),
  nativeCommand: "native-shards",
  deliveryClass: "native-proof-required",
  priority: "ordinary",
  sourceWorkflowRunId: 0,
};

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
    throw new Error("selected duplicate must not write");
  }
}

test("selected duplicate preserves the exact active Warrant without a write", async () => {
  const initial = createDevDeliveryQueue({
    repository: options.repository,
    protectedBase: options.branch,
    now: "2026-08-04T00:00:00Z",
  });
  const submitted = submitDevDeliveryCandidate(
    initial,
    {
      ...options,
      nativeCommandContract: createNativeCommandContract(options.nativeCommand),
    },
    { now: "2026-08-04T00:01:00Z" },
  );
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:02:00Z",
  });
  const store = new MemoryStore(selected.queue);
  const result = await runDevDeliveryCommand(
    { ...options, execute: true, now: "2026-08-04T00:03:00Z" },
    store,
  );

  assert.equal(result.receipt.action, "active-warrant-noop");
  assert.equal(result.before.stateRoot, result.after.stateRoot);
  assert.equal(result.mutationApplied, false);
  assert.equal(store.writes.length, 0);
  assert.equal(result.warrant.fencingToken, selected.warrant.fencingToken);
  const terminalStates = new Set(["merged", "dequeued"]);
  // prettier-ignore
  const legacy = [{ candidateId: root("a"), pullRequestNumber: 200, status: "dequeued", enqueuedAt: "2026-08-05T08:35:09.541Z" }, { candidateId: root("b"), pullRequestNumber: 200, status: "merged", enqueuedAt: "2026-08-05T08:57:16.429Z" }];
  validateDevDeliveryCandidateChain(legacy, terminalStates);
  legacy[1].enqueuedAt = "2026-08-06T00:00:00.000Z";
  // prettier-ignore
  assert.throws(() => validateDevDeliveryCandidateChain(legacy, terminalStates), /same-PR successor must chain/u);
});

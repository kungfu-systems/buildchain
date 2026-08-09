import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GitHubDevDeliveryStore, defaultDevDeliveryStateRef, runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";
import { createDevDeliveryQueue, selectDevDeliveryWarrant, submitDevDeliveryCandidate } from "../packages/core/dev-delivery-warrant.js";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

function initialQueue() {
  return createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-04T00:00:00Z",
  });
}

function submitOptions(overrides = {}) {
  return {
    command: "submit",
    repository: "kungfu-systems/kungfu",
    branch: "dev/v4/v4.0",
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
    deliveryClass: "native-proof-required",
    priority: "ordinary",
    now: "2026-08-04T00:01:00Z",
    ...overrides,
  };
}

class MemoryStore {
  constructor(queue = initialQueue()) {
    this.queue = queue;
    this.commitSha = "a".repeat(40);
    this.writes = [];
  }

  async read() {
    return { exists: true, commitSha: this.commitSha, queue: this.queue };
  }

  async write(input) {
    if (input.expectedCommitSha !== this.commitSha) throw new Error("commit CAS mismatch");
    if (input.expectedStateRoot !== this.queue.stateRoot) throw new Error("state CAS mismatch");
    this.writes.push(input);
    this.queue = input.queue;
    this.commitSha = "b".repeat(40);
    return { commitSha: this.commitSha, stateRoot: this.queue.stateRoot };
  }
}

class ConcurrentTerminalStore extends MemoryStore {
  constructor(queue) {
    super(queue);
    this.raced = false;
  }

  async write(input) {
    if (!this.raced) {
      this.raced = true;
      this.queue = input.queue;
      this.commitSha = "c".repeat(40);
      throw new Error("Update is not a fast forward");
    }
    return super.write(input);
  }
}

test("state refs are deterministic and remain inside the Buildchain namespace", () => {
  assert.equal(defaultDevDeliveryStateRef("dev/v4/v4.0"), "buildchain/dev-delivery-warrant/dev-v4-v4.0");
});

test("plan mode emits rooted receipts without writing authority", async () => {
  const store = new MemoryStore();
  const result = await runDevDeliveryCommand(submitOptions(), store);
  assert.equal(result.mode, "plan");
  assert.equal(result.mutationAuthorized, false);
  assert.equal(result.mutationApplied, false);
  assert.equal(store.writes.length, 0);
  assert.notEqual(result.before.stateRoot, result.after.stateRoot);
  assert.equal(result.receipt.expectedOldStateRoot, result.before.stateRoot);
});

test("execute mode persists one expected-old transition and exact readback root", async () => {
  const store = new MemoryStore();
  const result = await runDevDeliveryCommand(submitOptions({ execute: true }), store);
  assert.equal(result.mode, "execute");
  assert.equal(result.mutationApplied, true);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].expectedStateRoot, result.before.stateRoot);
  assert.equal(store.writes[0].queue.stateRoot, result.after.stateRoot);
  assert.equal(result.after.commitSha, "b".repeat(40));
});

test("stale expected-old input fails before any write", async () => {
  const store = new MemoryStore();
  await assert.rejects(runDevDeliveryCommand(submitOptions({ execute: true, expectedOldStateRoot: ROOT("f") }), store), /expected-old state drift/);
  assert.equal(store.writes.length, 0);
});

test("selection and observation use the same durable state contract", async () => {
  const store = new MemoryStore();
  await runDevDeliveryCommand(submitOptions({ execute: true }), store);
  const selected = await runDevDeliveryCommand(
    {
      command: "select",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: "2026-08-04T00:02:00Z",
      execute: true,
    },
    store,
  );
  assert.equal(selected.receipt.selected, true);
  assert.equal(selected.observation.states.selected, 1);

  const observed = await runDevDeliveryCommand(
    {
      command: "observe",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: "2026-08-04T00:02:01Z",
    },
    store,
  );
  assert.equal(observed.mode, "observe");
  assert.equal(observed.observation.activeWarrant.fencingToken, selected.warrant.fencingToken);
});

test("expired Warrant recovery and reselection persist as one expected-old transition", async () => {
  const store = new MemoryStore();
  await runDevDeliveryCommand(submitOptions({ execute: true }), store);
  const selected = await runDevDeliveryCommand({ command: "select", repository: "kungfu-systems/kungfu", branch: "dev/v4/v4.0", now: "2026-08-04T00:02:00Z", leaseSeconds: 60, execute: true }, store);
  const reselected = await runDevDeliveryCommand({ command: "select", repository: "kungfu-systems/kungfu", branch: "dev/v4/v4.0", now: "2026-08-04T00:04:00Z", leaseSeconds: 60, execute: true }, store);
  assert.equal(reselected.receipt.expectedOldStateRoot, selected.after.stateRoot);
  assert.equal(reselected.warrant.generation, selected.warrant.generation + 1);
  assert.equal(reselected.mutationApplied, true);
  assert.equal(store.writes.length, 3);
});

test("terminal settlement records a verified non-applicable no-op without writing", async () => {
  const store = new MemoryStore();
  const result = await runDevDeliveryCommand({
    command: "settle",
    repository: "kungfu-systems/kungfu",
    branch: "dev/v4/v4.0",
    pullRequestNumber: 2545,
    expectedSourceHead: "c".repeat(40),
    outcome: "merged",
    reason: "Warrant rollout was off",
    now: "2026-08-04T00:02:00Z",
    execute: true,
  }, store);
  assert.equal(result.mode, "execute");
  assert.equal(result.mutationApplied, false);
  assert.equal(result.receipt.action, "terminal-event-not-applicable");
  assert.equal(result.after.commitSha, store.commitSha);
  assert.equal(result.after.stateRoot, result.before.stateRoot);
  assert.equal(store.writes.length, 0);
});

test("terminal settlement reconciles a concurrent identical winner as an exact no-op", async () => {
  const submitted = submitDevDeliveryCandidate(initialQueue(), {
    ...submitOptions(),
    pullRequestNumber: 2549,
  }, { now: "2026-08-04T00:01:00Z" });
  const selected = selectDevDeliveryWarrant(submitted.queue, { now: "2026-08-04T00:02:00Z" });
  const store = new ConcurrentTerminalStore(selected.queue);
  const result = await runDevDeliveryCommand({
    command: "settle",
    repository: "kungfu-systems/kungfu",
    branch: "dev/v4/v4.0",
    pullRequestNumber: 2549,
    expectedSourceHead: "a".repeat(40),
    fencingToken: selected.warrant.fencingToken,
    leaseGeneration: selected.warrant.generation,
    outcome: "merged",
    evidenceRoot: ROOT("e"),
    reason: "protected pull request merged",
    now: "2026-08-04T00:03:00Z",
    execute: true,
  }, store);
  assert.equal(result.mutationApplied, false);
  assert.equal(result.receipt.action, "duplicate-terminal-event-noop");
  assert.equal(result.before.commitSha, "c".repeat(40));
  assert.equal(result.after.commitSha, "c".repeat(40));
  assert.equal(result.concurrencyRecovery.action, "terminal-settlement-race-noop");
  assert.equal(result.concurrencyRecovery.initialCommitSha, "a".repeat(40));
});

test("terminal workflow resolves active fencing or an explicit settlement no-op", () => {
  const workflow = fs.readFileSync(path.join(REPOSITORY_ROOT, ".github/workflows/dev-delivery-warrant-close.yml"), "utf8");
  assert.match(workflow, /name: Resolve terminal settlement mode[\s\S]*mode=inactive/u);
  assert.match(workflow, /activeCandidate\.candidateId == \.observation\.activeWarrant\.candidateId/u);
  assert.match(workflow, /dev-delivery-warrant\.mjs "\$\{args\[@\]\}"/u);
  assert.match(workflow, /settle[\s\S]*--pull-request "\$\{EXPECTED_PR\}"[\s\S]*--expected-source-head "\$\{EXPECTED_HEAD\}"/u);
});

test("queued cancellation persists once and repeats as an exact no-op", async () => {
  const store = new MemoryStore();
  const submitted = await runDevDeliveryCommand(submitOptions({ execute: true }), store);
  const queued = submitted.observation.queued[0];
  const options = {
    command: "cancel-queued",
    repository: "kungfu-systems/kungfu",
    branch: "dev/v4/v4.0",
    candidateId: queued.candidateId,
    pullRequestNumber: queued.pullRequestNumber,
    expectedSourceHead: queued.sourceHead,
    observedSourceHead: "f".repeat(40),
    expectedOldStateRoot: submitted.after.stateRoot,
    eventAction: "closed",
    outcome: "cancelled",
    evidenceRoot: ROOT("e"),
    reason: "pull request closed",
    now: "2026-08-04T00:02:00Z",
    execute: true,
  };
  const cancelled = await runDevDeliveryCommand(options, store);
  assert.equal(cancelled.mutationApplied, true);
  assert.equal(cancelled.receipt.action, "queued-candidate-cancelled");
  assert.equal(cancelled.observation.states.cancelled, 1);
  assert.equal(store.writes.length, 2);

  const duplicate = await runDevDeliveryCommand(
    {
      ...options,
      expectedOldStateRoot: cancelled.after.stateRoot,
      now: "2026-08-04T00:03:00Z",
    },
    store,
  );
  assert.equal(duplicate.mutationApplied, false);
  assert.equal(duplicate.receipt.action, "duplicate-cancellation-noop");
  assert.equal(duplicate.after.stateRoot, cancelled.after.stateRoot);
  assert.equal(store.writes.length, 2);
});

test("queued cancellation loses a concurrent expected-old race without writing", async () => {
  const store = new MemoryStore();
  const submitted = await runDevDeliveryCommand(submitOptions({ execute: true }), store);
  const queued = submitted.observation.queued[0];
  await runDevDeliveryCommand(
    submitOptions({
      pullRequestNumber: 201,
      sourceIdentityRoot: ROOT("a"),
      sourceHead: "b".repeat(40),
      now: "2026-08-04T00:02:00Z",
      execute: true,
    }),
    store,
  );
  await assert.rejects(
    runDevDeliveryCommand(
      {
        command: "cancel-queued",
        repository: "kungfu-systems/kungfu",
        branch: "dev/v4/v4.0",
        candidateId: queued.candidateId,
        pullRequestNumber: queued.pullRequestNumber,
        expectedSourceHead: queued.sourceHead,
        observedSourceHead: queued.sourceHead,
        expectedOldStateRoot: submitted.after.stateRoot,
        eventAction: "closed",
        outcome: "cancelled",
        evidenceRoot: ROOT("e"),
        now: "2026-08-04T00:03:00Z",
        execute: true,
      },
      store,
    ),
    /expected-old state drift/,
  );
  assert.equal(store.writes.length, 2);
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("GitHub state store advances a non-forced child commit and verifies its immutable commit", async () => {
  const beforeCommit = "a".repeat(40);
  const nextCommit = "b".repeat(40);
  const state = initialQueue();
  const changed = submitDevDeliveryCandidate(
    state,
    {
      pullRequestNumber: 201,
      sourceHead: "c".repeat(40),
      assignmentRoot: ROOT("1"),
      initiativeRoot: ROOT("2"),
      sourceIdentityRoot: ROOT("3"),
      sourcePatchRoot: ROOT("4"),
      sourceProofRoot: ROOT("9"),
      planRoot: ROOT("5"),
      closureRoot: ROOT("6"),
      dependencyRoot: ROOT("7"),
      toolchainRoot: ROOT("8"),
      deliveryClass: "native-proof-required",
      priority: "ordinary",
    },
    { now: "2026-08-04T00:01:00Z" },
  );
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (options.method === "POST" && url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
    if (options.method === "POST" && url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
    if (options.method === "POST" && url.endsWith("/git/commits")) return jsonResponse({ sha: nextCommit });
    if (options.method === "PATCH" && url.includes("/git/refs/heads/")) return jsonResponse({ object: { sha: nextCommit } });
    if (options.method === "GET" && url.includes("/git/ref/heads/")) throw new Error("write must not reread the mutable state ref after its expected-old update");
    if (options.method === "GET" && url.endsWith(`/git/commits/${nextCommit}`)) return jsonResponse({ tree: { sha: "tree-sha" } });
    if (options.method === "GET" && url.endsWith("/git/trees/tree-sha")) {
      return jsonResponse({
        tree: [{ path: "queue.json", type: "blob", sha: "blob-sha" }],
      });
    }
    if (options.method === "GET" && url.endsWith("/git/blobs/blob-sha")) {
      return jsonResponse({
        encoding: "base64",
        content: Buffer.from(`${JSON.stringify(changed.queue)}\n`).toString("base64"),
      });
    }
    throw new Error(`unexpected request: ${options.method} ${url}`);
  };
  const store = new GitHubDevDeliveryStore({
    repository: "kungfu-systems/kungfu",
    token: "test-token",
    fetchImpl,
  });
  const result = await store.write({
    stateRef: defaultDevDeliveryStateRef("dev/v4/v4.0"),
    queue: changed.queue,
    expectedCommitSha: beforeCommit,
    expectedStateRoot: state.stateRoot,
    receiptRoot: changed.receiptRoot,
  });
  assert.equal(result.commitSha, nextCommit);
  assert.equal(result.stateRoot, changed.queue.stateRoot);
  const commitCall = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/commits"));
  assert.deepEqual(commitCall.body.parents, [beforeCommit]);
  const updateCall = calls.find((call) => call.method === "PATCH");
  assert.equal(updateCall.body.force, false);
  assert.equal(calls.some((call) => call.method === "GET" && call.url.includes("/git/ref/heads/")), false);
});

test("GitHub state store exposes a concurrent non-fast-forward rejection", async () => {
  const state = initialQueue();
  const changed = submitDevDeliveryCandidate(
    state,
    {
      ...submitOptions(),
      pullRequestNumber: 202,
    },
    { now: "2026-08-04T00:01:00Z" },
  );
  const fetchImpl = async (url, options) => {
    if (options.method === "POST" && url.endsWith("/git/blobs")) return jsonResponse({ sha: "blob-sha" });
    if (options.method === "POST" && url.endsWith("/git/trees")) return jsonResponse({ sha: "tree-sha" });
    if (options.method === "POST" && url.endsWith("/git/commits")) return jsonResponse({ sha: "b".repeat(40) });
    if (options.method === "PATCH") return jsonResponse({ message: "Update is not a fast forward" }, 422);
    throw new Error(`unexpected request: ${options.method} ${url}`);
  };
  const store = new GitHubDevDeliveryStore({
    repository: "kungfu-systems/kungfu",
    token: "test-token",
    fetchImpl,
  });
  await assert.rejects(
    store.write({
      stateRef: defaultDevDeliveryStateRef("dev/v4/v4.0"),
      queue: changed.queue,
      expectedCommitSha: "a".repeat(40),
      expectedStateRoot: state.stateRoot,
      receiptRoot: changed.receiptRoot,
    }),
    /not a fast forward/,
  );
});

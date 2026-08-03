// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDevDeliveryCommand,
  contentRoot,
  createDevDeliveryQueue,
  DEV_DELIVERY_POLICY_VERSION,
  projectDevDeliveryQueue,
  queueRevision,
  rankQueuedCandidates,
} from "../scripts/dev-delivery-warrant-queue.mjs";
import {
  applyPersistedDevDeliveryCommand,
  bootstrapPersistedDevDeliveryQueue,
  loadPersistedDevDeliveryQueue,
  persistDevDeliveryQueue,
} from "../scripts/dev-delivery-warrant-store.mjs";

const ROOT_A = `sha256:${"a".repeat(64)}`;
const ROOT_B = `sha256:${"b".repeat(64)}`;
const ROOT_C = `sha256:${"c".repeat(64)}`;
const ROOT_D = `sha256:${"d".repeat(64)}`;
const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const SHA_C = "3".repeat(40);
const T0 = "2026-08-04T00:00:00.000Z";

function queue(overrides = {}) {
  return createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: T0,
    agingQuantumSeconds: 300,
    warrantTtlSeconds: 600,
    ...overrides,
  });
}

function candidate(number, overrides = {}) {
  return {
    pullRequestNumber: number,
    sourceHeadSha: overrides.sourceHeadSha || SHA_A,
    semanticSourceRoot: overrides.semanticSourceRoot || ROOT_A,
    assignmentRoot: overrides.assignmentRoot || ROOT_B,
    initiativeRoot: overrides.initiativeRoot || ROOT_C,
    deliveryClass: overrides.deliveryClass || "native-proof-required",
    priority: overrides.priority || "ordinary",
    priorityReason: overrides.priorityReason,
    priorityPolicyRoot: overrides.priorityPolicyRoot,
  };
}

function command(state, action, now, overrides = {}) {
  return {
    action,
    expectedOldRevision: state.revision,
    controllerId: overrides.controllerId || "controller-a",
    now,
    ...overrides,
  };
}

function apply(state, action, now, overrides = {}) {
  return applyDevDeliveryCommand(state, command(state, action, now, overrides));
}

function submit(state, number, now, overrides = {}) {
  return apply(state, "submit", now, {
    candidate: candidate(number, overrides),
  });
}

function persistedApi(initialState, { putError = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, requestPath, input = {}) {
      calls.push({ method, requestPath, input });
      if (method === "GET") {
        return {
          data: {
            type: "file",
            encoding: "base64",
            content: Buffer.from(JSON.stringify(initialState)).toString(
              "base64",
            ),
            sha: "provider-blob-old",
            html_url: "https://example.invalid/state",
          },
        };
      }
      if (putError) throw putError;
      return {
        data: {
          content: {
            sha: "provider-blob-new",
            html_url: "https://example.invalid/state-new",
          },
          commit: { sha: "f".repeat(40) },
        },
      };
    },
  };
}

test("queue has a content-addressed versioned policy and exact revision", () => {
  const state = queue();
  assert.equal(state.policy.version, DEV_DELIVERY_POLICY_VERSION);
  assert.equal(state.revision, queueRevision(state));
  assert.match(state.revision, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(contentRoot({ b: 2, a: 1 }), contentRoot({ a: 1, b: 2 }));
});

test("same-priority candidates are selected FIFO by retained queue age", () => {
  let state = submit(queue(), 10, T0).state;
  state = submit(state, 11, "2026-08-04T00:00:01Z", {
    sourceHeadSha: SHA_B,
  }).state;
  const result = apply(state, "select", "2026-08-04T00:00:02Z");
  assert.equal(result.receipt.outcome, "selected");
  assert.equal(
    result.receipt.submissionId,
    state.candidates.find((entry) => entry.pullRequestNumber === 10)
      .submissionId,
  );
  assert.equal(
    result.state.activeWarrant.submissionId,
    result.receipt.submissionId,
  );
});

test("an unbounded stream of later ordinary candidates cannot starve the oldest", () => {
  let state = submit(queue(), 1, T0).state;
  for (let number = 2; number <= 102; number += 1) {
    state = submit(
      state,
      number,
      new Date(Date.parse(T0) + number * 1000).toISOString(),
      {
        sourceHeadSha: number.toString(16).padStart(40, "0"),
        semanticSourceRoot: `sha256:${number.toString(16).padStart(64, "0")}`,
      },
    ).state;
  }
  const ranked = rankQueuedCandidates(state, "2026-08-04T00:10:00Z");
  assert.equal(ranked[0].candidate.pullRequestNumber, 1);
  assert.equal(
    apply(state, "select", "2026-08-04T00:10:00Z").receipt.queueAgeSeconds,
    600,
  );
});

test("bounded priority can reorder only before selection and aging closes the gap", () => {
  let state = submit(queue(), 1, T0).state;
  state = submit(state, 2, "2026-08-04T00:00:01Z", {
    sourceHeadSha: SHA_B,
    semanticSourceRoot: ROOT_D,
    priority: "urgent",
  }).state;
  assert.equal(
    rankQueuedCandidates(state, "2026-08-04T00:00:02Z")[0].candidate
      .pullRequestNumber,
    2,
  );
  assert.equal(
    rankQueuedCandidates(state, "2026-08-04T00:05:00Z")[0].candidate
      .pullRequestNumber,
    1,
  );

  state = apply(state, "select", "2026-08-04T00:00:02Z").state;
  const selected = state.activeWarrant.submissionId;
  assert.throws(
    () =>
      apply(state, "reprioritize", "2026-08-04T00:00:03Z", {
        submissionId: selected,
        priority: "emergency",
      }),
    /priority cannot change after Warrant selection/u,
  );
});

test("emergency priority requires an explicit reviewed policy binding", () => {
  assert.throws(
    () => submit(queue(), 1, T0, { priority: "emergency" }),
    /emergency priority reason is required/u,
  );
  const result = submit(queue(), 1, T0, {
    priority: "emergency",
    priorityReason: "security",
    priorityPolicyRoot: ROOT_D,
  });
  assert.deepEqual(result.state.candidates[0].priorityEvidence, {
    reason: "security",
    reviewedPolicyRoot: ROOT_D,
  });
});

test("only one candidate can hold the non-preemptive active Warrant", () => {
  let state = submit(queue(), 1, T0).state;
  state = submit(state, 2, "2026-08-04T00:00:01Z", {
    sourceHeadSha: SHA_B,
  }).state;
  state = apply(state, "select", "2026-08-04T00:00:02Z").state;
  assert.throws(
    () => apply(state, "select", "2026-08-04T00:00:03Z"),
    /active Delivery Warrant already exists/u,
  );
  assert.equal(
    state.candidates.filter((entry) => entry.state === "warrant-issued").length,
    1,
  );
});

test("expected-old compare-and-set rejects a second concurrent controller", () => {
  const submitted = submit(queue(), 1, T0).state;
  const staleCommand = command(submitted, "select", "2026-08-04T00:00:01Z", {
    controllerId: "controller-b",
  });
  const winner = applyDevDeliveryCommand(submitted, {
    ...staleCommand,
    controllerId: "controller-a",
  });
  assert.throws(
    () => applyDevDeliveryCommand(winner.state, staleCommand),
    /expected-old revision mismatch/u,
  );
});

test("duplicate submission is an exact idempotent no-op", () => {
  const first = submit(queue(), 1, T0);
  const duplicate = submit(first.state, 1, "2026-08-04T00:00:10Z");
  assert.equal(duplicate.receipt.outcome, "duplicate-no-op");
  assert.equal(duplicate.state.revision, first.state.revision);
  assert.equal(duplicate.state.history.length, first.state.history.length);
  assert.equal(duplicate.state.candidates.length, 1);
});

test("heartbeat renews only the current unexpired fenced Warrant", () => {
  let state = submit(queue(), 1, T0).state;
  state = apply(state, "select", "2026-08-04T00:00:01Z").state;
  const warrant = state.activeWarrant;
  const renewed = apply(state, "heartbeat", "2026-08-04T00:05:00Z", {
    warrantId: warrant.warrantId,
    fencingToken: warrant.fencingToken,
  });
  assert.equal(renewed.receipt.outcome, "renewed");
  assert.equal(
    renewed.state.activeWarrant.expiresAt,
    "2026-08-04T00:15:00.000Z",
  );
  assert.throws(
    () =>
      apply(renewed.state, "heartbeat", "2026-08-04T00:15:00Z", {
        warrantId: warrant.warrantId,
        fencingToken: warrant.fencingToken,
      }),
    /lease expired/u,
  );
});

test("expired Warrant recovery retains queue age and advances fencing generation", () => {
  let state = submit(queue(), 1, T0).state;
  state = apply(state, "select", "2026-08-04T00:00:01Z").state;
  const firstWarrant = state.activeWarrant;
  state = apply(state, "recover", "2026-08-04T00:10:02Z", {
    controllerId: "controller-b",
  }).state;
  assert.equal(state.activeWarrant, null);
  assert.equal(state.candidates[0].retainedEnqueuedAt, T0);
  assert.equal(state.metrics.recoveredWarrants, 1);
  state = apply(state, "select", "2026-08-04T00:10:03Z", {
    controllerId: "controller-b",
  }).state;
  assert.equal(state.activeWarrant.generation, firstWarrant.generation + 1);
  assert.notEqual(state.activeWarrant.fencingToken, firstWarrant.fencingToken);
});

test("delayed callback from a recovered controller is rejected by fencing", () => {
  let state = submit(queue(), 1, T0).state;
  state = apply(state, "select", "2026-08-04T00:00:01Z").state;
  const stale = state.activeWarrant;
  state = apply(state, "recover", "2026-08-04T00:10:02Z").state;
  state = apply(state, "select", "2026-08-04T00:10:03Z", {
    controllerId: "controller-b",
  }).state;
  assert.throws(
    () =>
      apply(state, "transition", "2026-08-04T00:10:04Z", {
        warrantId: stale.warrantId,
        fencingToken: stale.fencingToken,
        state: "proving",
        reason: "delayed-callback",
      }),
    /stale Warrant id/u,
  );
});

test("same-semantic-source head repair retains age and changed source fails closed", () => {
  let state = submit(queue(), 1, T0).state;
  const original = state.candidates[0];
  const repaired = apply(state, "repair", "2026-08-04T00:02:00Z", {
    submissionId: original.submissionId,
    sourceHeadSha: SHA_B,
    semanticSourceRoot: original.semanticSourceRoot,
  });
  assert.equal(repaired.receipt.retainedEnqueuedAt, T0);
  assert.equal(repaired.state.candidates[0].sourceHeadSha, SHA_B);
  assert.notEqual(
    repaired.state.candidates[0].submissionId,
    original.submissionId,
  );
  assert.throws(
    () =>
      apply(repaired.state, "repair", "2026-08-04T00:03:00Z", {
        submissionId: repaired.state.candidates[0].submissionId,
        sourceHeadSha: SHA_C,
        semanticSourceRoot: ROOT_D,
      }),
    /changed semantic source/u,
  );
});

test("terminal delivery closes the Warrant and exposes the next candidate", () => {
  let state = submit(queue(), 1, T0).state;
  state = submit(state, 2, "2026-08-04T00:00:01Z", {
    sourceHeadSha: SHA_B,
  }).state;
  state = apply(state, "select", "2026-08-04T00:00:02Z").state;
  const warrant = state.activeWarrant;
  state = apply(state, "transition", "2026-08-04T00:01:00Z", {
    warrantId: warrant.warrantId,
    fencingToken: warrant.fencingToken,
    state: "proving",
    reason: "native-shards-running",
  }).state;
  state = apply(state, "transition", "2026-08-04T00:02:00Z", {
    warrantId: warrant.warrantId,
    fencingToken: warrant.fencingToken,
    state: "merge-queued",
    reason: "native-queue-admitted",
  }).state;
  state = apply(state, "transition", "2026-08-04T00:03:00Z", {
    warrantId: warrant.warrantId,
    fencingToken: warrant.fencingToken,
    state: "merged",
    reason: "exact-merge-group-qualified",
  }).state;
  assert.equal(state.activeWarrant, null);
  assert.equal(state.candidates[0].state, "merged");
  assert.equal(
    rankQueuedCandidates(state, "2026-08-04T00:02:01Z")[0].candidate
      .pullRequestNumber,
    2,
  );
});

test("lifecycle transitions cannot skip the exact merge-group boundary", () => {
  let state = submit(queue(), 1, T0).state;
  state = apply(state, "select", "2026-08-04T00:00:01Z").state;
  const warrant = state.activeWarrant;
  assert.throws(
    () =>
      apply(state, "transition", "2026-08-04T00:00:02Z", {
        warrantId: warrant.warrantId,
        fencingToken: warrant.fencingToken,
        state: "merged",
        reason: "forged-shortcut",
      }),
    /invalid delivery transition warrant-issued -> merged/u,
  );
});

test("queue projection publishes visible state, age, position, and next action", () => {
  let state = submit(queue(), 1, T0).state;
  state = submit(state, 2, "2026-08-04T00:00:01Z", {
    sourceHeadSha: SHA_B,
  }).state;
  const view = projectDevDeliveryQueue(state, "2026-08-04T00:01:00Z");
  assert.equal(view.candidates[0].queuePosition, 1);
  assert.equal(view.candidates[0].queueAgeSeconds, 60);
  assert.equal(view.candidates[0].nextAction, "select-and-issue-warrant");
  assert.equal(view.candidates[1].nextAction, "wait-for-active-warrant");
});

test("selected repair and pre-expiry recovery fail closed", () => {
  let state = submit(queue(), 1, T0).state;
  const submissionId = state.candidates[0].submissionId;
  state = apply(state, "select", "2026-08-04T00:00:01Z").state;
  assert.throws(
    () =>
      apply(state, "repair", "2026-08-04T00:00:02Z", {
        submissionId,
        sourceHeadSha: SHA_B,
        semanticSourceRoot: ROOT_A,
      }),
    /must be settled before repair/u,
  );
  assert.throws(
    () => apply(state, "recover", "2026-08-04T00:00:03Z"),
    /has not expired/u,
  );
});

test("GitHub state-ref provider loads only a revision-valid bound queue", async () => {
  const state = queue();
  const api = persistedApi(state);
  const loaded = await loadPersistedDevDeliveryQueue({
    api,
    repository: state.repository,
    stateRef: "buildchain-state/dev-delivery/dev-v4-v4.0",
  });
  assert.equal(loaded.state.revision, state.revision);
  assert.equal(loaded.blobSha, "provider-blob-old");
  assert.match(api.calls[0].requestPath, /contents\/.buildchain\/state\//u);
});

test("state persistence uses the provider blob SHA as a second CAS fence", async () => {
  const state = submit(queue(), 1, T0).state;
  const api = persistedApi(state);
  const receipt = await persistDevDeliveryQueue({
    api,
    state,
    expectedBlobSha: "provider-blob-old",
    repository: state.repository,
    stateRef: "buildchain-state/dev-delivery/dev-v4-v4.0",
  });
  const put = api.calls.find((call) => call.method === "PUT");
  assert.equal(put.input.body.sha, "provider-blob-old");
  assert.equal(receipt.newBlobSha, "provider-blob-new");
  assert.equal(receipt.queueRevision, state.revision);
  assert.equal(
    JSON.parse(Buffer.from(put.input.body.content, "base64").toString("utf8"))
      .revision,
    state.revision,
  );
});

test("persisted command binds queue CAS and provider CAS in one receipt chain", async () => {
  const state = queue();
  const api = persistedApi(state);
  const result = await applyPersistedDevDeliveryCommand({
    api,
    repository: state.repository,
    stateRef: "buildchain-state/dev-delivery/dev-v4-v4.0",
    command: command(state, "submit", T0, { candidate: candidate(1) }),
  });
  assert.equal(result.receipt.outcome, "submitted");
  assert.equal(result.persistence.expectedBlobSha, "provider-blob-old");
  assert.equal(result.persistence.queueRevision, result.state.revision);
});

test("provider conflict rejects a stale controller without forged success", async () => {
  const state = queue();
  const conflict = new Error("conflict");
  conflict.status = 409;
  const api = persistedApi(state, { putError: conflict });
  await assert.rejects(
    applyPersistedDevDeliveryCommand({
      api,
      repository: state.repository,
      stateRef: "buildchain-state/dev-delivery/dev-v4-v4.0",
      command: command(state, "submit", T0, { candidate: candidate(1) }),
    }),
    (error) => error.code === "STALE_PROVIDER_STATE",
  );
});

test("bootstrap creates a dedicated state ref from the exact protected base", async () => {
  const calls = [];
  const notFound = () => {
    const error = new Error("not found");
    error.status = 404;
    return error;
  };
  const api = {
    async request(method, requestPath, input = {}) {
      calls.push({ method, requestPath, input });
      if (method === "GET" && requestPath.includes("/contents/"))
        throw notFound();
      if (method === "GET" && requestPath.includes("/branches/")) {
        return { data: { commit: { sha: SHA_A } } };
      }
      if (method === "GET" && requestPath.includes("/git/ref/"))
        throw notFound();
      if (method === "POST" && requestPath.endsWith("/git/refs"))
        return { data: {} };
      if (method === "PUT") {
        return {
          data: {
            content: { sha: "provider-blob-new" },
            commit: { sha: "f".repeat(40) },
          },
        };
      }
      throw new Error(`unexpected request ${method} ${requestPath}`);
    },
  };
  const result = await bootstrapPersistedDevDeliveryQueue({
    api,
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    expectedBaseSha: SHA_A,
    stateRef: "buildchain-state/dev-delivery/dev-v4-v4.0",
    now: T0,
  });
  assert.equal(result.action, "created");
  assert.equal(result.createdRef, true);
  assert.deepEqual(calls.find((call) => call.method === "POST").input.body, {
    ref: "refs/heads/buildchain-state/dev-delivery/dev-v4-v4.0",
    sha: SHA_A,
  });
  assert.equal(
    calls.find((call) => call.method === "PUT").input.body.sha,
    undefined,
  );
});

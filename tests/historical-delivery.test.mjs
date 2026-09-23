import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDevDeliveryCandidateIdentity,
  reuseExactActiveDevDeliverySourceProof,
} from "../packages/core/dev-delivery/dev-delivery-candidate-identity.js";
import {
  createDevDeliveryQueue,
  submitDevDeliveryCandidate,
  normalizeDevDeliveryQueue,
  selectDevDeliveryWarrant,
  closeDevDeliveryWarrant,
} from "../packages/core/dev-delivery/dev-delivery-warrant.js";
import { deliverySubmissionRequest } from "../packages/core/dev-delivery/candidate/submission.js";
import { historicalDeliveryRootOptions } from "../packages/core/dev-delivery/commands/dev-delivery-warrant-options.mjs";
import { handoffInputs } from "../packages/core/dev-delivery/warrant/handoff.js";
const frozen = JSON.parse(
  fs.readFileSync(
    new URL(
      "../contracts/fixtures/consumer-upgrade/dev-delivery-identity-v4.0.0.json",
      import.meta.url,
    ),
  ),
);
const root = `sha256:${"a".repeat(64)}`;
function candidate() {
  return {
    ...frozen.input,
    sourceHead: "a".repeat(40),
    sourcePatchRoot: root,
    sourceProofRoot: root,
    planRoot: root,
    closureRoot: root,
    dependencyRoot: root,
    toolchainRoot: root,
    sourceWorkflowRunId: 123,
  };
}
test("historical delivery identity exactly matches the published v4.0 implementation", () => {
  assert.deepEqual(
    createDevDeliveryCandidateIdentity(
      frozen.input,
      frozen.expected,
      (value) => value,
    ),
    frozen.identity,
  );
  assert.throws(
    () =>
      createDevDeliveryCandidateIdentity(
        { ...frozen.input, sourceRoot: root },
        frozen.expected,
        (value) => value,
      ),
    /sourceRoot alone/,
  );
});
test("a persisted historical queue retains candidate and Warrant identity through readback and close", () => {
  const initial = createDevDeliveryQueue({
    ...frozen.expected,
    now: "2026-08-04T00:00:00Z",
  });
  const submitted = submitDevDeliveryCandidate(initial, candidate(), {
    now: "2026-08-04T00:00:01Z",
  });
  assert.equal(submitted.receipt.candidateId, frozen.identity.candidateId);
  const retained = JSON.parse(JSON.stringify(submitted.queue));
  assert.deepEqual(normalizeDevDeliveryQueue(retained), retained);
  const selected = selectDevDeliveryWarrant(retained, {
    now: "2026-08-04T00:00:02Z",
  });
  assert.equal(selected.warrant.assignmentRoot, frozen.input.assignmentRoot);
  assert.equal(selected.warrant.initiativeRoot, frozen.input.initiativeRoot);
  assert.equal(selected.warrant.candidateId, frozen.identity.candidateId);
  assert.deepEqual(normalizeDevDeliveryQueue(selected.queue), selected.queue);
  const closed = closeDevDeliveryWarrant(selected.queue, selected.warrant, {
    outcome: "dequeued",
    evidenceRoot: root,
    reason: "fixture cancellation",
    now: "2026-08-04T00:00:03Z",
  });
  assert.equal(
    closed.queue.candidates[0].candidateId,
    frozen.identity.candidateId,
  );
});
test("historical source proofs cannot be reused for a different Assignment", () => {
  const input = candidate(),
    active = { ...input, phase: "ready" };
  assert.notEqual(reuseExactActiveDevDeliverySourceProof(active, input), input);
  const changed = { ...input, assignmentRoot: root };
  assert.equal(
    reuseExactActiveDevDeliverySourceProof(active, changed),
    changed,
  );
});
test("workflow submission and native handoff preserve both historical roots", (t) => {
  const input = {
    "assignment-root": frozen.input.assignmentRoot,
    "initiative-root": frozen.input.initiativeRoot,
  };
  const submitted = deliverySubmissionRequest(input, {
    repository: frozen.expected.repository,
    branch: frozen.expected.protectedBase,
    sourceProofRoot: root,
    affectedPaths: [],
  });
  assert.equal(submitted.assignmentRoot, frozen.input.assignmentRoot);
  assert.equal(submitted.initiativeRoot, frozen.input.initiativeRoot);
  assert.equal(Object.hasOwn(submitted, "sourceRoot"), false);
  const handoff = handoffInputs(
    { ...candidate(), phase: "ready" },
    {
      workflowId: "dev.yml",
      branch: frozen.expected.protectedBase,
      heartbeatSeconds: 15,
    },
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "historical-handoff-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const event = path.join(directory, "event.json");
  fs.writeFileSync(event, JSON.stringify({ inputs: handoff }));
  assert.deepEqual(
    historicalDeliveryRootOptions([], { GITHUB_EVENT_PATH: event }),
    {
      assignmentRoot: frozen.input.assignmentRoot,
      initiativeRoot: frozen.input.initiativeRoot,
    },
  );
});

test("historical native delivery retains the current execution and lease fencing requirements", async () => {
  const { createNativeCommandContract, heartbeatDevDeliveryWarrant } =
    await import("../packages/core/dev-delivery/dev-delivery-warrant.js");
  const initial = createDevDeliveryQueue({
    ...frozen.expected,
    now: "2026-08-04T00:00:00Z",
  });
  const native = {
    ...candidate(),
    deliveryClass: "native-proof-required",
    environmentRoot: root,
    nativeCommandContract: createNativeCommandContract(
      "go test -race ./... && go vet ./...",
    ),
  };
  const submitted = submitDevDeliveryCandidate(initial, native, {
    now: "2026-08-04T00:00:01Z",
  });
  const selected = selectDevDeliveryWarrant(submitted.queue, {
    now: "2026-08-04T00:00:02Z",
  });
  assert.equal(selected.warrant.assignmentRoot, native.assignmentRoot);
  assert.equal(
    selected.warrant.nativeCommandContract.command,
    native.nativeCommandContract.command,
  );
  const heartbeat = heartbeatDevDeliveryWarrant(
    selected.queue,
    selected.warrant,
    { now: "2026-08-04T00:00:03Z" },
  );
  assert.equal(
    heartbeat.queue.activeWarrant.candidateId,
    selected.warrant.candidateId,
  );
  assert.deepEqual(normalizeDevDeliveryQueue(heartbeat.queue), heartbeat.queue);
  assert.throws(
    () =>
      heartbeatDevDeliveryWarrant(
        heartbeat.queue,
        { ...selected.warrant, candidateId: root },
        { now: "2026-08-04T00:00:04Z" },
      ),
    /candidate|Warrant|warrant/,
  );
});

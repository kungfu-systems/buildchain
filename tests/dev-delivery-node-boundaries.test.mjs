import test from "node:test";
import assert from "node:assert/strict";
import {
  sourceCoordinates,
  validateNativeContract,
  validateRuntimeSelector,
} from "../packages/core/dev-delivery/candidate/coordinates.js";
import { assertBranchUnlocked } from "../packages/core/dev-delivery/../providers/dev-delivery/protection.js";
import { deliverySubmissionRequest } from "../packages/core/dev-delivery/candidate/submission.js";
import { reserveDeliveryCandidate } from "../packages/core/dev-delivery/candidate/reservation.js";
import { enforceLanding } from "../packages/core/dev-delivery/queue/completion.js";
import { command } from "../packages/core/runtime/action-process.mjs";
import { verifyNativeQualificationReadback } from "../packages/core/dev-delivery/native/readback.js";
import { verifyFailureSettlement } from "../packages/core/dev-delivery/warrant/failure-settlement.js";
import { settlementMode } from "../packages/core/dev-delivery/warrant/terminal-policy.js";
import {
  verifyReservationReadback,
  reservationOutputs,
} from "../packages/core/dev-delivery/warrant/reservation-readback.js";
import { handoffInputs } from "../packages/core/dev-delivery/warrant/handoff.js";
import {
  createDevDeliveryQueue,
  submitDevDeliveryCandidate,
  selectDevDeliveryWarrant,
  normalizeDevDeliveryQueue,
  devDeliveryContentRoot,
} from "../packages/core/dev-delivery/dev-delivery-warrant.js";

test("source coordinates reject ambiguous heads, invalid modes and required dry runs", () => {
  const env = {
    defaultBranch: "dev/v4/v4.1",
    warrantMode: "required",
    pullRequestNumber: "123",
    expectedHead: "a".repeat(40),
    dryRun: false,
  };
  assert.deepEqual(sourceCoordinates(env), {
    branch: "dev/v4/v4.1",
    "branch-artifact": "dev-v4-v4.1",
  });
  for (const change of [
    { expectedHead: "dev/v4/v4.1" },
    { pullRequestNumber: "0" },
    { dryRun: true },
    { warrantMode: "fallback" },
    { branch: "dev/v4/v4.1\nnext=bad" },
  ])
    assert.throws(() => sourceCoordinates({ ...env, ...change }));
});
test("native source admission requires an exact environment before effects", () => {
  validateNativeContract({
    deliveryClass: "native-proof-required",
    environmentRoot: `sha256:${"b".repeat(64)}`,
  });
  validateNativeContract({ deliveryClass: "non-native-fast" });
  assert.throws(() =>
    validateNativeContract({
      deliveryClass: "release",
      environmentRoot: "current",
    }),
  );
  assert.throws(() => validateNativeContract({ deliveryClass: "unknown" }));
});
test("runtime selector admits the current version line without old runtime defaults", () => {
  for (const value of [
    "v4",
    "v4-alpha",
    "c".repeat(40),
    "train/v4/v4.1/native",
  ])
    validateRuntimeSelector({ runtimeRef: value });
  for (const value of ["v3", "", "train/v4/v4.1/../secret", "dev/v4/v4.1"])
    assert.throws(() => validateRuntimeSelector({ runtimeRef: value }));
});
test("locked branch check combines classic and applied protection and fails closed", async () => {
 const input = { branch: "dev/v4/v4.1", repository: "owner/repo" };
 const run = (classic, rules) => assertBranchUnlocked(input, { request: async endpoint => {
  assert.match(endpoint, /dev%2Fv4%2Fv4\.1/u);
  const value = endpoint.endsWith("/protection") ? classic : rules;
  if (value instanceof Error) throw value;
  return value;
 } });
 const missing = Object.assign(new Error("not found"), { status: 404 });
 await run({ lock_branch: { enabled: false } }, []); await run(missing, []);
 await assert.rejects(run({ lock_branch: { enabled: true } }, []), /locked/u);
 await assert.rejects(run(missing, [{ type: "update" }]), /locked/u);
 await assert.rejects(run(Object.assign(new Error("denied"), { status: 403 }), []), /Unable/u);
 await assert.rejects(run(missing, new Error("denied")), /Unable/u);
});
test("candidate submission retains literal native commands and executes only in required mode", () => {
 const input = { "delivery-warrant-mode": "shadow", "native-command": 'echo "$(secret)"; exit 7', "environment-root": `sha256:${"d".repeat(64)}`, "source-workflow-run-id": 123 };
 const context = { affectedPaths: [] };
 const request = deliverySubmissionRequest(input, context);
 assert.equal(request.nativeCommand, input["native-command"]); assert.equal(request.execute, false);
 assert.equal(deliverySubmissionRequest({ ...input, "delivery-warrant-mode": "required" }, context).execute, true);
 assert.throws(() => deliverySubmissionRequest({ ...input, "environment-root": "" }, context), /environment root/u);
});
test("source and proof failures cannot reach Warrant submission", async () => {
 let submitted = false;
 const request = { workspace: ".", input: { "delivery-warrant-mode": "required" }, qualificationOutcome: "failure", proofOutcome: "success", predecessorsOk: true };
 const dependencies = { service: { submit: () => { submitted = true; } } };
 await assert.rejects(reserveDeliveryCandidate(request, dependencies), /source qualification/u);
 await assert.rejects(reserveDeliveryCandidate({ ...request, qualificationOutcome: "success", proofOutcome: "failure" }, dependencies), /submission failed/u);
 await assert.rejects(reserveDeliveryCandidate({ ...request, qualificationOutcome: "success", predecessorsOk: false }, dependencies), /submission failed/u);
 assert.equal(submitted, false);
});
test("landing needs verified native seal and heartbeat; settled failure remains failure", () => {
  const env = {
    warrantMode: "required",
    alreadyQualified: "true",
    runNative: "true",
    sealJobOutcome: "success",
    heartbeatJobOutcome: "success",
    mergeStepOutcome: "success",
    targeted: "true",
    targetedOk: "true",
  };
  enforceLanding(env);
  for (const change of [
    { sealJobOutcome: "failure" },
    { heartbeatJobOutcome: "cancelled" },
    { mergeStepOutcome: "failure" },
    { targetedOk: "false" },
    { alreadyQualified: "false" },
  ])
    assert.throws(() => enforceLanding({ ...env, ...change }));
  assert.throws(
    () =>
      enforceLanding({
        ...env,
        nativeJobOutcome: "failure",
        failureSettlementOutcome: "success",
      }),
    /settled the retained fence/u,
  );
  assert.throws(
    () =>
      enforceLanding({ ...env, deferLanding: "true", warrantMode: "off" }),
    /requires/u,
  );
});
test("node IO preserves a child failure and never evaluates shell metacharacters", () => {
  assert.throws(
    () => command(process.execPath, ["-e", "process.exit(23)"]),
    (error) => error.status === 23,
  );
  const marker = "$(echo unsafe); literal";
  assert.equal(
    command(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", marker],
      { stdio: ["ignore", "pipe", "inherit"] },
    ),
    marker,
  );

});

const root = (value) => `sha256:${value.repeat(64)}`;
test("native qualification readback rejects a different phase or source head", () => {
 const env = { pullRequestNumber: 123, expectedHead: "a".repeat(40) };
  const result = {
    ok: true,
    outcome: "native-proof-ready",
    qualifiedWarrant: {
      phase: "provisional",
      pullRequestNumber: 123,
      sourceHead: env.expectedHead,
    },
    nativeProofRoot: root("a"),
    nativeReuseDecisionRoot: root("b"),
  };
  verifyNativeQualificationReadback(result, env, { native: true });
  assert.throws(() => verifyNativeQualificationReadback(result, env, { native: false }));
  assert.throws(() =>
    verifyNativeQualificationReadback(
      {
        ...result,
        qualifiedWarrant: {
          ...result.qualifiedWarrant,
          sourceHead: "b".repeat(40),
        },
      },
      env,
      { native: true },
    ),
  );
});
test("failure settlement locates its exact candidate and checks all provider-boundary roots", () => {
  const settlement = {
    pullRequestNumber: 7,
    sourceHead: "a".repeat(40),
    evidenceRoot: root("a"),
    transferRoot: root("b"),
    finalizerBoundaryRoot: root("c"),
    nativeJobId: 123,
    sealJobId: 456,
  };
  const candidate = {
    pullRequestNumber: 7,
    sourceHead: settlement.sourceHead,
    terminal: { ...settlement },
  };
  const result = {
    ok: true,
    receipt: {
      ...settlement,
      outcome: "terminal-failure",
      expectedOldStateRoot: root("d"),
    },
    observation: {
      candidates: [candidate, { pullRequestNumber: 8 }],
      activeWarrant: null,
    },
  };
  verifyFailureSettlement(result, settlement, root("d"));
  for (const key of [
    "transferRoot",
    "finalizerBoundaryRoot",
    "nativeJobId",
    "sealJobId",
  ]) {
    const altered = structuredClone(result);
    altered.observation.candidates[0].terminal[key] = "drift";
    assert.throws(
      () => verifyFailureSettlement(altered, settlement, root("d")),
      /drift/u,
    );
  }
  assert.throws(
    () =>
      verifyFailureSettlement(
        {
          ...result,
          observation: { ...result.observation, activeWarrant: {} },
        },
        settlement,
        root("d"),
      ),
    /retained/u,
  );
});
test("terminal settlement rejects another active candidate instead of treating it as inactive", () => {
  const env = { pullRequestNumber: 7, expectedSourceHead: "a".repeat(40) };
  const active = {
    pullRequestNumber: 7,
    sourceHead: env.expectedSourceHead,
    candidateId: root("a"),
  };
  assert.equal(settlementMode({ activeWarrant: null }, env), "inactive");
  assert.equal(
    settlementMode({ activeWarrant: active, activeCandidate: active }, env),
    "active",
  );
  assert.throws(() =>
    settlementMode(
      {
        activeWarrant: active,
        activeCandidate: { ...active, candidateId: root("b") },
      },
      env,
    ),
  );
});
test("new non-native Warrants declare ready and phase-less queues are rejected", () => {
  const now = "2026-09-09T00:00:00Z";
  const queue = createDevDeliveryQueue({
    repository: "owner/repo",
    protectedBase: "dev/v4/v4.1",
    now,
  });
  const candidate = {
    pullRequestNumber: 7,
    sourceHead: "a".repeat(40),
    sourceRoot: root("a"),
    sourceIdentityRoot: root("b"),
    sourcePatchRoot: root("c"),
    sourceProofRoot: root("d"),
    planRoot: root("e"),
    closureRoot: root("f"),
    dependencyRoot: root("1"),
    toolchainRoot: root("2"),
    deliveryClass: "non-native-fast",
    sourceWorkflowRunId: 123,
  };
  const selected = selectDevDeliveryWarrant(
    submitDevDeliveryCandidate(queue, candidate, { now }).queue,
    { now },
  );
  assert.equal(selected.warrant.phase, "ready");
  normalizeDevDeliveryQueue(selected.queue);
  const malformed = structuredClone(selected.queue);
  delete malformed.activeWarrant.phase;
  delete malformed.stateRoot;
  malformed.stateRoot = devDeliveryContentRoot(malformed);
  assert.throws(() => normalizeDevDeliveryQueue(malformed), /phase/u);
  const result = {
    schema: "kungfu.buildchain.dev-delivery-command-result/v1",
    mode: "execute",
    receiptRoot: root("3"),
    after: { commitSha: "b".repeat(40), stateRoot: selected.queue.stateRoot },
    warrant: selected.warrant,
    observation: {
      stateRoot: selected.queue.stateRoot,
      activeWarrant: selected.warrant,
      activeCandidate: selected.queue.candidates[0],
    },
  };
  const active = verifyReservationReadback(result);
  assert.equal(reservationOutputs(result, active)["already-qualified"], "true");
  assert.throws(() =>
    verifyReservationReadback({ ...result, mode: "dry-run" }),
  );
  const noPhase = structuredClone(result);
  delete noPhase.warrant.phase;
  delete noPhase.observation.activeWarrant.phase;
  assert.throws(() => verifyReservationReadback(noPhase), /phase/u);
  const env = {
    workflowId: "self-ops-dev-delivery.yml",
    branch: "dev/v4/v4.1",
  };
  assert.equal(handoffInputs(active, env)["source-workflow-run-id"], 123);
  assert.throws(
    () => handoffInputs({ ...active, sourceWorkflowRunId: 0 }, env),
    /recorded exact/u,
  );
});

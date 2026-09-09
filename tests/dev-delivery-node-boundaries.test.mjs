import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  sourceCoordinates,
  validateNativeContract,
  validateRuntimeSelector,
} from "../packages/core/dev-delivery/nodes/source-coordinates.mjs";
import { assertBranchUnlocked } from "../packages/core/dev-delivery/nodes/protected-branch.mjs";
import { submissionArguments } from "../packages/core/dev-delivery/nodes/submission.mjs";
import {
  enforceReservation,
  enforceLanding,
} from "../packages/core/dev-delivery/nodes/outcome.mjs";
import { command } from "../packages/core/runtime/action-process.mjs";
import {
  twoPhaseArguments,
  verifyTwoPhaseReadback,
} from "../packages/core/dev-delivery/nodes/native-qualification.mjs";
import { verifyFailureSettlement } from "../packages/core/dev-delivery/nodes/failure-settlement.mjs";
import { settlementMode } from "../packages/core/dev-delivery/nodes/terminal-settlement.mjs";
import {
  verifyReservationReadback,
  reservationOutputs,
} from "../packages/core/dev-delivery/nodes/reservation-readback.mjs";
import { handoffInputs } from "../packages/core/dev-delivery/nodes/reservation-handoff.mjs";
import {
  createDevDeliveryQueue,
  submitDevDeliveryCandidate,
  selectDevDeliveryWarrant,
  normalizeDevDeliveryQueue,
  devDeliveryContentRoot,
} from "../packages/core/dev-delivery/dev-delivery-warrant.js";

test("source coordinates reject ambiguous heads, invalid modes and required dry runs", () => {
  const env = {
    GITHUB_REF_NAME: "dev/v4/v4.1",
    WARRANT_MODE: "required",
    EXPECTED_PR: "123",
    EXPECTED_HEAD: "a".repeat(40),
    DRY_RUN: "false",
  };
  assert.deepEqual(sourceCoordinates(env), {
    branch: "dev/v4/v4.1",
    "branch-artifact": "dev-v4-v4.1",
  });
  for (const change of [
    { EXPECTED_HEAD: "dev/v4/v4.1" },
    { EXPECTED_PR: "0" },
    { DRY_RUN: "true" },
    { WARRANT_MODE: "fallback" },
    { INPUT_TARGET_BRANCH: "dev/v4/v4.1\nnext=bad" },
  ])
    assert.throws(() => sourceCoordinates({ ...env, ...change }));
});
test("native source admission requires an exact environment before effects", () => {
  validateNativeContract({
    DELIVERY_CLASS: "native-proof-required",
    ENVIRONMENT_ROOT: `sha256:${"b".repeat(64)}`,
  });
  validateNativeContract({ DELIVERY_CLASS: "non-native-fast" });
  assert.throws(() =>
    validateNativeContract({
      DELIVERY_CLASS: "release",
      ENVIRONMENT_ROOT: "current",
    }),
  );
  assert.throws(() => validateNativeContract({ DELIVERY_CLASS: "unknown" }));
});
test("runtime selector admits the current version line without old runtime defaults", () => {
  for (const value of [
    "v4",
    "v4-alpha",
    "c".repeat(40),
    "train/v4/v4.1/native",
  ])
    validateRuntimeSelector({ BUILDCHAIN_REF: value });
  for (const value of ["v3", "", "train/v4/v4.1/../secret", "dev/v4/v4.1"])
    assert.throws(() => validateRuntimeSelector({ BUILDCHAIN_REF: value }));
});
test("locked branch check combines classic and applied protection and fails closed", () => {
  const env = { TARGET_BRANCH: "dev/v4/v4.1", GITHUB_REPOSITORY: "owner/repo" };
  const run = (classic, rules) =>
    assertBranchUnlocked(env, (_program, args, options) => {
      assert.equal(options.shell, false);
      assert.match(args[1], /dev%2Fv4%2Fv4\.1/u);
      return args[1].endsWith("/protection") ? classic : rules;
    });
  const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) });
  const missing = { status: 1, stderr: "HTTP 404" };
  run(ok({ lock_branch: { enabled: false } }), ok([]));
  run(missing, ok([]));
  assert.throws(
    () => run(ok({ lock_branch: { enabled: true } }), ok([])),
    /locked/u,
  );
  assert.throws(() => run(missing, ok([{ type: "update" }])), /locked/u);
  assert.throws(
    () => run({ status: 1, stderr: "HTTP 403" }, ok([])),
    /Unable/u,
  );
  assert.throws(() => run(missing, { status: 1 }), /Unable/u);
});
test("candidate arguments retain literal native commands and grant execute only for required mode", () => {
  const env = {
    WARRANT_MODE: "shadow",
    NATIVE_COMMAND: 'echo "$(secret)"; exit 7',
    ENVIRONMENT_ROOT: `sha256:${"d".repeat(64)}`,
    SOURCE_WORKFLOW_RUN_ID: "123",
  };
  const args = submissionArguments(env);
  assert.equal(args[args.indexOf("--native-command") + 1], env.NATIVE_COMMAND);
  assert.equal(args.includes("--execute"), false);
  assert.ok(
    submissionArguments({ ...env, WARRANT_MODE: "required" }).includes(
      "--execute",
    ),
  );
  assert.throws(
    () => submissionArguments({ ...env, ENVIRONMENT_ROOT: "" }),
    /environment root/u,
  );
});
test("reservation failures and incomplete owner handoffs cannot pass", () => {
  const env = {
    WARRANT_MODE: "required",
    QUALIFY_OUTCOME: "success",
    SUBMIT_OUTCOME: "success",
    WARRANT_OUTCOME: "success",
    HANDOFF_REQUIRED: "false",
  };
  enforceReservation(env);
  for (const key of ["QUALIFY_OUTCOME", "SUBMIT_OUTCOME", "WARRANT_OUTCOME"])
    assert.throws(() => enforceReservation({ ...env, [key]: "failure" }));
  assert.throws(() =>
    enforceReservation({
      ...env,
      HANDOFF_REQUIRED: "true",
      HANDOFF_DISPATCHED: "false",
    }),
  );
});
test("landing needs verified native seal and heartbeat; settled failure remains failure", () => {
  const env = {
    WARRANT_MODE: "required",
    ALREADY_QUALIFIED: "true",
    RUN_NATIVE: "true",
    SEAL_JOB_OUTCOME: "success",
    HEARTBEAT_JOB_OUTCOME: "success",
    MERGE_STEP_OUTCOME: "success",
    TARGETED: "true",
    TARGETED_OK: "true",
  };
  enforceLanding(env);
  for (const change of [
    { SEAL_JOB_OUTCOME: "failure" },
    { HEARTBEAT_JOB_OUTCOME: "cancelled" },
    { MERGE_STEP_OUTCOME: "failure" },
    { TARGETED_OK: "false" },
    { ALREADY_QUALIFIED: "false" },
  ])
    assert.throws(() => enforceLanding({ ...env, ...change }));
  assert.throws(
    () =>
      enforceLanding({
        ...env,
        NATIVE_JOB_OUTCOME: "failure",
        FAILURE_FINAL_OUTCOME: "success",
      }),
    /settled the retained fence/u,
  );
  assert.throws(
    () =>
      enforceLanding({ ...env, DEFER_LANDING: "true", WARRANT_MODE: "off" }),
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
  const result = spawnSync(
    process.execPath,
    ["packages/core/dev-delivery/nodes/outcome.mjs", "land"],
    {
      env: { ...process.env, MERGE_STEP_OUTCOME: "failure" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
});

const root = (value) => `sha256:${value.repeat(64)}`;
test("native execution and finalization keep separate evidence and candidate directories", () => {
  const env = { EXPECTED_PR: "123", EXPECTED_HEAD: "a".repeat(40) };
  const native = twoPhaseArguments(env, "execute");
  const final = twoPhaseArguments(env, "finalize");
  assert.ok(native.includes("--native-only"));
  assert.ok(!native.includes("--finalize-only"));
  assert.equal(
    native[native.indexOf("--candidate-directory") + 1],
    ".buildchain/candidate",
  );
  assert.equal(
    final[final.indexOf("--candidate-directory") + 1],
    ".buildchain/runtime",
  );
  const result = {
    ok: true,
    outcome: "native-proof-ready",
    qualifiedWarrant: {
      phase: "provisional",
      pullRequestNumber: 123,
      sourceHead: env.EXPECTED_HEAD,
    },
    nativeProofRoot: root("a"),
    nativeReuseDecisionRoot: root("b"),
  };
  verifyTwoPhaseReadback(result, env, "execute");
  assert.throws(() => verifyTwoPhaseReadback(result, env, "finalize"));
  assert.throws(() =>
    verifyTwoPhaseReadback(
      {
        ...result,
        qualifiedWarrant: {
          ...result.qualifiedWarrant,
          sourceHead: "b".repeat(40),
        },
      },
      env,
      "execute",
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
  const env = { EXPECTED_PR: "7", EXPECTED_HEAD: "a".repeat(40) };
  const active = {
    pullRequestNumber: 7,
    sourceHead: env.EXPECTED_HEAD,
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
    HANDOFF_WORKFLOW_ID: "self-ops-dev-delivery.yml",
    TARGET_BRANCH: "dev/v4/v4.1",
  };
  assert.equal(handoffInputs(active, env)["source-workflow-run-id"], 123);
  assert.throws(
    () => handoffInputs({ ...active, sourceWorkflowRunId: 0 }, env),
    /recorded exact/u,
  );
});

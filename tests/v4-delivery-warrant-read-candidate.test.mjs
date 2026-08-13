import assert from "node:assert/strict";
import test from "node:test";

import { createDevDeliveryQueue } from "../packages/core/dev-delivery-warrant.js";
import {
  V4_DELIVERY_WARRANT_READ_PROJECTION_CONTRACT,
  projectV3QueueToV4ReadState,
  runV4DeliveryWarrantReadCandidate,
} from "../packages/core/v4-delivery-warrant-read-candidate.js";
import { v4ContentRoot } from "../packages/core/v4-canonical-contracts.js";
import { runDevDeliveryCommand } from "../scripts/dev-delivery-warrant.mjs";

const ROOT = (digit) => `sha256:${digit.repeat(64)}`;
const OBSERVED_AT = "2026-08-08T12:00:00.000Z";
const SOURCES = Object.freeze({
  typescriptRevision: "a".repeat(40),
  rustRevision: "b".repeat(40),
  validatorVersion: "semantic-diff-gate-v1",
});

function queue() {
  return createDevDeliveryQueue({
    repository: "kungfu-systems/kungfu",
    protectedBase: "dev/v4/v4.0",
    now: "2026-08-08T11:00:00.000Z",
  });
}

function qualification(overrides = {}) {
  const body = {
    schema: "buildchain-v4-delivery-warrant-semantic-diff-report/v1",
    authority: "typescript-v3",
    rustAuthority: "none",
    rustEffects: "disabled",
    recordedAt: "2026-08-08T10:00:00.000Z",
    retainUntil: "2026-11-06T10:00:00.000Z",
    sources: SOURCES,
    contracts: {},
    coverage: { required: [], observed: [], missing: [] },
    cases: [],
    faultInjection: { bounded: true, maximumProbes: 32, receipts: [] },
    stopPolicy: { retryBudget: 0, conditions: [] },
    retention: {
      status: "retained",
      evidenceRoot: ROOT("1"),
      receiptRoot: ROOT("2"),
    },
    blockers: [],
    verdict: {
      status: "qualified",
      zeroUnexplainedDifferences: true,
      nextEligibleStage: "legacy-authoritative-v4-read",
      v4WriteAuthorized: false,
    },
    ...overrides,
  };
  return {
    ...body,
    reportRoot: v4ContentRoot("semantic-diff", body),
  };
}

function hostResponse(request, state, overrides = {}) {
  return {
    schemaVersion: 1,
    contract: "kungfu-buildchain-v4-host-response",
    protocolVersion: "1.0",
    requestId: request.requestId,
    status: "ok",
    host: {
      kind: "rust-subprocess",
      implementation: "fixture",
      capabilities: [
        "canonical-input-v1",
        "delivery-warrant-state-projection-v1",
        "diagnostics-v1",
        "effects-disabled-v1",
        "structured-result-v1",
      ],
    },
    command: request.command,
    structuredResult: {
      schema: V4_DELIVERY_WARRANT_READ_PROJECTION_CONTRACT,
      state,
      stateRoot: v4ContentRoot("queue-state", state),
    },
    ...overrides,
  };
}

function candidateOptions(overrides = {}) {
  const report = qualification();
  return {
    qualification: report,
    expectedQualificationRoot: report.reportRoot,
    expectedSources: SOURCES,
    observedAt: OBSERVED_AT,
    invokeRust(request) {
      const state = JSON.parse(
        Buffer.from(request.input.bytes, "base64").toString("utf8"),
      );
      return hostResponse(request, state);
    },
    retain(evidence) {
      return { receiptRoot: evidence.evidenceRoot };
    },
    ...overrides,
  };
}

class MemoryStore {
  constructor() {
    this.queue = queue();
    this.writes = [];
  }

  async read() {
    return { exists: true, commitSha: "c".repeat(40), queue: this.queue };
  }

  async write(input) {
    this.writes.push(input);
    this.queue = input.queue;
    return { commitSha: "d".repeat(40), stateRoot: input.queue.stateRoot };
  }
}

test("explicit v4 read returns the legacy observation after an effect-disabled Rust projection", async () => {
  const retained = [];
  const result = await runV4DeliveryWarrantReadCandidate(
    queue(),
    candidateOptions({
      retain(evidence) {
        retained.push(evidence);
        return { receiptRoot: evidence.evidenceRoot };
      },
    }),
  );
  assert.equal(result.mode, "v4-read");
  assert.equal(result.writerAuthority, "typescript-v3");
  assert.equal(result.rustAuthority, "read-only");
  assert.equal(result.rustEffects, "disabled");
  assert.equal(result.rollbackMode, "v3");
  assert.equal(result.observation.stateRoot, queue().stateRoot);
  assert.equal(result.evidence.parity, "matched");
  assert.equal(retained.length, 1);
});

test("caller switch defaults to v3 and affects observe only", async () => {
  const store = new MemoryStore();
  const observed = await runDevDeliveryCommand(
    {
      command: "observe",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: OBSERVED_AT,
    },
    store,
  );
  assert.equal(observed.readMode, "v3");
  assert.equal(observed.readCandidate, undefined);

  const readOptions = candidateOptions();
  const v4Observed = await runDevDeliveryCommand(
    {
      command: "observe",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      now: OBSERVED_AT,
      readMode: "v4",
      readQualification: readOptions.qualification,
      readQualificationRoot: readOptions.expectedQualificationRoot,
      readTypescriptRevision: SOURCES.typescriptRevision,
      readRustRevision: SOURCES.rustRevision,
      readValidatorVersion: SOURCES.validatorVersion,
      invokeV4ReadHost: readOptions.invokeRust,
      retainReadEvidence: readOptions.retain,
    },
    store,
  );
  assert.equal(v4Observed.readMode, "v4");
  assert.equal(v4Observed.readCandidate.rustAuthority, "read-only");
  assert.equal(store.writes.length, 0);

  const submitted = await runDevDeliveryCommand(
    {
      command: "submit",
      readMode: "v4",
      repository: "kungfu-systems/kungfu",
      branch: "dev/v4/v4.0",
      pullRequestNumber: 200,
      sourceHead: "e".repeat(40),
      assignmentRoot: ROOT("1"),
      initiativeRoot: ROOT("2"),
      sourceIdentityRoot: ROOT("3"),
      sourcePatchRoot: ROOT("4"),
      sourceProofRoot: ROOT("5"),
      planRoot: ROOT("6"),
      closureRoot: ROOT("7"),
      dependencyRoot: ROOT("8"),
      toolchainRoot: ROOT("9"),
      deliveryClass: "native-proof-required",
      now: OBSERVED_AT,
      execute: true,
    },
    store,
  );
  assert.equal(submitted.mutationApplied, true);
  assert.equal(store.writes.length, 1);
});

test("qualification root, eligibility, source, and retention drift fail closed", async () => {
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({ expectedQualificationRoot: ROOT("f") }),
    ),
    (error) => error.code === "qualification-root-drift",
  );
  const blocked = qualification({
    blockers: [{ code: "unexplained-difference", retry: "stop" }],
    verdict: {
      status: "blocked",
      zeroUnexplainedDifferences: false,
      nextEligibleStage: null,
      v4WriteAuthorized: false,
    },
  });
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        qualification: blocked,
        expectedQualificationRoot: blocked.reportRoot,
      }),
    ),
    (error) => error.code === "qualification-not-eligible",
  );
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        expectedSources: { ...SOURCES, rustRevision: "c".repeat(40) },
      }),
    ),
    (error) => error.code === "qualification-source-drift",
  );
  const expired = qualification({ retainUntil: "2026-08-08T11:59:59.999Z" });
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        qualification: expired,
        expectedQualificationRoot: expired.reportRoot,
      }),
    ),
    (error) => error.code === "qualification-expired",
  );
});

test("host failure, response drift, timeout, cancellation, and retention failure stay bounded", async () => {
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        invokeRust() {
          const error = new Error("crashed");
          error.code = "host-crashed";
          throw error;
        },
      }),
    ),
    (error) => error.code === "host-crashed",
  );
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        invokeRust(request) {
          const state = projectV3QueueToV4ReadState(queue());
          return hostResponse(request, { ...state, generation: 9 });
        },
      }),
    ),
    (error) => error.code === "projection-drift",
  );
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({ retain: undefined }),
    ),
    (error) => error.code === "retention-required",
  );
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        retain() {
          throw new Error("sink failed");
        },
      }),
    ),
    (error) => error.code === "retention-failed",
  );

  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        invokeRust: undefined,
        timeoutMs: 20,
        host: {
          command: process.execPath,
          arguments: ["-e", "setInterval(() => {}, 1000)"],
        },
      }),
    ),
    (error) => error.code === "host-timeout",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runV4DeliveryWarrantReadCandidate(
      queue(),
      candidateOptions({
        invokeRust: undefined,
        signal: controller.signal,
      }),
    ),
    (error) => error.code === "host-cancelled",
  );
});

test("the real Rust host validates and projects the candidate state without effects", async () => {
  const result = await runV4DeliveryWarrantReadCandidate(
    queue(),
    candidateOptions({ invokeRust: undefined }),
  );
  assert.equal(
    result.projection.schema,
    V4_DELIVERY_WARRANT_READ_PROJECTION_CONTRACT,
  );
  assert.deepEqual(
    result.projection.state,
    projectV3QueueToV4ReadState(queue()),
  );
  assert.equal(result.rustEffects, "disabled");
});

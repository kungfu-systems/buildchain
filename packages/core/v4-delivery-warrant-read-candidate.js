import crypto from "node:crypto";

import {
  normalizeDevDeliveryQueue,
  observeDevDeliveryQueue,
} from "./dev-delivery-warrant.js";
import {
  v4CanonicalBytes,
  v4ContentRoot,
  validateV4Clock,
  validateV4Root,
} from "./v4-canonical-contracts.js";
import { invokeV4RustShadowHost } from "./v4-delivery-warrant-shadow-adapter.js";
import { V4_DELIVERY_WARRANT_SEMANTIC_DIFF_REPORT_CONTRACT } from "./v4-delivery-warrant-semantic-diff-gate.js";

export const V4_DELIVERY_WARRANT_READ_PROJECTION_CONTRACT =
  "buildchain-v4-delivery-warrant-read-projection/v1";
export const V4_DELIVERY_WARRANT_READ_RESULT_CONTRACT =
  "buildchain-v4-delivery-warrant-read-result/v1";
export const V4_DELIVERY_WARRANT_READ_EVIDENCE_CONTRACT =
  "buildchain-v4-delivery-warrant-read-evidence/v1";

const HOST_REQUEST_CONTRACT = "kungfu-buildchain-v4-host-request";
const HOST_RESPONSE_CONTRACT = "kungfu-buildchain-v4-host-response";
const STATE_CONTRACT = "buildchain-v4-delivery-warrant-state/v1";
const REQUIRED_CAPABILITIES = Object.freeze([
  "canonical-input-v1",
  "delivery-warrant-state-projection-v1",
  "diagnostics-v1",
  "effects-disabled-v1",
  "structured-result-v1",
]);
const REVISION = /^[0-9a-f]{40,64}$/u;
const MAX_TIMEOUT_MS = 30_000;

export class V4DeliveryWarrantReadFault extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V4DeliveryWarrantReadFault";
    this.code = code;
  }
}

function fail(code, message) {
  throw new V4DeliveryWarrantReadFault(code, message);
}

function validateSources(actual, expected) {
  for (const key of [
    "typescriptRevision",
    "rustRevision",
    "validatorVersion",
  ]) {
    if (typeof expected?.[key] !== "string" || actual?.[key] !== expected[key])
      fail("qualification-source-drift", `qualification ${key} drifted`);
  }
  if (
    !REVISION.test(expected.typescriptRevision) ||
    !REVISION.test(expected.rustRevision)
  )
    fail("qualification-source-drift", "qualification revisions are invalid");
}

export function validateV4DeliveryWarrantReadQualification(
  report,
  { expectedRoot, expectedSources, observedAt },
) {
  validateV4Root(expectedRoot, "$/expectedQualificationRoot");
  validateV4Clock(observedAt, "$/observedAt");
  const body = structuredClone(report || {});
  const reportedRoot = body.reportRoot;
  delete body.reportRoot;
  if (
    reportedRoot !== expectedRoot ||
    v4ContentRoot("semantic-diff", body) !== expectedRoot
  )
    fail("qualification-root-drift", "semantic-diff report root drifted");
  if (
    report.schema !== V4_DELIVERY_WARRANT_SEMANTIC_DIFF_REPORT_CONTRACT ||
    report.authority !== "typescript-v3" ||
    report.rustAuthority !== "none" ||
    report.rustEffects !== "disabled" ||
    report.verdict?.status !== "qualified" ||
    report.verdict?.zeroUnexplainedDifferences !== true ||
    report.verdict?.nextEligibleStage !== "legacy-authoritative-v4-read" ||
    report.verdict?.v4WriteAuthorized !== false ||
    report.retention?.status !== "retained" ||
    report.blockers?.length !== 0 ||
    report.coverage?.missing?.length !== 0
  )
    fail(
      "qualification-not-eligible",
      "semantic-diff report does not authorize a read-only candidate",
    );
  validateV4Clock(report.retainUntil, "$/qualification/retainUntil");
  if (Date.parse(report.retainUntil) <= Date.parse(observedAt))
    fail("qualification-expired", "semantic-diff retention window expired");
  validateSources(report.sources, expectedSources);
  return report;
}

export function projectV3QueueToV4ReadState(queueInput) {
  const queue = normalizeDevDeliveryQueue(queueInput);
  return {
    schema: STATE_CONTRACT,
    generation: queue.generation,
    fencingCounter: queue.fencingCounter,
    activeWarrant: queue.activeWarrant
      ? {
          candidateId: queue.activeWarrant.candidateId,
          fencingToken: queue.activeWarrant.fencingToken,
          generation: queue.activeWarrant.generation,
          issuedAt: queue.activeWarrant.issuedAt,
          expiresAt: queue.activeWarrant.expiresAt,
        }
      : null,
    candidates: queue.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      pullRequestNumber: candidate.pullRequestNumber,
      status: candidate.status,
      enqueuedAt: candidate.enqueuedAt,
      updatedAt: candidate.updatedAt,
      attempts: candidate.attempts,
      recoveries: candidate.recoveries,
      ...(candidate.terminal
        ? {
            terminal: {
              outcome: candidate.terminal.outcome,
              evidenceRoot: candidate.terminal.evidenceRoot,
              closedAt: candidate.terminal.closedAt,
            },
          }
        : {}),
    })),
  };
}

export function createV4DeliveryWarrantReadRequest(
  state,
  { requestId = crypto.randomUUID(), timeoutMs = 5_000 } = {},
) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw new RangeError(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  return {
    schemaVersion: 1,
    contract: HOST_REQUEST_CONTRACT,
    protocolVersion: "1.0",
    requestId,
    command: { id: "delivery-warrant.state-project", arguments: [] },
    input: {
      encoding: "base64",
      bytes: v4CanonicalBytes(state).toString("base64"),
    },
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    timeoutMs,
  };
}

function validateProjection(response, request, expectedState) {
  if (
    response?.schemaVersion !== 1 ||
    response?.contract !== HOST_RESPONSE_CONTRACT ||
    response?.protocolVersion !== "1.0" ||
    response?.requestId !== request.requestId ||
    response?.command?.id !== request.command.id
  )
    fail("host-response-invalid", "Rust read projection response is invalid");
  const capabilities = response.host?.capabilities || [];
  if (
    response.status === "unsupported" ||
    REQUIRED_CAPABILITIES.some((entry) => !capabilities.includes(entry))
  )
    fail(
      "unsupported-capability",
      "Rust host lacks the read-only projection capability",
    );
  if (response.status !== "ok")
    fail("rust-projection-failed", "Rust read projection failed closed");
  const projection = response.structuredResult;
  if (
    projection?.schema !== V4_DELIVERY_WARRANT_READ_PROJECTION_CONTRACT ||
    !projection.stateRoot
  )
    fail("host-response-invalid", "Rust read projection shape is invalid");
  validateV4Root(projection.stateRoot, "$/projection/stateRoot");
  if (
    !v4CanonicalBytes(projection.state).equals(
      v4CanonicalBytes(expectedState),
    ) ||
    projection.stateRoot !== v4ContentRoot("queue-state", expectedState)
  )
    fail("projection-drift", "Rust read projection disagrees with v3 state");
  return projection;
}

export async function runV4DeliveryWarrantReadCandidate(
  queueInput,
  {
    qualification,
    expectedQualificationRoot,
    expectedSources,
    observedAt = new Date().toISOString(),
    requestId,
    timeoutMs = 5_000,
    signal,
    invokeRust = invokeV4RustShadowHost,
    host = {},
    retain,
  } = {},
) {
  validateV4DeliveryWarrantReadQualification(qualification, {
    expectedRoot: expectedQualificationRoot,
    expectedSources,
    observedAt,
  });
  if (typeof retain !== "function")
    fail("retention-required", "v4 read evidence retention is required");
  const queue = normalizeDevDeliveryQueue(queueInput);
  const state = projectV3QueueToV4ReadState(queue);
  const request = createV4DeliveryWarrantReadRequest(state, {
    requestId,
    timeoutMs,
  });
  let response;
  try {
    response = await invokeRust(request, { ...host, signal });
  } catch (error) {
    fail(
      error?.code || "rust-projection-failed",
      error?.message || "Rust read projection failed",
    );
  }
  const projection = validateProjection(response, request, state);
  const observation = observeDevDeliveryQueue(queue, { now: observedAt });
  const evidence = {
    schema: V4_DELIVERY_WARRANT_READ_EVIDENCE_CONTRACT,
    authority: "typescript-v3",
    writerAuthority: "typescript-v3",
    rustAuthority: "read-only",
    rustEffects: "disabled",
    rollbackMode: "v3",
    observedAt,
    qualificationRoot: expectedQualificationRoot,
    legacyStateRoot: queue.stateRoot,
    v4StateRoot: projection.stateRoot,
    observationRoot: v4ContentRoot("observation", observation),
    parity: "matched",
  };
  const evidenceRoot = v4ContentRoot("observation", evidence);
  let retentionReceipt;
  try {
    retentionReceipt = await retain(
      structuredClone({ ...evidence, evidenceRoot }),
    );
    validateV4Root(retentionReceipt?.receiptRoot, "$/retention/receiptRoot");
  } catch {
    fail("retention-failed", "v4 read evidence retention failed");
  }
  return {
    schema: V4_DELIVERY_WARRANT_READ_RESULT_CONTRACT,
    mode: "v4-read",
    authority: "typescript-v3",
    writerAuthority: "typescript-v3",
    rustAuthority: "read-only",
    rustEffects: "disabled",
    rollbackMode: "v3",
    observation,
    projection,
    evidence: {
      ...evidence,
      evidenceRoot,
      retentionReceiptRoot: retentionReceipt.receiptRoot,
    },
  };
}

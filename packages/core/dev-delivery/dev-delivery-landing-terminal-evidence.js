import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { normalizeDevDeliveryProviderAttempt } from "./dev-delivery-provider-attempt.js";

export const DEV_DELIVERY_LANDING_TERMINAL_READBACK_SCHEMA =
  "kungfu.buildchain.github-landing-terminal-readback/v2";

const sealedReadbacks = new WeakSet();
const COMPLETED_PROVIDER_STATES = new Set(["completed"]);
const PROVIDER_PULL_REQUEST_STATES = new Set(["open", "closed"]);
const TERMINAL_OUTCOMES = new Set([
  "merged",
  "terminal-failure",
  "dequeued",
  "cancelled",
]);
const TERMINAL_JOB_CONCLUSIONS = new Set([
  "cancelled",
  "failure",
  "action_required",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

function requiredText(value, label) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} is required`);
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = text(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function exactInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return positiveInteger(value, label);
}

function exactBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function exactValue(value, allowed, label) {
  const normalized = requiredText(value, label);
  if (!allowed.has(normalized)) {
    throw new Error(`${label} is unsupported: ${normalized}`);
  }
  return normalized;
}

function readbackBody(input) {
  return {
    schema: DEV_DELIVERY_LANDING_TERMINAL_READBACK_SCHEMA,
    verifier: "buildchain-github-provider-live-readback",
    terminal: true,
    repository: repository(requiredText(input.repository, "repository")),
    protectedBase: protectedBase(
      requiredText(input.protectedBase, "protected base"),
    ),
    stateRoot: exactRoot(
      requiredText(input.stateRoot, "provider readback stateRoot"),
      "provider readback stateRoot",
    ),
    candidateId: exactRoot(
      requiredText(input.candidateId, "provider readback candidateId"),
      "provider readback candidateId",
    ),
    pullRequestNumber: exactInteger(
      input.pullRequestNumber,
      "provider readback pull request",
    ),
    sourceHead: exactSha(
      requiredText(input.sourceHead, "provider readback sourceHead"),
      "provider readback sourceHead",
    ),
    landingWarrantToken: exactRoot(
      requiredText(input.landingWarrantToken, "provider readback fence"),
      "provider readback fence",
    ),
    landingWarrantGeneration: exactInteger(
      input.landingWarrantGeneration,
      "provider readback generation",
    ),
    providerRunId: exactInteger(
      input.providerRunId,
      "provider readback run id",
    ),
    providerRunAttempt: exactInteger(
      input.providerRunAttempt,
      "provider readback run attempt",
    ),
    providerRunState: exactValue(
      input.providerRunState,
      COMPLETED_PROVIDER_STATES,
      "provider run state",
    ),
    providerRunConclusion: requiredText(
      input.providerRunConclusion,
      "provider run conclusion",
    ),
    providerRunHead: exactSha(
      requiredText(input.providerRunHead, "provider run head"),
      "provider run head",
    ),
    providerJobId: exactInteger(
      input.providerJobId,
      "provider readback job id",
    ),
    providerJobState: exactValue(
      input.providerJobState,
      COMPLETED_PROVIDER_STATES,
      "provider job state",
    ),
    providerJobConclusion: exactValue(
      input.providerJobConclusion,
      TERMINAL_JOB_CONCLUSIONS,
      "provider job conclusion",
    ),
    providerJobStartedAt: timestamp(
      requiredText(input.providerJobStartedAt, "provider job start"),
      "provider job start",
    ),
    providerJobCompletedAt: timestamp(
      requiredText(input.providerJobCompletedAt, "provider job completion"),
      "provider job completion",
    ),
    providerAttempt: normalizeDevDeliveryProviderAttempt(input.providerAttempt),
    admissionRoot: exactRoot(
      requiredText(input.admissionRoot, "provider readback admission root"),
      "provider readback admission root",
    ),
    pullRequestState: exactValue(
      input.pullRequestState,
      PROVIDER_PULL_REQUEST_STATES,
      "provider pull request state",
    ),
    pullRequestMerged: exactBoolean(
      input.pullRequestMerged,
      "provider pull request merged",
    ),
    protectedBaseHead: exactSha(
      requiredText(input.protectedBaseHead, "provider protected base head"),
      "provider protected base head",
    ),
    providerRunHeadInProtectedBase: exactBoolean(
      input.providerRunHeadInProtectedBase,
      "provider run head in protected base",
    ),
    outcome: exactValue(input.outcome, TERMINAL_OUTCOMES, "provider outcome"),
    reason: requiredText(input.reason, "provider reason"),
    observedAt: timestamp(
      requiredText(input.observedAt, "provider readback observedAt"),
      "provider readback observedAt",
    ),
  };
}

export function sealLandingTerminalReadback(input) {
  const body = readbackBody(input);
  if (
    (body.outcome === "merged") !==
    (body.pullRequestMerged && body.providerRunHeadInProtectedBase)
  ) {
    throw new Error(
      "merged provider outcome requires the exact admitted run head in the protected base",
    );
  }
  const evidence = {
    schema: "kungfu.buildchain.github-landing-terminal-evidence/v1",
    repository: body.repository,
    stateRoot: body.stateRoot,
    candidateId: body.candidateId,
    sourceHead: body.sourceHead,
    landingWarrantToken: body.landingWarrantToken,
    landingWarrantGeneration: body.landingWarrantGeneration,
    providerRunId: body.providerRunId,
    providerRunAttempt: body.providerRunAttempt,
    providerJobId: body.providerJobId,
    admissionRoot: body.admissionRoot,
    providerAttempt: body.providerAttempt,
    providerJobConclusion: body.providerJobConclusion,
    protectedBaseHead: body.protectedBaseHead,
    providerRunHeadInProtectedBase: body.providerRunHeadInProtectedBase,
    outcome: body.outcome,
    observedAt: body.observedAt,
  };
  const readback = {
    ...body,
    evidenceRoot: devDeliveryContentRoot(evidence),
  };
  const sealed = {
    ...readback,
    readbackRoot: devDeliveryContentRoot(readback),
  };
  sealedReadbacks.add(sealed);
  return sealed;
}

export function sealLandingTerminalReadbackForTesting(input) {
  return sealLandingTerminalReadback(input);
}

export function verifyLandingSettlementReadback({
  state,
  candidate,
  warrant,
  sealedProviderReadback,
}) {
  if (!sealedReadbacks.has(sealedProviderReadback)) {
    throw new Error(
      "Landing settlement requires product-owned GitHub live readback",
    );
  }
  const readback = sealedProviderReadback;
  const bindings = [
    [readback.repository, state.repository, "repository"],
    [readback.protectedBase, state.protectedBase, "protected base"],
    [readback.stateRoot, state.stateRoot, "state root"],
    [readback.candidateId, candidate.candidateId, "candidate"],
    [readback.pullRequestNumber, candidate.pullRequestNumber, "pull request"],
    [readback.sourceHead, candidate.sourceHead, "source head"],
    [readback.landingWarrantToken, warrant.token, "fence"],
    [readback.landingWarrantGeneration, warrant.generation, "generation"],
    [readback.providerRunId, warrant.providerAttempt.runId, "provider run"],
    [
      readback.providerRunAttempt,
      warrant.providerAttempt.runAttempt,
      "provider run attempt",
    ],
    [readback.providerJobId, warrant.providerAttempt.jobId, "provider job"],
    [readback.admissionRoot, warrant.mergeGroupAdmissionRoot, "admission root"],
  ];
  for (const [actual, expected, label] of bindings) {
    if (actual !== expected)
      throw new Error(`provider terminal readback ${label} mismatch`);
  }
  if (
    JSON.stringify(readback.providerAttempt) !==
    JSON.stringify(warrant.providerAttempt)
  ) {
    throw new Error("provider terminal readback exact attempt mismatch");
  }
  if (Date.parse(readback.observedAt) < Date.parse(warrant.issuedAt)) {
    throw new Error(
      "provider terminal readback is stale for this Landing Warrant",
    );
  }
  return readback;
}

export const verifyExpiredLandingSettlementReadback =
  verifyLandingSettlementReadback;

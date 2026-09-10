import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
} from "./dev-delivery-common.js";

function normalizedFailure(failureInput, transfer) {
  const failure = clone(failureInput || {});
  const evidenceRoot = exactRoot(
    failure.evidenceRoot,
    "native failure evidence root",
  );
  delete failure.evidenceRoot;
  if (devDeliveryContentRoot(failure) !== evidenceRoot) {
    throw new Error("native failure evidence root drift");
  }
  const normalized = {
    schema: "kungfu.buildchain.two-phase-delivery-failure/v1",
    pullRequestNumber: positiveInteger(
      failure.pullRequestNumber,
      "failure pull request number",
    ),
    expectedHead: exactSha(failure.expectedHead, "failure expected head"),
    fencingToken: exactRoot(failure.fencingToken, "failure fencing token"),
    leaseGeneration: positiveInteger(
      failure.leaseGeneration,
      "failure lease generation",
    ),
    nativeAttempts: Number(failure.nativeAttempts),
    reason: text(failure.reason),
    workerTerminationProven: failure.workerTerminationProven === true,
  };
  if (
    !Number.isInteger(normalized.nativeAttempts) ||
    normalized.nativeAttempts < 0
  ) {
    throw new Error("failure nativeAttempts must be a non-negative integer");
  }
  if (JSON.stringify(failure) !== JSON.stringify(normalized)) {
    throw new Error("native failure evidence is not exact canonical content");
  }
  if (
    normalized.pullRequestNumber !== transfer.warrant.pullRequestNumber ||
    normalized.expectedHead !== transfer.warrant.sourceHead ||
    normalized.fencingToken !== transfer.warrant.fencingToken ||
    normalized.leaseGeneration !== transfer.warrant.generation
  ) {
    throw new Error("native failure evidence Warrant binding mismatch");
  }
  return { ...normalized, evidenceRoot };
}

function normalizedFailureSettlement(settlementInput, failure, transfer) {
  const settlement = clone(settlementInput || {});
  const normalized = {
    schema: "kungfu.buildchain.two-phase-provider-settlement-required/v1",
    evidenceRoot: exactRoot(
      settlement.evidenceRoot,
      "provider failure evidence root",
    ),
    stateRoot: exactRoot(settlement.stateRoot, "provider failure state root"),
    candidateId: exactRoot(
      settlement.candidateId,
      "provider failure candidate id",
    ),
    fencingToken: exactRoot(
      settlement.fencingToken,
      "provider failure fencing token",
    ),
    leaseGeneration: positiveInteger(
      settlement.leaseGeneration,
      "provider failure lease generation",
    ),
    pullRequestNumber: positiveInteger(
      settlement.pullRequestNumber,
      "provider failure pull request number",
    ),
    sourceHead: exactSha(settlement.sourceHead, "provider failure source head"),
    workerTerminationProven: settlement.workerTerminationProven === true,
    nextAction: text(settlement.nextAction),
  };
  if (JSON.stringify(settlement) !== JSON.stringify(normalized)) {
    throw new Error(
      "native failure settlement binding is not exact canonical content",
    );
  }
  if (
    normalized.evidenceRoot !== failure.evidenceRoot ||
    normalized.workerTerminationProven !== failure.workerTerminationProven ||
    normalized.stateRoot !== transfer.warrant.stateRoot ||
    normalized.candidateId !== transfer.warrant.candidateId ||
    normalized.fencingToken !== transfer.warrant.fencingToken ||
    normalized.leaseGeneration !== transfer.warrant.generation ||
    normalized.pullRequestNumber !== transfer.warrant.pullRequestNumber ||
    normalized.sourceHead !== transfer.warrant.sourceHead
  ) {
    throw new Error("native failure settlement binding mismatch");
  }
  return normalized;
}

export function verifyNativeExecutionFailureOutcome(
  transfer,
  { readCanonical } = {},
) {
  if (
    transfer.nativeProofRoot !== null ||
    transfer.nativeReuseDecisionRoot !== null
  ) {
    throw new Error("failed native transfer cannot claim proof roots");
  }
  if (typeof readCanonical !== "function") {
    throw new Error("canonical failure artifact reader is required");
  }
  const failure = normalizedFailure(
    readCanonical("failure.json", "native failure evidence"),
    transfer,
  );
  return {
    failure,
    failureSettlement: normalizedFailureSettlement(
      readCanonical(
        "failure-provider-settlement.json",
        "native failure settlement binding",
      ),
      failure,
      transfer,
    ),
  };
}

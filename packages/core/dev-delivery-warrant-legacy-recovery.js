import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  TERMINAL_STATES,
  normalizeDevDeliveryQueue,
} from "./dev-delivery-warrant-state.js";

export const LEGACY_TERMINAL_RECOVERY_REQUEST_SCHEMA =
  "kungfu.buildchain.legacy-terminal-recovery-request/v1";
export const LEGACY_HOSTED_TERMINAL_EVIDENCE_SCHEMA =
  "kungfu.buildchain.legacy-hosted-terminal-evidence/v1";
export const LEGACY_TERMINAL_RECOVERY_RECEIPT_SCHEMA =
  "kungfu.buildchain.legacy-terminal-recovery-receipt/v1";

function legacyLiveNativeCandidate(candidate) {
  return (
    !TERMINAL_STATES.has(candidate.status) &&
    candidate.deliveryClass !== "non-native-fast" &&
    (!candidate.environmentRoot || !candidate.nativeCommandContract)
  );
}

function normalizeProviderJob(input, runAttempt) {
  const job = {
    id: positiveInteger(input?.id, "provider job id"),
    name: text(input?.name),
    runAttempt: positiveInteger(input?.runAttempt, "provider job runAttempt"),
    status: text(input?.status).toLowerCase(),
    conclusion: text(input?.conclusion).toLowerCase(),
    completedAt: timestamp(input?.completedAt, "provider job completedAt"),
  };
  if (job.runAttempt !== runAttempt) {
    throw new Error("legacy provider job run attempt mismatch");
  }
  if (job.status !== "completed" || !job.conclusion) {
    throw new Error(
      "legacy recovery requires every provider job to be terminal",
    );
  }
  return job;
}

function normalizeEvidence(input) {
  const runAttempt = positiveInteger(input?.runAttempt, "runAttempt");
  if (!Array.isArray(input?.jobs) || input.jobs.length === 0) {
    throw new Error("legacy terminal evidence requires provider jobs");
  }
  const jobs = input.jobs
    .map((job) => normalizeProviderJob(job, runAttempt))
    .sort((left, right) => left.id - right.id);
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length) {
    throw new Error(
      "legacy terminal evidence contains duplicate provider jobs",
    );
  }
  if (!jobs.some((job) => job.conclusion === "failure")) {
    throw new Error(
      "legacy failed run evidence requires a failed provider job",
    );
  }
  const runUpdatedAt = timestamp(input?.runUpdatedAt, "runUpdatedAt");
  if (
    jobs.some((job) => Date.parse(job.completedAt) > Date.parse(runUpdatedAt))
  ) {
    throw new Error("legacy provider job completion follows the run readback");
  }
  const body = {
    schema: text(input?.schema),
    candidateId: exactRoot(input?.candidateId, "candidateId"),
    pullRequestNumber: positiveInteger(
      input?.pullRequestNumber,
      "pullRequestNumber",
    ),
    sourceHead: exactSha(input?.sourceHead, "sourceHead"),
    sourceWorkflowRunId: positiveInteger(
      input?.sourceWorkflowRunId,
      "sourceWorkflowRunId",
    ),
    runAttempt,
    runStatus: text(input?.runStatus).toLowerCase(),
    runConclusion: text(input?.runConclusion).toLowerCase(),
    runUpdatedAt,
    totalJobCount: jobs.length,
    nonterminalJobCount: 0,
    workerTerminationProven: true,
    jobs,
    reason: text(input?.reason),
  };
  if (body.schema !== LEGACY_HOSTED_TERMINAL_EVIDENCE_SCHEMA) {
    throw new Error(
      `legacy terminal evidence must use ${LEGACY_HOSTED_TERMINAL_EVIDENCE_SCHEMA}`,
    );
  }
  if (
    body.runStatus !== "completed" ||
    body.runConclusion !== "failure" ||
    !body.reason
  ) {
    throw new Error(
      "legacy terminal evidence requires one completed failed run with zero nonterminal jobs and proven worker termination",
    );
  }
  const evidenceRoot = devDeliveryContentRoot(body);
  if (exactRoot(input?.evidenceRoot, "evidenceRoot") !== evidenceRoot) {
    throw new Error("legacy terminal evidence root mismatch");
  }
  return { ...body, evidenceRoot };
}

function assertExactCoverage(candidates, evidence) {
  const expected = candidates.map((candidate) => candidate.candidateId).sort();
  const observed = evidence.map((entry) => entry.candidateId).sort();
  if (
    expected.length !== observed.length ||
    expected.some((candidateId, index) => candidateId !== observed[index])
  ) {
    throw new Error(
      "legacy terminal recovery must cover every live legacy native candidate exactly once",
    );
  }
}

export function recoverLegacyTerminalDevDeliveryQueue(
  queueInput,
  requestInput,
  { now = new Date().toISOString() } = {},
) {
  const currentTime = timestamp(now, "now");
  const request = requestInput || {};
  if (request.schema !== LEGACY_TERMINAL_RECOVERY_REQUEST_SCHEMA) {
    throw new Error(
      `legacy terminal recovery must use ${LEGACY_TERMINAL_RECOVERY_REQUEST_SCHEMA}`,
    );
  }
  const before = normalizeDevDeliveryQueue(queueInput, {
    allowLegacyV3Readback: true,
  });
  const expectedOldStateRoot = exactRoot(
    request.expectedOldStateRoot,
    "expectedOldStateRoot",
  );
  if (expectedOldStateRoot !== before.stateRoot) {
    throw new Error("legacy terminal recovery expected-old state drift");
  }
  const legacyCandidates = before.candidates.filter(legacyLiveNativeCandidate);
  if (legacyCandidates.length === 0) {
    throw new Error("legacy terminal recovery found no live legacy candidate");
  }
  if (!Array.isArray(request.evidence)) {
    throw new Error("legacy terminal recovery evidence must be an array");
  }
  const evidence = request.evidence.map(normalizeEvidence);
  if (
    new Set(evidence.map((entry) => entry.candidateId)).size !== evidence.length
  ) {
    throw new Error(
      "legacy terminal recovery evidence contains duplicate candidates",
    );
  }
  assertExactCoverage(legacyCandidates, evidence);

  const queue = clone(before);
  delete queue.stateRoot;
  const transitions = [];
  for (const entry of evidence) {
    const candidate = queue.candidates.find(
      (row) => row.candidateId === entry.candidateId,
    );
    if (
      !candidate ||
      candidate.pullRequestNumber !== entry.pullRequestNumber ||
      candidate.sourceHead !== entry.sourceHead ||
      candidate.sourceWorkflowRunId !== entry.sourceWorkflowRunId
    ) {
      throw new Error(
        "legacy terminal evidence does not match candidate identity",
      );
    }
    const active = queue.activeWarrant?.candidateId === candidate.candidateId;
    if (!active && candidate.status !== "queued") {
      throw new Error(
        `legacy candidate status ${candidate.status} requires the exact active Warrant`,
      );
    }
    const priorStatus = candidate.status;
    candidate.status = "terminal-failure";
    candidate.updatedAt = currentTime;
    candidate.terminal = {
      outcome: "terminal-failure",
      reason: entry.reason,
      evidenceRoot: entry.evidenceRoot,
      authority: "legacy-hosted-native-terminal-recovery",
      sourceWorkflowRunId: entry.sourceWorkflowRunId,
      runAttempt: entry.runAttempt,
      workerTerminationProven: true,
      closedAt: currentTime,
      ...(active
        ? {
            fencingToken: queue.activeWarrant.fencingToken,
            leaseGeneration: queue.activeWarrant.generation,
          }
        : {}),
    };
    transitions.push({
      candidateId: candidate.candidateId,
      pullRequestNumber: candidate.pullRequestNumber,
      sourceHead: candidate.sourceHead,
      priorStatus,
      activeWarrant: active,
      outcome: "terminal-failure",
      evidenceRoot: entry.evidenceRoot,
    });
  }
  queue.activeWarrant = null;
  queue.generation += 1;
  queue.updatedAt = currentTime;
  queue.stateRoot = devDeliveryContentRoot(queue);
  const after = normalizeDevDeliveryQueue(queue);
  const requestBody = {
    schema: LEGACY_TERMINAL_RECOVERY_REQUEST_SCHEMA,
    expectedOldStateRoot,
    evidence,
  };
  const requestRoot = devDeliveryContentRoot(requestBody);
  const receipt = {
    schema: LEGACY_TERMINAL_RECOVERY_RECEIPT_SCHEMA,
    action: "legacy-terminal-recovery",
    expectedOldStateRoot,
    nextStateRoot: after.stateRoot,
    requestRoot,
    transitions,
    nextAction: "Select the next strictly valid queued candidate, if any.",
  };
  return {
    queue: after,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}

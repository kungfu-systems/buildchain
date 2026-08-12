import {
  devDeliveryClone as clone,
  devDeliveryContentRoot as contentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";

export const DEV_DELIVERY_QUALIFICATION_LANES_CONTRACT =
  "kungfu-buildchain-dev-delivery-qualification-lanes/v1";
export const DEV_DELIVERY_QUALIFICATION_LANE_SCHEMA =
  "kungfu.buildchain.dev-delivery-qualification-lane/v1";
export const DEV_DELIVERY_LANDING_WARRANT_SCHEMA =
  "kungfu.buildchain.dev-delivery-landing-warrant/v1";

const TERMINAL = new Set(["cancelled", "failed", "landed", "superseded"]);
const DELTAS = new Set(["disjoint", "overlapping", "unknown"]);
const RETRYABLE_FAILURES = new Set([
  "cancelled",
  "runner-loss",
  "heartbeat-failure",
  "lease-expiry",
  "provider-transient",
]);

function nonNegative(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function body(state) {
  const value = clone(state);
  delete value.stateRoot;
  return value;
}

function rooted(state) {
  const value = body(state);
  return { ...value, stateRoot: contentRoot(value) };
}

function candidateId(input) {
  return contentRoot({
    schema: "kungfu.buildchain.dev-delivery-qualification-candidate/v1",
    repository: repository(input.repository),
    protectedBase: protectedBase(input.protectedBase),
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "pullRequestNumber",
    ),
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    assignmentRoot: exactRoot(input.assignmentRoot, "assignmentRoot"),
    sourceIdentityRoot: exactRoot(
      input.sourceIdentityRoot,
      "sourceIdentityRoot",
    ),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
  });
}

function normalizePolicy(input = {}) {
  const maxQualificationLanes = positiveInteger(
    input.maxQualificationLanes,
    "policy.maxQualificationLanes",
    2,
  );
  if (maxQualificationLanes > 2) {
    throw new Error("policy.maxQualificationLanes cannot exceed 2");
  }
  return {
    maxQualificationLanes,
    laneLeaseSeconds: positiveInteger(
      input.laneLeaseSeconds,
      "policy.laneLeaseSeconds",
      1800,
    ),
    warrantLeaseSeconds: positiveInteger(
      input.warrantLeaseSeconds,
      "policy.warrantLeaseSeconds",
      900,
    ),
    agingSeconds: positiveInteger(
      input.agingSeconds,
      "policy.agingSeconds",
      300,
    ),
  };
}

function normalizeCandidate(input, state) {
  const normalized = {
    candidateId: exactRoot(input.candidateId, "candidate.candidateId"),
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "candidate.pullRequestNumber",
    ),
    sourceHead: exactSha(input.sourceHead, "candidate.sourceHead"),
    assignmentRoot: exactRoot(input.assignmentRoot, "candidate.assignmentRoot"),
    nativeProofRoot: exactRoot(
      input.nativeProofRoot,
      "candidate.nativeProofRoot",
    ),
    sourceIdentityRoot: exactRoot(
      input.sourceIdentityRoot,
      "candidate.sourceIdentityRoot",
    ),
    sourcePatchRoot: exactRoot(
      input.sourcePatchRoot,
      "candidate.sourcePatchRoot",
    ),
    planRoot: exactRoot(input.planRoot, "candidate.planRoot"),
    closureRoot: exactRoot(input.closureRoot, "candidate.closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "candidate.dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "candidate.toolchainRoot"),
    delta: text(input.delta).toLowerCase(),
    conflictKeys: [...new Set((input.conflictKeys || []).map(text))]
      .filter(Boolean)
      .sort(),
    status: text(input.status),
    enqueuedAt: timestamp(input.enqueuedAt, "candidate.enqueuedAt"),
    updatedAt: timestamp(input.updatedAt, "candidate.updatedAt"),
    attempts: positiveInteger(input.attempts, "candidate.attempts", 1),
    recoveries: nonNegative(input.recoveries, "candidate.recoveries"),
    qualificationProof: input.qualificationProof
      ? {
          root: exactRoot(
            input.qualificationProof.root,
            "candidate.qualificationProof.root",
          ),
          sourceHead: exactSha(
            input.qualificationProof.sourceHead,
            "candidate.qualificationProof.sourceHead",
          ),
          protectedBaseHead: exactSha(
            input.qualificationProof.protectedBaseHead,
            "candidate.qualificationProof.protectedBaseHead",
          ),
          qualifiedAt: timestamp(
            input.qualificationProof.qualifiedAt,
            "candidate.qualificationProof.qualifiedAt",
          ),
          reusable: input.qualificationProof.reusable === true,
        }
      : null,
    terminal: input.terminal || null,
  };
  if (!DELTAS.has(normalized.delta)) {
    throw new Error(`unsupported candidate delta ${normalized.delta}`);
  }
  if (
    ![
      "queued",
      "qualifying",
      "qualified",
      "waiting-warrant",
      "landing",
      ...TERMINAL,
    ].includes(normalized.status)
  ) {
    throw new Error(
      `unsupported qualification candidate status ${normalized.status}`,
    );
  }
  const expectedId = candidateId({ ...normalized, ...state });
  if (normalized.candidateId !== expectedId) {
    throw new Error(
      `qualification candidateId mismatch for PR #${normalized.pullRequestNumber}`,
    );
  }
  return normalized;
}

function normalizeLane(input) {
  if (input.schema !== DEV_DELIVERY_QUALIFICATION_LANE_SCHEMA) {
    throw new Error("qualification lane schema is unsupported");
  }
  return {
    schema: DEV_DELIVERY_QUALIFICATION_LANE_SCHEMA,
    laneId: exactRoot(input.laneId, "lane.laneId"),
    candidateId: exactRoot(input.candidateId, "lane.candidateId"),
    sourceHead: exactSha(input.sourceHead, "lane.sourceHead"),
    protectedBaseHead: exactSha(
      input.protectedBaseHead,
      "lane.protectedBaseHead",
    ),
    generation: positiveInteger(input.generation, "lane.generation"),
    fencingToken: exactRoot(input.fencingToken, "lane.fencingToken"),
    issuedAt: timestamp(input.issuedAt, "lane.issuedAt"),
    heartbeatAt: timestamp(input.heartbeatAt, "lane.heartbeatAt"),
    expiresAt: timestamp(input.expiresAt, "lane.expiresAt"),
  };
}

function normalizeWarrant(input) {
  if (!input) return null;
  if (input.schema !== DEV_DELIVERY_LANDING_WARRANT_SCHEMA) {
    throw new Error("Landing Warrant schema is unsupported");
  }
  return {
    schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
    candidateId: exactRoot(input.candidateId, "landingWarrant.candidateId"),
    sourceHead: exactSha(input.sourceHead, "landingWarrant.sourceHead"),
    protectedBaseHead: exactSha(
      input.protectedBaseHead,
      "landingWarrant.protectedBaseHead",
    ),
    qualificationProofRoot: exactRoot(
      input.qualificationProofRoot,
      "landingWarrant.qualificationProofRoot",
    ),
    generation: positiveInteger(input.generation, "landingWarrant.generation"),
    fencingToken: exactRoot(input.fencingToken, "landingWarrant.fencingToken"),
    issuedAt: timestamp(input.issuedAt, "landingWarrant.issuedAt"),
    expiresAt: timestamp(input.expiresAt, "landingWarrant.expiresAt"),
  };
}

function validateCandidateQualificationBinding(candidate, state) {
  if (
    candidate.qualificationProof &&
    candidate.qualificationProof.sourceHead !== candidate.sourceHead
  ) {
    throw new Error("qualification proof exact-head drift");
  }
  if (
    ["qualified", "waiting-warrant", "landing"].includes(candidate.status) &&
    (!candidate.qualificationProof ||
      candidate.qualificationProof.protectedBaseHead !==
        state.protectedBaseHead)
  ) {
    throw new Error("qualified candidate proof does not bind protected Dev");
  }
}

function landingWarrantMatches(state, candidate) {
  return Boolean(
    candidate &&
    candidate.status === "landing" &&
    state.landingWarrant.sourceHead === candidate.sourceHead &&
    state.landingWarrant.protectedBaseHead === state.protectedBaseHead &&
    state.landingWarrant.qualificationProofRoot ===
      candidate.qualificationProof?.root,
  );
}

export function createDevDeliveryQualificationState({
  repository: repositoryInput,
  protectedBase: protectedBaseInput,
  protectedBaseHead,
  policy = {},
  now = new Date().toISOString(),
} = {}) {
  return rooted({
    contract: DEV_DELIVERY_QUALIFICATION_LANES_CONTRACT,
    repository: repository(repositoryInput),
    protectedBase: protectedBase(protectedBaseInput),
    protectedBaseHead: exactSha(protectedBaseHead, "protectedBaseHead"),
    generation: 0,
    fencingCounter: 0,
    policy: normalizePolicy(policy),
    candidates: [],
    lanes: [],
    landingWarrant: null,
    warrantHistory: [],
    telemetry: {
      maxObservedQualificationLanes: 0,
      maxObservedLandingWarrants: 0,
      recoveredLaneCount: 0,
      reusedProofCount: 0,
    },
    updatedAt: timestamp(now, "now"),
  });
}

export function normalizeDevDeliveryQualificationState(input, expected = {}) {
  const state = clone(input || {});
  if (state.contract !== DEV_DELIVERY_QUALIFICATION_LANES_CONTRACT) {
    throw new Error(
      `qualification state must use ${DEV_DELIVERY_QUALIFICATION_LANES_CONTRACT}`,
    );
  }
  state.repository = repository(state.repository);
  state.protectedBase = protectedBase(state.protectedBase);
  state.protectedBaseHead = exactSha(
    state.protectedBaseHead,
    "protectedBaseHead",
  );
  if (expected.repository && state.repository !== expected.repository) {
    throw new Error("qualification state repository mismatch");
  }
  if (
    expected.protectedBase &&
    state.protectedBase !== expected.protectedBase
  ) {
    throw new Error("qualification state protectedBase mismatch");
  }
  state.generation = nonNegative(state.generation, "state.generation");
  state.fencingCounter = nonNegative(
    state.fencingCounter,
    "state.fencingCounter",
  );
  state.policy = normalizePolicy(state.policy);
  state.candidates = (state.candidates || []).map((entry) =>
    normalizeCandidate(entry, state),
  );
  state.lanes = (state.lanes || []).map(normalizeLane);
  state.landingWarrant = normalizeWarrant(state.landingWarrant);
  state.warrantHistory = state.warrantHistory || [];
  state.telemetry = {
    maxObservedQualificationLanes: nonNegative(
      state.telemetry?.maxObservedQualificationLanes,
      "telemetry.maxObservedQualificationLanes",
    ),
    maxObservedLandingWarrants: nonNegative(
      state.telemetry?.maxObservedLandingWarrants,
      "telemetry.maxObservedLandingWarrants",
    ),
    recoveredLaneCount: nonNegative(
      state.telemetry?.recoveredLaneCount,
      "telemetry.recoveredLaneCount",
    ),
    reusedProofCount: nonNegative(
      state.telemetry?.reusedProofCount,
      "telemetry.reusedProofCount",
    ),
  };
  state.updatedAt = timestamp(state.updatedAt, "state.updatedAt");
  if (state.lanes.length > state.policy.maxQualificationLanes) {
    throw new Error("active qualification lanes exceed the policy bound");
  }
  if (
    new Set(state.lanes.map((lane) => lane.candidateId)).size !==
    state.lanes.length
  ) {
    throw new Error("candidate occupies more than one qualification lane");
  }
  for (const lane of state.lanes) {
    const candidate = state.candidates.find(
      (entry) => entry.candidateId === lane.candidateId,
    );
    if (!candidate || candidate.status !== "qualifying") {
      throw new Error("qualification lane must bind one qualifying candidate");
    }
    if (
      candidate.sourceHead !== lane.sourceHead ||
      lane.protectedBaseHead !== state.protectedBaseHead
    ) {
      throw new Error("qualification lane exact-head or protected-base drift");
    }
  }
  for (const candidate of state.candidates) {
    validateCandidateQualificationBinding(candidate, state);
  }
  if (state.landingWarrant) {
    const candidate = state.candidates.find(
      (entry) => entry.candidateId === state.landingWarrant.candidateId,
    );
    if (!landingWarrantMatches(state, candidate)) {
      throw new Error("Landing Warrant must bind one landing candidate");
    }
  }
  if (state.telemetry.maxObservedLandingWarrants > 1) {
    throw new Error("telemetry proves more than one Landing Warrant");
  }
  const expectedRoot = contentRoot(body(state));
  if (state.stateRoot && state.stateRoot !== expectedRoot) {
    throw new Error("qualification stateRoot drift");
  }
  return { ...state, stateRoot: expectedRoot };
}

function transition(stateInput, mutate, { now, expectedStateRoot } = {}) {
  const before = normalizeDevDeliveryQualificationState(stateInput);
  if (
    expectedStateRoot &&
    before.stateRoot !== exactRoot(expectedStateRoot, "expectedStateRoot")
  ) {
    throw new Error("stale qualification controller expected-old state root");
  }
  const after = clone(before);
  mutate(after, before);
  after.generation += 1;
  after.updatedAt = timestamp(now || new Date().toISOString(), "now");
  after.telemetry.maxObservedQualificationLanes = Math.max(
    after.telemetry.maxObservedQualificationLanes,
    after.lanes.length,
  );
  after.telemetry.maxObservedLandingWarrants = Math.max(
    after.telemetry.maxObservedLandingWarrants,
    after.landingWarrant ? 1 : 0,
  );
  const normalized = normalizeDevDeliveryQualificationState(rooted(after));
  return {
    before,
    after: normalized,
    expectedOldStateRoot: before.stateRoot,
    nextStateRoot: normalized.stateRoot,
  };
}

export function submitDevDeliveryQualificationCandidate(
  stateInput,
  input,
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const delta = text(input.delta).toLowerCase();
  if (!DELTAS.has(delta))
    throw new Error(`unsupported candidate delta ${delta}`);
  const identity = {
    ...input,
    repository: state.repository,
    protectedBase: state.protectedBase,
  };
  const id = candidateId(identity);
  const exactHead = exactSha(input.sourceHead, "sourceHead");
  const nativeProofRoot = exactRoot(input.nativeProofRoot, "nativeProofRoot");
  const existing = state.candidates.find(
    (entry) => entry.candidateId === id && !TERMINAL.has(entry.status),
  );
  if (existing?.sourceHead === exactHead) {
    const conflictKeys = [...new Set((input.conflictKeys || []).map(text))]
      .filter(Boolean)
      .sort();
    const evidenceMatches =
      existing.nativeProofRoot === nativeProofRoot &&
      existing.planRoot === exactRoot(input.planRoot, "planRoot") &&
      existing.closureRoot === exactRoot(input.closureRoot, "closureRoot") &&
      existing.dependencyRoot ===
        exactRoot(input.dependencyRoot, "dependencyRoot") &&
      existing.toolchainRoot ===
        exactRoot(input.toolchainRoot, "toolchainRoot") &&
      existing.delta === delta &&
      JSON.stringify(existing.conflictKeys) === JSON.stringify(conflictKeys);
    if (!evidenceMatches) {
      throw new Error("duplicate qualification candidate evidence drift");
    }
    return {
      state,
      receipt: {
        action: "duplicate-noop",
        candidateId: id,
        expectedOldStateRoot: state.stateRoot,
        nextStateRoot: state.stateRoot,
      },
    };
  }
  const predecessor = state.candidates.find(
    (entry) =>
      entry.pullRequestNumber === Number(input.pullRequestNumber) &&
      entry.sourceIdentityRoot ===
        exactRoot(input.sourceIdentityRoot, "sourceIdentityRoot") &&
      !TERMINAL.has(entry.status),
  );
  const tx = transition(
    state,
    (after) => {
      if (predecessor) {
        const lane = after.lanes.find(
          (entry) => entry.candidateId === predecessor.candidateId,
        );
        if (lane) after.lanes = after.lanes.filter((entry) => entry !== lane);
        const prior = after.candidates.find(
          (entry) =>
            entry.candidateId === predecessor.candidateId &&
            !TERMINAL.has(entry.status),
        );
        prior.status = "superseded";
        prior.updatedAt = now;
        prior.terminal = {
          reason: "exact-head-change",
          evidenceRoot: exactRoot(
            input.headChangeEvidenceRoot,
            "headChangeEvidenceRoot",
          ),
          at: now,
        };
      }
      const blocked = delta !== "disjoint";
      after.candidates.push({
        candidateId: id,
        pullRequestNumber: positiveInteger(
          input.pullRequestNumber,
          "pullRequestNumber",
        ),
        sourceHead: exactHead,
        assignmentRoot: exactRoot(input.assignmentRoot, "assignmentRoot"),
        nativeProofRoot,
        sourceIdentityRoot: exactRoot(
          input.sourceIdentityRoot,
          "sourceIdentityRoot",
        ),
        sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
        planRoot: exactRoot(input.planRoot, "planRoot"),
        closureRoot: exactRoot(input.closureRoot, "closureRoot"),
        dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
        toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
        delta,
        conflictKeys: [...new Set((input.conflictKeys || []).map(text))]
          .filter(Boolean)
          .sort(),
        status: blocked ? "failed" : "queued",
        enqueuedAt: predecessor?.enqueuedAt || now,
        updatedAt: now,
        attempts: predecessor ? predecessor.attempts + 1 : 1,
        recoveries: predecessor?.recoveries || 0,
        qualificationProof: null,
        terminal: blocked
          ? {
              reason: `${delta}-delta-fails-closed`,
              evidenceRoot: exactRoot(
                input.deltaEvidenceRoot,
                "deltaEvidenceRoot",
              ),
              at: now,
            }
          : null,
      });
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    receipt: {
      action: delta === "disjoint" ? "submitted" : "failed-closed",
      candidateId: id,
      delta,
      nativeProofRetained: predecessor?.nativeProofRoot === nativeProofRoot,
      expectedOldStateRoot: tx.expectedOldStateRoot,
      nextStateRoot: tx.nextStateRoot,
    },
  };
}

function conflict(left, right) {
  const keys = new Set(right.conflictKeys);
  return left.conflictKeys.some((entry) => keys.has(entry));
}

function recoverExpiredLanes(state, now) {
  const expired = state.lanes.filter(
    (lane) => Date.parse(lane.expiresAt) <= Date.parse(now),
  );
  if (expired.length === 0) return [];
  for (const lane of expired) {
    const candidate = state.candidates.find(
      (entry) => entry.candidateId === lane.candidateId,
    );
    candidate.status = candidate.qualificationProof ? "qualified" : "queued";
    candidate.recoveries += 1;
    candidate.updatedAt = now;
  }
  state.lanes = state.lanes.filter((lane) => !expired.includes(lane));
  state.telemetry.recoveredLaneCount += expired.length;
  return expired.map((lane) => lane.laneId);
}

export function scheduleDevDeliveryQualificationLanes(
  stateInput,
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const tx = transition(
    stateInput,
    (after) => {
      recoverExpiredLanes(after, now);
      const activeCandidates = after.lanes.map((lane) =>
        after.candidates.find(
          (entry) => entry.candidateId === lane.candidateId,
        ),
      );
      const queued = after.candidates
        .filter((candidate) => candidate.status === "queued")
        .sort(
          (left, right) =>
            left.enqueuedAt.localeCompare(right.enqueuedAt) ||
            left.candidateId.localeCompare(right.candidateId),
        );
      for (const candidate of queued) {
        if (after.lanes.length >= after.policy.maxQualificationLanes) break;
        if (activeCandidates.some((entry) => conflict(candidate, entry)))
          continue;
        after.fencingCounter += 1;
        const generation = candidate.recoveries + 1;
        const laneId = contentRoot({
          schema: DEV_DELIVERY_QUALIFICATION_LANE_SCHEMA,
          candidateId: candidate.candidateId,
          generation,
          stateRoot: after.stateRoot,
        });
        const fencingToken = contentRoot({
          laneId,
          counter: after.fencingCounter,
          issuedAt: now,
        });
        after.lanes.push({
          schema: DEV_DELIVERY_QUALIFICATION_LANE_SCHEMA,
          laneId,
          candidateId: candidate.candidateId,
          sourceHead: candidate.sourceHead,
          protectedBaseHead: after.protectedBaseHead,
          generation,
          fencingToken,
          issuedAt: now,
          heartbeatAt: now,
          expiresAt: new Date(
            Date.parse(now) + after.policy.laneLeaseSeconds * 1000,
          ).toISOString(),
        });
        candidate.status = "qualifying";
        candidate.updatedAt = now;
        activeCandidates.push(candidate);
      }
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    lanes: tx.after.lanes,
    receipt: {
      action: "qualification-lanes-scheduled",
      laneCount: tx.after.lanes.length,
      maxQualificationLanes: tx.after.policy.maxQualificationLanes,
      expectedOldStateRoot: tx.expectedOldStateRoot,
      nextStateRoot: tx.nextStateRoot,
    },
  };
}

function exactLane(state, input, now) {
  const lane = state.lanes.find(
    (entry) => entry.laneId === exactRoot(input.laneId, "laneId"),
  );
  if (!lane) throw new Error("qualification lane is not active");
  if (lane.fencingToken !== exactRoot(input.fencingToken, "fencingToken")) {
    throw new Error("stale qualification lane fencing token");
  }
  if (lane.generation !== positiveInteger(input.generation, "generation")) {
    throw new Error("stale qualification lane generation");
  }
  if (Date.parse(lane.expiresAt) <= Date.parse(now)) {
    throw new Error("qualification lane lease expired");
  }
  return lane;
}

export function heartbeatDevDeliveryQualificationLane(
  stateInput,
  input,
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const lane = exactLane(state, input, now);
  const tx = transition(
    state,
    (after) => {
      const current = after.lanes.find((entry) => entry.laneId === lane.laneId);
      current.heartbeatAt = now;
      current.expiresAt = new Date(
        Date.parse(now) + after.policy.laneLeaseSeconds * 1000,
      ).toISOString();
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    lane: tx.after.lanes.find((entry) => entry.laneId === lane.laneId),
  };
}

export function settleDevDeliveryQualificationLane(
  stateInput,
  input,
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const lane = exactLane(state, input, now);
  const outcome = text(input.outcome);
  if (!["qualified", "failed"].includes(outcome)) {
    throw new Error("qualification outcome must be qualified or failed");
  }
  const failureClass = text(input.failureClass);
  const failureEvidenceRoot =
    outcome === "failed" ? exactRoot(input.evidenceRoot, "evidenceRoot") : null;
  const tx = transition(
    state,
    (after) => {
      const candidate = after.candidates.find(
        (entry) => entry.candidateId === lane.candidateId,
      );
      after.lanes = after.lanes.filter((entry) => entry.laneId !== lane.laneId);
      if (outcome === "qualified") {
        candidate.qualificationProof = {
          root: exactRoot(input.proofRoot, "proofRoot"),
          sourceHead: candidate.sourceHead,
          protectedBaseHead: after.protectedBaseHead,
          qualifiedAt: now,
          reusable: true,
        };
        candidate.status = "qualified";
        candidate.terminal = null;
      } else if (RETRYABLE_FAILURES.has(failureClass)) {
        candidate.status = candidate.qualificationProof
          ? "qualified"
          : "queued";
        candidate.attempts += 1;
        if (candidate.qualificationProof) after.telemetry.reusedProofCount += 1;
      } else {
        candidate.status = "failed";
        candidate.terminal = {
          reason: failureClass || "deterministic-qualification-failure",
          evidenceRoot: failureEvidenceRoot,
          at: now,
        };
      }
      candidate.updatedAt = now;
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    receipt: {
      action:
        outcome === "qualified"
          ? "qualification-sealed"
          : RETRYABLE_FAILURES.has(failureClass)
            ? "retry-converged"
            : "qualification-failed",
      candidateId: lane.candidateId,
      failureClass: outcome === "failed" ? failureClass : null,
      evidenceRoot: failureEvidenceRoot,
      expectedOldStateRoot: tx.expectedOldStateRoot,
      nextStateRoot: tx.nextStateRoot,
    },
  };
}

export function cancelDevDeliveryQualificationCandidate(
  stateInput,
  {
    candidateId: candidateIdInput,
    sourceHead,
    evidenceRoot,
    reason = "cancelled",
  } = {},
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const id = exactRoot(candidateIdInput, "candidateId");
  const head = exactSha(sourceHead, "sourceHead");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const candidate = state.candidates.find(
    (entry) => entry.candidateId === id && !TERMINAL.has(entry.status),
  );
  if (!candidate) {
    return { state, receipt: { action: "cancellation-not-applicable" } };
  }
  if (candidate.sourceHead !== head) {
    throw new Error("cancellation exact-head mismatch");
  }
  if (state.landingWarrant?.candidateId === id) {
    throw new Error("active Landing Warrant requires fenced settlement");
  }
  const tx = transition(
    state,
    (after) => {
      after.lanes = after.lanes.filter((lane) => lane.candidateId !== id);
      const current = after.candidates.find(
        (entry) => entry.candidateId === id && !TERMINAL.has(entry.status),
      );
      current.status = "cancelled";
      current.updatedAt = now;
      current.terminal = {
        reason: text(reason) || "cancelled",
        evidenceRoot: exactRoot(evidenceRoot, "evidenceRoot"),
        at: now,
      };
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    receipt: {
      action: "qualification-candidate-cancelled",
      candidateId: id,
      expectedOldStateRoot: tx.expectedOldStateRoot,
      nextStateRoot: tx.nextStateRoot,
    },
  };
}

export function advanceDevDeliveryQualificationBase(
  stateInput,
  { protectedBaseHead, candidateDeltas = {}, evidenceRoot } = {},
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const nextHead = exactSha(protectedBaseHead, "protectedBaseHead");
  const advanceEvidenceRoot = exactRoot(evidenceRoot, "evidenceRoot");
  const tx = transition(
    stateInput,
    (after) => {
      if (after.landingWarrant) {
        throw new Error(
          "cannot advance qualification base with an active Landing Warrant",
        );
      }
      after.protectedBaseHead = nextHead;
      after.lanes = [];
      for (const candidate of after.candidates.filter(
        (entry) => !TERMINAL.has(entry.status),
      )) {
        const delta = text(candidateDeltas[candidate.candidateId] || "unknown");
        if (!DELTAS.has(delta))
          throw new Error(`unsupported Dev delta ${delta}`);
        if (delta === "disjoint" && candidate.qualificationProof?.reusable) {
          candidate.qualificationProof.protectedBaseHead = nextHead;
          candidate.status = "qualified";
          after.telemetry.reusedProofCount += 1;
        } else if (delta === "disjoint") {
          candidate.status = "queued";
        } else {
          candidate.status = "failed";
          candidate.terminal = {
            reason: `${delta}-dev-advance-fails-closed`,
            evidenceRoot: advanceEvidenceRoot,
            at: now,
          };
        }
        candidate.delta = delta;
        candidate.updatedAt = now;
      }
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    receipt: {
      action: "qualification-base-advanced",
      previousProtectedBaseHead: tx.before.protectedBaseHead,
      protectedBaseHead: tx.after.protectedBaseHead,
      evidenceRoot: advanceEvidenceRoot,
      expectedOldStateRoot: tx.expectedOldStateRoot,
      nextStateRoot: tx.nextStateRoot,
    },
  };
}

export function issueDevDeliveryLandingWarrant(stateInput, options = {}) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  if (state.landingWarrant) {
    return {
      state,
      warrant: state.landingWarrant,
      action: "active-warrant-retained",
    };
  }
  const selected = state.candidates
    .filter((candidate) => candidate.status === "qualified")
    .sort(
      (left, right) =>
        left.enqueuedAt.localeCompare(right.enqueuedAt) ||
        left.candidateId.localeCompare(right.candidateId),
    )[0];
  if (!selected)
    return { state, warrant: null, action: "no-qualified-candidate" };
  const tx = transition(
    state,
    (after) => {
      const candidate = after.candidates.find(
        (entry) => entry.candidateId === selected.candidateId,
      );
      after.fencingCounter += 1;
      const generation = after.warrantHistory.length + 1;
      const issuedAt = now;
      const warrant = {
        schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
        candidateId: candidate.candidateId,
        sourceHead: candidate.sourceHead,
        protectedBaseHead: after.protectedBaseHead,
        qualificationProofRoot: candidate.qualificationProof.root,
        generation,
        fencingToken: contentRoot({
          schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
          candidateId: candidate.candidateId,
          generation,
          counter: after.fencingCounter,
          issuedAt,
        }),
        issuedAt,
        expiresAt: new Date(
          Date.parse(now) + after.policy.warrantLeaseSeconds * 1000,
        ).toISOString(),
      };
      after.landingWarrant = warrant;
      candidate.status = "landing";
      candidate.updatedAt = now;
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    warrant: tx.after.landingWarrant,
    action: "landing-warrant-issued",
  };
}

export function recoverExpiredDevDeliveryLandingWarrant(
  stateInput,
  { evidenceRoot } = {},
  options = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const warrant = state.landingWarrant;
  if (!warrant || Date.parse(warrant.expiresAt) > Date.parse(now)) {
    return { state, receipt: { action: "landing-warrant-not-expired" } };
  }
  return settleDevDeliveryLandingWarrantInternal(
    state,
    {
      fencingToken: warrant.fencingToken,
      generation: warrant.generation,
      outcome: "retry",
      evidenceRoot,
      reason: "landing-warrant-lease-expired",
    },
    { ...options, now },
    { allowExpiredRecovery: true },
  );
}

function settleDevDeliveryLandingWarrantInternal(
  stateInput,
  input,
  options = {},
  { allowExpiredRecovery = false } = {},
) {
  const now = timestamp(options.now || new Date().toISOString(), "now");
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const warrant = state.landingWarrant;
  if (!warrant) throw new Error("no active Landing Warrant");
  if (
    Date.parse(warrant.expiresAt) <= Date.parse(now) &&
    !allowExpiredRecovery
  ) {
    throw new Error("Landing Warrant lease expired");
  }
  if (
    warrant.fencingToken !== exactRoot(input.fencingToken, "fencingToken") ||
    warrant.generation !== positiveInteger(input.generation, "generation")
  ) {
    throw new Error("stale Landing Warrant authority");
  }
  const outcome = text(input.outcome);
  if (!["landed", "retry", "cancelled", "failed"].includes(outcome)) {
    throw new Error("unsupported Landing Warrant outcome");
  }
  const tx = transition(
    state,
    (after) => {
      const candidate = after.candidates.find(
        (entry) => entry.candidateId === warrant.candidateId,
      );
      const settlement = {
        ...warrant,
        outcome,
        evidenceRoot: exactRoot(input.evidenceRoot, "evidenceRoot"),
        settledAt: now,
      };
      after.warrantHistory.push(settlement);
      after.landingWarrant = null;
      candidate.status = outcome === "retry" ? "qualified" : outcome;
      candidate.updatedAt = now;
      candidate.terminal =
        outcome === "retry"
          ? null
          : {
              reason: text(input.reason || outcome),
              evidenceRoot: settlement.evidenceRoot,
              at: now,
            };
      if (outcome === "retry") after.telemetry.reusedProofCount += 1;
    },
    { ...options, now },
  );
  return {
    state: tx.after,
    receipt: {
      action: "landing-warrant-settled",
      outcome,
      candidateId: warrant.candidateId,
      expectedOldStateRoot: tx.expectedOldStateRoot,
      nextStateRoot: tx.nextStateRoot,
    },
  };
}

export function settleDevDeliveryLandingWarrant(
  stateInput,
  input,
  options = {},
) {
  return settleDevDeliveryLandingWarrantInternal(stateInput, input, options);
}

export function observeDevDeliveryQualificationState(
  stateInput,
  { now = new Date().toISOString() } = {},
) {
  const state = normalizeDevDeliveryQualificationState(stateInput);
  const states = {};
  for (const candidate of state.candidates) {
    states[candidate.status] = (states[candidate.status] || 0) + 1;
  }
  return {
    schema: "kungfu.buildchain.dev-delivery-qualification-observation/v1",
    repository: state.repository,
    protectedBase: state.protectedBase,
    protectedBaseHead: state.protectedBaseHead,
    stateRoot: state.stateRoot,
    generation: state.generation,
    activeQualificationLaneCount: state.lanes.length,
    activeLandingWarrantCount: state.landingWarrant ? 1 : 0,
    lanes: state.lanes,
    landingWarrant: state.landingWarrant,
    states,
    telemetry: state.telemetry,
    observedAt: timestamp(now, "now"),
  };
}

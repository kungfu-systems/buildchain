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
  normalizeDevDeliveryQueue,
  rankDevDeliveryCandidates,
} from "./dev-delivery-warrant.js";

export const DEV_DELIVERY_WARRANT_SHADOW_OBSERVATION_SCHEMA =
  "kungfu.buildchain.dev-delivery-warrant-shadow-observation/v1";
export const DEV_DELIVERY_WARRANT_SHADOW_PLAN_SCHEMA =
  "kungfu.buildchain.dev-delivery-warrant-shadow-plan/v1";
export const DEV_DELIVERY_WARRANT_SHADOW_QUALIFICATION_SCHEMA =
  "kungfu.buildchain.dev-delivery-warrant-shadow-qualification/v1";

const EVIDENCE_STATES = Object.freeze({
  projectCut: "qualified",
  approval: "approved",
  requiredChecks: "passed",
  status: "ready",
});

function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function evidenceBinding(input, label) {
  const binding = input || {};
  return {
    candidateId: exactRoot(binding.candidateId, `${label}.candidateId`),
    sourceHead: exactSha(binding.sourceHead, `${label}.sourceHead`),
    baseHead: exactSha(binding.baseHead, `${label}.baseHead`),
    root: exactRoot(binding.root, `${label}.root`),
    state: text(binding.state),
  };
}

function laneBinding(input) {
  const binding = input || {};
  return {
    candidateId: exactRoot(binding.candidateId, "binding.candidateId"),
    sourceHead: exactSha(binding.sourceHead, "binding.sourceHead"),
    baseHead: exactSha(binding.baseHead, "binding.baseHead"),
    queueGeneration: nonNegativeInteger(
      binding.queueGeneration,
      "binding.queueGeneration",
    ),
    queueStateRoot: exactRoot(binding.queueStateRoot, "binding.queueStateRoot"),
    projectedBaseRoot: exactRoot(
      binding.projectedBaseRoot,
      "binding.projectedBaseRoot",
    ),
    warrantFencingToken: binding.warrantFencingToken
      ? exactRoot(binding.warrantFencingToken, "binding.warrantFencingToken")
      : null,
    warrantGeneration:
      binding.warrantGeneration == null
        ? null
        : positiveInteger(
            binding.warrantGeneration,
            "binding.warrantGeneration",
          ),
    projectCut: evidenceBinding(binding.projectCut, "binding.projectCut"),
    approval: evidenceBinding(binding.approval, "binding.approval"),
    requiredChecks: evidenceBinding(
      binding.requiredChecks,
      "binding.requiredChecks",
    ),
    status: evidenceBinding(binding.status, "binding.status"),
    lease: {
      ...evidenceBinding(binding.lease, "binding.lease"),
      state: text(binding.lease?.state),
    },
    conflictKeys: [
      ...new Set((binding.conflictKeys || []).map((entry) => text(entry))),
    ]
      .filter(Boolean)
      .sort(),
    expectedEligible:
      binding.expectedEligible == null
        ? null
        : boolean(binding.expectedEligible, "binding.expectedEligible"),
  };
}

function normalizeObservation(input) {
  const observation = clone(input || {});
  if (observation.schema !== DEV_DELIVERY_WARRANT_SHADOW_OBSERVATION_SCHEMA) {
    throw new Error(
      `shadow observation must use ${DEV_DELIVERY_WARRANT_SHADOW_OBSERVATION_SCHEMA}`,
    );
  }
  const queue = normalizeDevDeliveryQueue(observation.queue);
  const normalized = {
    schema: observation.schema,
    observationId: text(observation.observationId),
    kind: text(observation.kind || "replay"),
    observedAt: timestamp(observation.observedAt, "observation.observedAt"),
    protectedBaseHead: exactSha(
      observation.protectedBaseHead,
      "observation.protectedBaseHead",
    ),
    projectedBaseRoot: exactRoot(
      observation.projectedBaseRoot,
      "observation.projectedBaseRoot",
    ),
    queue,
    nativeQueue: {
      occupied: boolean(
        observation.nativeQueue?.occupied,
        "observation.nativeQueue.occupied",
      ),
      entryCount: nonNegativeInteger(
        observation.nativeQueue?.entryCount,
        "observation.nativeQueue.entryCount",
      ),
      root: exactRoot(
        observation.nativeQueue?.root,
        "observation.nativeQueue.root",
      ),
    },
    candidateBindings: (observation.candidateBindings || []).map(laneBinding),
    metrics: {
      baselineQueueWaitSeconds: nonNegativeInteger(
        observation.metrics?.baselineQueueWaitSeconds,
        "observation.metrics.baselineQueueWaitSeconds",
      ),
      shadowQueueWaitSeconds: nonNegativeInteger(
        observation.metrics?.shadowQueueWaitSeconds,
        "observation.metrics.shadowQueueWaitSeconds",
      ),
      additionalCheckSeconds: nonNegativeInteger(
        observation.metrics?.additionalCheckSeconds,
        "observation.metrics.additionalCheckSeconds",
      ),
      additionalRunnerSeconds: nonNegativeInteger(
        observation.metrics?.additionalRunnerSeconds,
        "observation.metrics.additionalRunnerSeconds",
      ),
      ambiguous: boolean(
        observation.metrics?.ambiguous ?? false,
        "observation.metrics.ambiguous",
      ),
    },
  };
  if (!normalized.observationId) {
    throw new Error("observation.observationId is required");
  }
  const bindingIds = normalized.candidateBindings.map(
    (binding) => binding.candidateId,
  );
  if (new Set(bindingIds).size !== bindingIds.length) {
    throw new Error("shadow observation contains duplicate candidate bindings");
  }
  return normalized;
}

function productionOrder(queue, now) {
  const active = queue.activeWarrant
    ? queue.candidates.find(
        (candidate) =>
          candidate.candidateId === queue.activeWarrant.candidateId,
      )
    : null;
  const queued = rankDevDeliveryCandidates(queue, { now }).map(
    (entry) => entry.candidate,
  );
  return active ? [active, ...queued] : queued;
}

function bindingReasons({ binding, candidate, observation }) {
  const reasons = [];
  const expect = (condition, reason) => {
    if (!condition) reasons.push(reason);
  };
  expect(
    binding.candidateId === candidate.candidateId,
    "candidate-id-mismatch",
  );
  expect(binding.sourceHead === candidate.sourceHead, "stale-source-head");
  expect(binding.baseHead === observation.protectedBaseHead, "stale-base-head");
  expect(
    binding.queueGeneration === observation.queue.generation,
    "stale-queue-generation",
  );
  expect(
    binding.queueStateRoot === observation.queue.stateRoot,
    "stale-queue-state-root",
  );
  expect(
    binding.projectedBaseRoot === observation.projectedBaseRoot,
    "incompatible-projected-base",
  );
  for (const [name, acceptedState] of Object.entries(EVIDENCE_STATES)) {
    const evidence = binding[name];
    expect(
      evidence.candidateId === candidate.candidateId,
      `${name}-candidate-mismatch`,
    );
    expect(
      evidence.sourceHead === candidate.sourceHead,
      `${name}-head-mismatch`,
    );
    expect(
      evidence.baseHead === observation.protectedBaseHead,
      `${name}-base-mismatch`,
    );
    expect(evidence.state === acceptedState, `${name}-not-${acceptedState}`);
  }
  expect(
    binding.lease.candidateId === candidate.candidateId,
    "lease-candidate-mismatch",
  );
  expect(
    binding.lease.sourceHead === candidate.sourceHead,
    "lease-head-mismatch",
  );
  expect(
    binding.lease.baseHead === observation.protectedBaseHead,
    "lease-base-mismatch",
  );
  const active = observation.queue.activeWarrant;
  if (active?.candidateId === candidate.candidateId) {
    expect(binding.lease.state === "active", "active-lease-not-bound");
    expect(
      binding.warrantFencingToken === active.fencingToken,
      "stale-warrant-fence",
    );
    expect(
      binding.warrantGeneration === active.generation,
      "stale-warrant-generation",
    );
  } else {
    expect(
      binding.lease.state === "available",
      "queued-lane-lease-unavailable",
    );
    expect(binding.warrantFencingToken === null, "queued-lane-has-live-fence");
    expect(
      binding.warrantGeneration === null,
      "queued-lane-has-live-generation",
    );
  }
  return reasons;
}

function aliasedLaneIndexes(lanes) {
  const indexes = new Set();
  const roots = new Map();
  const fields = [
    "projectCut",
    "approval",
    "requiredChecks",
    "status",
    "lease",
  ];
  lanes.forEach((lane, index) => {
    if (!lane.binding) return;
    for (const field of fields) {
      const key = `${field}:${lane.binding[field].root}`;
      const prior = roots.get(key);
      if (prior != null) {
        indexes.add(prior);
        indexes.add(index);
      } else roots.set(key, index);
    }
  });
  return indexes;
}

function conflictingLaneIndexes(lanes) {
  const indexes = new Set();
  for (let left = 0; left < lanes.length; left += 1) {
    for (let right = left + 1; right < lanes.length; right += 1) {
      if (!lanes[left].binding || !lanes[right].binding) continue;
      const rightKeys = new Set(lanes[right].binding.conflictKeys);
      if (lanes[left].binding.conflictKeys.some((key) => rightKeys.has(key))) {
        indexes.add(left);
        indexes.add(right);
      }
    }
  }
  return indexes;
}

export function planDevDeliveryWarrantShadow(
  input,
  { maxConcurrency = 2 } = {},
) {
  const requested = positiveInteger(maxConcurrency, "maxConcurrency");
  if (requested > 2) throw new Error("shadow maxConcurrency cannot exceed 2");
  const observation = normalizeObservation(input);
  const order = productionOrder(observation.queue, observation.observedAt);
  const candidates = order.slice(0, requested);
  const bindings = new Map(
    observation.candidateBindings.map((binding) => [
      binding.candidateId,
      binding,
    ]),
  );
  const lanes = candidates.map((candidate) => {
    const binding = bindings.get(candidate.candidateId);
    const reasonCodes = binding
      ? bindingReasons({ binding, candidate, observation })
      : ["candidate-binding-missing"];
    return { candidate, binding, reasonCodes };
  });
  if (observation.nativeQueue.occupied) {
    for (const lane of lanes) lane.reasonCodes.push("native-queue-occupied");
  }
  for (const index of aliasedLaneIndexes(lanes)) {
    lanes[index].reasonCodes.push("cross-lane-binding-alias");
  }
  for (const index of conflictingLaneIndexes(lanes)) {
    lanes[index].reasonCodes.push("cross-lane-conflict");
  }
  const plannedLanes = lanes.map((lane) => {
    const reasonCodes = [...new Set(lane.reasonCodes)].sort();
    const laneBody = {
      schema: "kungfu.buildchain.dev-delivery-warrant-shadow-lane/v1",
      candidateId: lane.candidate.candidateId,
      pullRequestNumber: lane.candidate.pullRequestNumber,
      sourceHead: lane.candidate.sourceHead,
      baseHead: observation.protectedBaseHead,
      queueStateRoot: observation.queue.stateRoot,
      bindingRoot: lane.binding ? devDeliveryContentRoot(lane.binding) : null,
      accepted: reasonCodes.length === 0,
      reasonCodes,
      effects: [],
      productionAuthority: false,
    };
    return {
      ...laneBody,
      laneId: devDeliveryContentRoot({
        schema: laneBody.schema,
        candidateId: laneBody.candidateId,
        sourceHead: laneBody.sourceHead,
        baseHead: laneBody.baseHead,
        queueStateRoot: laneBody.queueStateRoot,
      }),
    };
  });
  const productionCandidateId = order[0]?.candidateId || null;
  const body = {
    schema: DEV_DELIVERY_WARRANT_SHADOW_PLAN_SCHEMA,
    observationId: observation.observationId,
    observationRoot: devDeliveryContentRoot(observation),
    observedAt: observation.observedAt,
    maxConcurrency: requested,
    productionCandidateId,
    singleFlightParity: {
      evaluated: requested === 1,
      candidateIdentityMatches:
        requested === 1 &&
        (plannedLanes[0]?.candidateId || null) === productionCandidateId,
    },
    lanes: plannedLanes,
    acceptedLaneCount: plannedLanes.filter((lane) => lane.accepted).length,
    rejectedLaneCount: plannedLanes.filter((lane) => !lane.accepted).length,
    deferredCandidateIds: order
      .slice(requested)
      .map((candidate) => candidate.candidateId),
    metrics: observation.metrics,
    decision:
      plannedLanes.some((lane) => lane.accepted) &&
      !observation.nativeQueue.occupied
        ? "qualified-shadow-only"
        : "hold",
    effects: [],
    mutationAllowed: false,
    productionAuthority: "unchanged-single-flight",
    rolloutAuthorized: false,
  };
  return { ...body, planRoot: devDeliveryContentRoot(body) };
}

function thresholds(input = {}) {
  return {
    minObservationCount: positiveInteger(
      input.minObservationCount,
      "thresholds.minObservationCount",
      8,
    ),
    minEligibleOverlapCount: positiveInteger(
      input.minEligibleOverlapCount,
      "thresholds.minEligibleOverlapCount",
      2,
    ),
    minProjectedQueueWaitBenefitSeconds: nonNegativeInteger(
      input.minProjectedQueueWaitBenefitSeconds,
      "thresholds.minProjectedQueueWaitBenefitSeconds",
      300,
    ),
    maxAdditionalRunnerSeconds: nonNegativeInteger(
      input.maxAdditionalRunnerSeconds,
      "thresholds.maxAdditionalRunnerSeconds",
      7200,
    ),
    maxAmbiguityCount: nonNegativeInteger(
      input.maxAmbiguityCount,
      "thresholds.maxAmbiguityCount",
      0,
    ),
    maxFalsePositiveCount: nonNegativeInteger(
      input.maxFalsePositiveCount,
      "thresholds.maxFalsePositiveCount",
      0,
    ),
  };
}

export function qualifyDevDeliveryWarrantShadow(input = {}) {
  const observations = Array.isArray(input.observations)
    ? input.observations
    : [];
  const policy = thresholds(input.thresholds);
  const plans = observations.map((observation) =>
    planDevDeliveryWarrantShadow(observation, { maxConcurrency: 2 }),
  );
  const metrics = plans.reduce(
    (summary, plan) => {
      if (plan.lanes.filter((lane) => lane.accepted).length === 2) {
        summary.eligibleOverlapCount += 1;
      }
      summary.projectedQueueWaitBenefitSeconds += Math.max(
        0,
        plan.metrics.baselineQueueWaitSeconds -
          plan.metrics.shadowQueueWaitSeconds,
      );
      summary.additionalCheckSeconds += plan.metrics.additionalCheckSeconds;
      summary.additionalRunnerSeconds += plan.metrics.additionalRunnerSeconds;
      if (plan.metrics.ambiguous) summary.ambiguityCount += 1;
      const observation = normalizeObservation(
        observations[summary.observationCount],
      );
      const expected = new Map(
        observation.candidateBindings.map((binding) => [
          binding.candidateId,
          binding.expectedEligible,
        ]),
      );
      summary.falsePositiveCount += plan.lanes.filter(
        (lane) => lane.accepted && expected.get(lane.candidateId) === false,
      ).length;
      summary.observationCount += 1;
      return summary;
    },
    {
      observationCount: 0,
      eligibleOverlapCount: 0,
      projectedQueueWaitBenefitSeconds: 0,
      additionalCheckSeconds: 0,
      additionalRunnerSeconds: 0,
      ambiguityCount: 0,
      falsePositiveCount: 0,
    },
  );
  const checks = {
    observationCount: metrics.observationCount >= policy.minObservationCount,
    eligibleOverlap:
      metrics.eligibleOverlapCount >= policy.minEligibleOverlapCount,
    projectedQueueWaitBenefit:
      metrics.projectedQueueWaitBenefitSeconds >=
      policy.minProjectedQueueWaitBenefitSeconds,
    runnerCost:
      metrics.additionalRunnerSeconds <= policy.maxAdditionalRunnerSeconds,
    ambiguity: metrics.ambiguityCount <= policy.maxAmbiguityCount,
    falsePositives: metrics.falsePositiveCount <= policy.maxFalsePositiveCount,
  };
  const decision = Object.values(checks).every(Boolean) ? "proceed" : "hold";
  const body = {
    schema: DEV_DELIVERY_WARRANT_SHADOW_QUALIFICATION_SCHEMA,
    decision,
    reasonCodes: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => `threshold-${name}-not-met`),
    thresholds: policy,
    metrics,
    checks,
    planRoots: plans.map((plan) => plan.planRoot),
    effects: [],
    mutationAllowed: false,
    productionAuthority: "unchanged-single-flight",
    rolloutAuthorized: false,
  };
  return { ...body, qualificationRoot: devDeliveryContentRoot(body), plans };
}

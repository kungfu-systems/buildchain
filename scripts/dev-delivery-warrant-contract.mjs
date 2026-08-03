// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

export const DEV_DELIVERY_QUEUE_SCHEMA =
  "kungfu-buildchain-dev-delivery-warrant-queue/v1";
export const DEV_DELIVERY_RECEIPT_SCHEMA =
  "kungfu-buildchain-dev-delivery-warrant-transition/v1";
export const DEV_DELIVERY_POLICY_VERSION = "fifo-aging-v1";

const SHA = /^[0-9a-f]{40}$/u;
const ROOT = /^sha256:[0-9a-f]{64}$/u;
export const ACTIVE_STATES = new Set([
  "warrant-issued",
  "replaying",
  "proving",
  "waiting",
  "merge-queued",
]);
export const TERMINAL_STATES = new Set([
  "blocked",
  "dequeued",
  "failed",
  "merged",
  "stale",
]);
export const PRIORITIES = Object.freeze({
  ordinary: 0,
  urgent: 1,
  emergency: 2,
});
export const ALLOWED_TRANSITIONS = Object.freeze({
  "warrant-issued": new Set([
    "replaying",
    "proving",
    "waiting",
    "blocked",
    "dequeued",
    "failed",
    "stale",
  ]),
  replaying: new Set([
    "proving",
    "waiting",
    "blocked",
    "dequeued",
    "failed",
    "stale",
  ]),
  proving: new Set([
    "waiting",
    "merge-queued",
    "blocked",
    "dequeued",
    "failed",
    "stale",
  ]),
  waiting: new Set([
    "replaying",
    "proving",
    "merge-queued",
    "blocked",
    "dequeued",
    "failed",
    "stale",
  ]),
  "merge-queued": new Set(["merged", "blocked", "dequeued", "failed", "stale"]),
});

export function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function exactSha(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!SHA.test(normalized))
    throw new Error(`${label} must be an exact Git SHA`);
  return normalized;
}

export function sha256Root(value, label) {
  const normalized = requiredText(value, label).toLowerCase();
  if (!ROOT.test(normalized)) throw new Error(`${label} must be a sha256 root`);
  return normalized;
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function timestamp(value, label) {
  const normalized = requiredText(value, label);
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch))
    throw new Error(`${label} must be an ISO timestamp`);
  return { value: new Date(epoch).toISOString(), epoch };
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function contentRoot(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

export function queueRevision(state) {
  const { revision: _revision, ...body } = state;
  return contentRoot(body);
}

export function withQueueRevision(state) {
  return { ...state, revision: queueRevision(state) };
}

export function repositoryName(value) {
  const normalized = requiredText(value, "repository");
  if (!/^[^/\s]+\/[^/\s]+$/u.test(normalized)) {
    throw new Error("repository must be owner/repo");
  }
  return normalized;
}

function protectedBaseName(value) {
  const normalized = requiredText(value, "protected base").replace(
    /^refs\/heads\//u,
    "",
  );
  if (!/^dev\/v\d+\/v\d+\.\d+$/u.test(normalized)) {
    throw new Error("protected base must be a Buildchain dev channel");
  }
  return normalized;
}

export function createDevDeliveryQueue({
  repository,
  protectedBase,
  now,
  agingQuantumSeconds = 1800,
  warrantTtlSeconds = 2700,
} = {}) {
  const created = timestamp(now, "now").value;
  return withQueueRevision({
    schema: DEV_DELIVERY_QUEUE_SCHEMA,
    repository: repositoryName(repository),
    protectedBase: protectedBaseName(protectedBase),
    policy: {
      version: DEV_DELIVERY_POLICY_VERSION,
      priorities: PRIORITIES,
      agingQuantumSeconds: positiveInteger(
        agingQuantumSeconds,
        "aging quantum seconds",
      ),
      warrantTtlSeconds: positiveInteger(
        warrantTtlSeconds,
        "warrant TTL seconds",
      ),
      selectedPreemption: "forbidden",
      emergencyOverride: "reviewed-policy-successor-required",
    },
    createdAt: created,
    updatedAt: created,
    sequence: 0,
    fenceGeneration: 0,
    activeWarrant: null,
    candidates: [],
    history: [],
    metrics: {
      selections: 0,
      impermissibleOvertakes: 0,
      baseOnlyHeadRotations: 0,
      repeatedHeavyValidations: 0,
      recoveredWarrants: 0,
      staleControllerRejections: 0,
      wastedRunnerSeconds: 0,
    },
  });
}

export function assertDevDeliveryQueue(state) {
  if (!state || state.schema !== DEV_DELIVERY_QUEUE_SCHEMA) {
    throw new Error(`state must use ${DEV_DELIVERY_QUEUE_SCHEMA}`);
  }
  if (state.revision !== queueRevision(state)) {
    throw new Error("queue state revision mismatch");
  }
  const active = state.candidates.filter((candidate) =>
    ACTIVE_STATES.has(candidate.state),
  );
  if (active.length > 1)
    throw new Error("queue contains multiple active candidates");
  if (Boolean(state.activeWarrant) !== (active.length === 1)) {
    throw new Error("active Warrant and candidate state disagree");
  }
  if (
    active.length === 1 &&
    (active[0].submissionId !== state.activeWarrant.submissionId ||
      active[0].warrantId !== state.activeWarrant.warrantId)
  ) {
    throw new Error("active Warrant does not bind the selected candidate");
  }
}

export function assertExpectedOld(state, command) {
  const expected = requiredText(
    command.expectedOldRevision,
    "expected-old revision",
  );
  if (expected !== state.revision) {
    const error = new Error(
      `expected-old revision mismatch: expected ${expected}, observed ${state.revision}`,
    );
    error.code = "STALE_EXPECTED_OLD";
    throw error;
  }
}

export function candidateIdentity(input, state) {
  const body = {
    repository: state.repository,
    protectedBase: state.protectedBase,
    pullRequestNumber: positiveInteger(
      input.pullRequestNumber,
      "pull request number",
    ),
    sourceHeadSha: exactSha(input.sourceHeadSha, "source head SHA"),
    semanticSourceRoot: sha256Root(
      input.semanticSourceRoot,
      "semantic source root",
    ),
    assignmentRoot: sha256Root(input.assignmentRoot, "Assignment root"),
    initiativeRoot: sha256Root(input.initiativeRoot, "Initiative root"),
    deliveryClass: requiredText(input.deliveryClass, "delivery class"),
  };
  return { ...body, submissionId: contentRoot(body) };
}

export function priorityName(value) {
  const normalized = requiredText(value || "ordinary", "priority");
  if (!(normalized in PRIORITIES)) {
    throw new Error(
      `priority must be one of ${Object.keys(PRIORITIES).join(", ")}`,
    );
  }
  return normalized;
}

export function emergencyPriorityEvidence(value, input = {}) {
  if (value !== "emergency") return null;
  const reason = requiredText(
    input.priorityReason,
    "emergency priority reason",
  );
  if (!new Set(["security", "emergency"]).has(reason)) {
    throw new Error("emergency priority reason must be security or emergency");
  }
  return {
    reason,
    reviewedPolicyRoot: sha256Root(
      input.priorityPolicyRoot,
      "emergency reviewed policy root",
    ),
  };
}

export function candidateAgeSeconds(candidate, nowEpoch) {
  return Math.max(
    0,
    Math.floor((nowEpoch - Date.parse(candidate.retainedEnqueuedAt)) / 1000),
  );
}

export function rankQueuedCandidates(state, now) {
  assertDevDeliveryQueue(state);
  const observed = timestamp(now, "now");
  return state.candidates
    .filter((candidate) => candidate.state === "queued")
    .map((candidate) => {
      const age = candidateAgeSeconds(candidate, observed.epoch);
      const agingBoost = Math.floor(age / state.policy.agingQuantumSeconds);
      return {
        candidate,
        ageSeconds: age,
        effectivePriority: Math.min(
          2,
          PRIORITIES[candidate.priority] + agingBoost,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.effectivePriority - left.effectivePriority ||
        left.candidate.retainedEnqueuedAt.localeCompare(
          right.candidate.retainedEnqueuedAt,
        ) ||
        left.candidate.sequence - right.candidate.sequence ||
        left.candidate.submissionId.localeCompare(right.candidate.submissionId),
    );
}

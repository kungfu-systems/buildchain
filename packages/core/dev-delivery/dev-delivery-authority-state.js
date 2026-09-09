import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { validateDevDeliveryCandidateChain } from "./dev-delivery-candidate-identity.js";
import { normalizeDevDeliveryProviderAttempt } from "./dev-delivery-provider-attempt.js";

export const DEV_DELIVERY_AUTHORITY_CONTRACT =
  "kungfu-buildchain-dev-delivery-authority";
export const DEV_DELIVERY_AUTHORITY_MODE = "bounded-qualification-landing";
export const DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA =
  "kungfu.buildchain.dev-delivery-qualification-lease/v1";
export const DEV_DELIVERY_LANDING_WARRANT_SCHEMA =
  "kungfu.buildchain.dev-delivery-landing-warrant/v1";
export const DEV_DELIVERY_AUTHORITY_RECEIPT_SCHEMA =
  "kungfu.buildchain.dev-delivery-authority-receipt/v1";
export const DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA =
  "kungfu.buildchain.dev-delivery-merge-group-admission/v1";
export const DEV_DELIVERY_SCHEDULER_REASON_SCHEMA =
  "kungfu.buildchain.dev-delivery-scheduler-reason/v1";
export const DEV_DELIVERY_SCHEDULER_WAKE_SCHEMA =
  "kungfu.buildchain.dev-delivery-scheduler-wake/v1";

import {
  DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA,
  TERMINAL_STATES,
  normalizeDevDeliveryAuthorityCandidate as normalizeCandidate,
} from "./dev-delivery-authority-candidate.js";
export {
  DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA,
  TERMINAL_STATES,
  normalizeCandidate,
};

function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function stateBody(state) {
  const body = clone(state);
  delete body.stateRoot;
  return body;
}

export function withStateRoot(state) {
  const body = stateBody(state);
  return { ...body, stateRoot: devDeliveryContentRoot(body) };
}

function normalizePolicy(
  policy = {},
  { materializeSchedulerDefaults = false } = {},
) {
  const normalized = {
    maxQualificationLeases: positiveInteger(
      policy.maxQualificationLeases,
      "policy maxQualificationLeases",
      2,
    ),
    qualificationLeaseSeconds: positiveInteger(
      policy.qualificationLeaseSeconds,
      "policy qualificationLeaseSeconds",
      3600,
    ),
    landingLeaseSeconds: positiveInteger(
      policy.landingLeaseSeconds,
      "policy landingLeaseSeconds",
      900,
    ),
  };
  if (
    materializeSchedulerDefaults ||
    Object.hasOwn(policy, "maxLandingOvertakes")
  ) {
    normalized.maxLandingOvertakes = nonNegativeInteger(
      policy.maxLandingOvertakes,
      "policy maxLandingOvertakes",
      2,
    );
  }
  if (
    materializeSchedulerDefaults ||
    Object.hasOwn(policy, "maxQualificationAttempts")
  ) {
    normalized.maxQualificationAttempts = positiveInteger(
      policy.maxQualificationAttempts,
      "policy maxQualificationAttempts",
      3,
    );
  }
  return normalized;
}

export function schedulerPolicy(state) {
  return {
    maxLandingOvertakes: nonNegativeInteger(
      state.policy.maxLandingOvertakes,
      "policy maxLandingOvertakes",
      2,
    ),
    maxQualificationAttempts: positiveInteger(
      state.policy.maxQualificationAttempts,
      "policy maxQualificationAttempts",
      3,
    ),
  };
}

function normalizeQualificationLease(input) {
  if (input.schema !== DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA)
    throw new Error("qualification lease schema is unsupported");
  if (input.authority !== "qualification-only")
    throw new Error("qualification lease authority must be qualification-only");
  if (input.mergeGroupAdmission !== false)
    throw new Error("qualification lease cannot carry merge_group admission");
  const lease = {
    schema: input.schema,
    authority: input.authority,
    mergeGroupAdmission: false,
    candidateId: exactRoot(
      input.candidateId,
      "qualification lease candidateId",
    ),
    token: exactRoot(input.token, "qualification lease token"),
    generation: positiveInteger(
      input.generation,
      "qualification lease generation",
    ),
    issuedAt: timestamp(input.issuedAt, "qualification lease issuedAt"),
    expiresAt: timestamp(input.expiresAt, "qualification lease expiresAt"),
  };
  if (Object.hasOwn(input, "heartbeatAt"))
    lease.heartbeatAt = timestamp(
      input.heartbeatAt,
      "qualification lease heartbeatAt",
    );
  return lease;
}

function normalizeLandingWarrant(input) {
  if (input.schema !== DEV_DELIVERY_LANDING_WARRANT_SCHEMA)
    throw new Error("Landing Warrant schema is unsupported");
  if (input.authority !== "merge-group-admission")
    throw new Error("Landing Warrant authority must be merge-group-admission");
  if (input.mergeGroupAdmission !== true)
    throw new Error(
      "Landing Warrant must explicitly carry merge_group admission",
    );
  const warrant = {
    schema: input.schema,
    authority: input.authority,
    mergeGroupAdmission: true,
    candidateId: exactRoot(input.candidateId, "Landing Warrant candidateId"),
    token: exactRoot(input.token, "Landing Warrant token"),
    generation: positiveInteger(input.generation, "Landing Warrant generation"),
    issuedAt: timestamp(input.issuedAt, "Landing Warrant issuedAt"),
    expiresAt: timestamp(input.expiresAt, "Landing Warrant expiresAt"),
  };
  if (Object.hasOwn(input, "heartbeatAt"))
    warrant.heartbeatAt = timestamp(
      input.heartbeatAt,
      "Landing Warrant heartbeatAt",
    );
  if (Object.hasOwn(input, "mergeGroupHead")) {
    warrant.mergeGroupHead = exactSha(
      input.mergeGroupHead,
      "Landing Warrant mergeGroupHead",
    );
    warrant.mergeGroupAdmissionRoot = exactRoot(
      input.mergeGroupAdmissionRoot,
      "Landing Warrant mergeGroupAdmissionRoot",
    );
    warrant.expectedAdmissionStateRoot = exactRoot(
      input.expectedAdmissionStateRoot,
      "Landing Warrant expectedAdmissionStateRoot",
    );
    warrant.admittedAt = timestamp(
      input.admittedAt,
      "Landing Warrant admittedAt",
    );
    warrant.providerAttempt = normalizeDevDeliveryProviderAttempt(
      input.providerAttempt,
      {
        mergeGroupHead: warrant.mergeGroupHead,
      },
    );
  } else if (
    input.mergeGroupAdmissionRoot ||
    input.admittedAt ||
    input.expectedAdmissionStateRoot ||
    input.providerAttempt
  ) {
    throw new Error("Landing Warrant admission evidence is incomplete");
  }
  return warrant;
}

export function createDevDeliveryAuthorityState({
  repository: repositoryInput,
  protectedBase: protectedBaseInput,
  policy = {},
  now = new Date().toISOString(),
} = {}) {
  return withStateRoot({
    schemaVersion: 2,
    contract: DEV_DELIVERY_AUTHORITY_CONTRACT,
    authorityMode: DEV_DELIVERY_AUTHORITY_MODE,
    repository: repository(repositoryInput),
    protectedBase: protectedBase(protectedBaseInput),
    generation: 0,
    qualificationCounter: 0,
    landingCounter: 0,
    policy: normalizePolicy(policy, { materializeSchedulerDefaults: true }),
    qualificationLeases: [],
    landingWarrant: null,
    candidates: [],
    updatedAt: timestamp(now, "now"),
  });
}

function validateQualificationBindings(state) {
  if (state.qualificationLeases.length > state.policy.maxQualificationLeases)
    throw new Error("qualification lease bound exceeded");
  const qualificationIds = new Set();
  for (const lease of state.qualificationLeases) {
    if (qualificationIds.has(lease.candidateId))
      throw new Error("candidate cannot hold two qualification leases");
    qualificationIds.add(lease.candidateId);
    const candidate = state.candidates.find(
      (entry) => entry.candidateId === lease.candidateId,
    );
    if (!candidate || candidate.status !== "qualifying")
      throw new Error(
        "qualification lease must match one qualifying candidate",
      );
  }
  return qualificationIds;
}

function validateCandidateBindings(state, qualificationIds) {
  for (const candidate of state.candidates) {
    if (
      candidate.status === "qualifying" &&
      !qualificationIds.has(candidate.candidateId)
    )
      throw new Error(
        "qualifying candidate exists without a Qualification Lease",
      );
    if (
      candidate.status === "landing" &&
      state.landingWarrant?.candidateId !== candidate.candidateId
    )
      throw new Error(
        "landing candidate exists without the exclusive Landing Warrant",
      );
    if (
      ["qualified", "landing"].includes(candidate.status) &&
      !candidate.qualification
    )
      throw new Error(
        "qualified or landing candidate requires qualification evidence",
      );
    if (
      ["queued", "qualifying"].includes(candidate.status) &&
      candidate.qualification
    )
      throw new Error(
        "unqualified candidate cannot carry qualification evidence",
      );
    if (!TERMINAL_STATES.has(candidate.status) && candidate.terminal)
      throw new Error("active candidate cannot carry terminal evidence");
    if (
      TERMINAL_STATES.has(candidate.status) &&
      candidate.terminal?.outcome !== candidate.status
    )
      throw new Error(
        "terminal candidate status and evidence outcome must match",
      );
  }
  const active = state.candidates.filter((candidate) =>
    ["qualifying", "qualified", "landing"].includes(candidate.status),
  );
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < active.length;
      rightIndex += 1
    ) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      const leftDomains = left.qualificationDomains || [];
      const rightDomains = right.qualificationDomains || [];
      if (
        leftDomains.length === 0 ||
        rightDomains.length === 0 ||
        leftDomains.some((domain) => rightDomains.includes(domain))
      ) {
        throw new Error(
          "active candidates violate the rooted qualification-domain safety boundary",
        );
      }
    }
  }
  const { maxLandingOvertakes } = schedulerPolicy(state);
  if (
    state.candidates.some(
      (candidate) => (candidate.landingOvertakes || 0) > maxLandingOvertakes,
    )
  ) {
    throw new Error("candidate landing overtake bound exceeded");
  }
}

export function normalizeDevDeliveryAuthorityState(input, expected = {}) {
  const state = clone(input || {});
  if (
    state.contract !== DEV_DELIVERY_AUTHORITY_CONTRACT ||
    Number(state.schemaVersion) !== 2 ||
    state.authorityMode !== DEV_DELIVERY_AUTHORITY_MODE
  ) {
    throw new Error(
      `${DEV_DELIVERY_AUTHORITY_MODE} state must use ${DEV_DELIVERY_AUTHORITY_CONTRACT} schemaVersion 2`,
    );
  }
  state.repository = repository(state.repository);
  state.protectedBase = protectedBase(state.protectedBase);
  if (expected.repository && state.repository !== expected.repository)
    throw new Error("dev delivery authority repository mismatch");
  if (expected.protectedBase && state.protectedBase !== expected.protectedBase)
    throw new Error("dev delivery authority protectedBase mismatch");
  state.generation = nonNegativeInteger(
    state.generation,
    "authority generation",
  );
  state.qualificationCounter = nonNegativeInteger(
    state.qualificationCounter,
    "qualificationCounter",
  );
  state.landingCounter = nonNegativeInteger(
    state.landingCounter,
    "landingCounter",
  );
  state.policy = normalizePolicy(state.policy);
  if (Object.hasOwn(state, "migration"))
    throw new Error("authority state contains unsupported migration metadata");
  state.candidates = (state.candidates || []).map((candidate) =>
    normalizeCandidate(candidate, state),
  );
  validateDevDeliveryCandidateChain(state.candidates, TERMINAL_STATES);
  if (
    new Set(state.candidates.map((candidate) => candidate.candidateId)).size !==
    state.candidates.length
  )
    throw new Error("candidateId must be unique within authority state");
  state.qualificationLeases = (state.qualificationLeases || []).map(
    normalizeQualificationLease,
  );
  const qualificationIds = validateQualificationBindings(state);
  state.landingWarrant = state.landingWarrant
    ? normalizeLandingWarrant(state.landingWarrant)
    : null;
  if (state.landingWarrant) {
    if (qualificationIds.has(state.landingWarrant.candidateId))
      throw new Error(
        "candidate cannot hold qualification and Landing authority together",
      );
    const candidate = state.candidates.find(
      (entry) => entry.candidateId === state.landingWarrant.candidateId,
    );
    if (!candidate || candidate.status !== "landing")
      throw new Error(
        "the exclusive Landing Warrant must match one landing candidate",
      );
  }
  validateCandidateBindings(state, qualificationIds);
  state.updatedAt = timestamp(state.updatedAt, "authority updatedAt");
  const rooted = withStateRoot(state);
  if (input.stateRoot && input.stateRoot !== rooted.stateRoot)
    throw new Error("dev delivery authority stateRoot drift");
  return rooted;
}

export function transition(stateInput, mutate, nowInput) {
  const before = normalizeDevDeliveryAuthorityState(stateInput);
  const state = clone(before);
  const now = timestamp(nowInput, "now");
  const result = mutate(state, before, now);
  if (result?.mutated === false)
    return {
      before,
      after: before,
      expectedOldStateRoot: before.stateRoot,
      result,
    };
  state.generation += 1;
  state.updatedAt = now;
  const after = withStateRoot(state);
  return { before, after, expectedOldStateRoot: before.stateRoot, result };
}

export function receipt(transaction, action, details = {}) {
  const value = {
    schema: DEV_DELIVERY_AUTHORITY_RECEIPT_SCHEMA,
    action,
    ...details,
    expectedOldStateRoot: transaction.expectedOldStateRoot,
    nextStateRoot: transaction.after.stateRoot,
  };
  return {
    state: transaction.after,
    receipt: value,
    receiptRoot: devDeliveryContentRoot(value),
  };
}

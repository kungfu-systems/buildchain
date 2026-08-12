import { devDeliveryClone as clone, devDeliveryContentRoot, devDeliveryExactRoot as exactRoot, devDeliveryExactSha as exactSha, devDeliveryPositiveInteger as positiveInteger, devDeliveryProtectedBase as protectedBase, devDeliveryRepository as repository, devDeliveryText as text, devDeliveryTimestamp as timestamp } from "./dev-delivery-common.js";
import { createDevDeliveryCandidateIdentity, validateDevDeliveryCandidateChain } from "./dev-delivery-candidate-identity.js";
import { normalizeDevDeliveryQueue } from "./dev-delivery-warrant.js";

export const DEV_DELIVERY_AUTHORITY_CONTRACT = "kungfu-buildchain-dev-delivery-authority";
export const DEV_DELIVERY_AUTHORITY_MODE = "bounded-qualification-landing";
export const DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA = "kungfu.buildchain.dev-delivery-qualification-lease/v1";
export const DEV_DELIVERY_LANDING_WARRANT_SCHEMA = "kungfu.buildchain.dev-delivery-landing-warrant/v1";
export const DEV_DELIVERY_AUTHORITY_RECEIPT_SCHEMA = "kungfu.buildchain.dev-delivery-authority-receipt/v1";
export const DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA = "kungfu.buildchain.dev-delivery-merge-group-admission/v1";
export const DEV_DELIVERY_AUTHORITY_MIGRATION_SCHEMA = "kungfu.buildchain.dev-delivery-authority-migration/v1";
export const DEV_DELIVERY_SCHEDULER_REASON_SCHEMA = "kungfu.buildchain.dev-delivery-scheduler-reason/v1";
export const DEV_DELIVERY_SCHEDULER_WAKE_SCHEMA = "kungfu.buildchain.dev-delivery-scheduler-wake/v1";

const TERMINAL_STATES = new Set(["merged", "terminal-failure", "dequeued", "cancelled"]);
const DELIVERY_CLASSES = new Set(["non-native-fast", "native-proof-required", "cross-platform", "release"]);

function nonNegativeInteger(value, label, fallback = 0) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function stateBody(state) {
  const body = clone(state);
  delete body.stateRoot;
  return body;
}

function withStateRoot(state) {
  const body = stateBody(state);
  return { ...body, stateRoot: devDeliveryContentRoot(body) };
}

function normalizePolicy(policy = {}, { materializeSchedulerDefaults = false } = {}) {
  const normalized = {
    maxQualificationLeases: positiveInteger(policy.maxQualificationLeases, "policy maxQualificationLeases", 2),
    qualificationLeaseSeconds: positiveInteger(policy.qualificationLeaseSeconds, "policy qualificationLeaseSeconds", 3600),
    landingLeaseSeconds: positiveInteger(policy.landingLeaseSeconds, "policy landingLeaseSeconds", 900),
  };
  if (materializeSchedulerDefaults || Object.hasOwn(policy, "maxLandingOvertakes")) {
    normalized.maxLandingOvertakes = nonNegativeInteger(policy.maxLandingOvertakes, "policy maxLandingOvertakes", 2);
  }
  if (materializeSchedulerDefaults || Object.hasOwn(policy, "maxQualificationAttempts")) {
    normalized.maxQualificationAttempts = positiveInteger(policy.maxQualificationAttempts, "policy maxQualificationAttempts", 3);
  }
  return normalized;
}

function schedulerPolicy(state) {
  return {
    maxLandingOvertakes: nonNegativeInteger(state.policy.maxLandingOvertakes, "policy maxLandingOvertakes", 2),
    maxQualificationAttempts: positiveInteger(state.policy.maxQualificationAttempts, "policy maxQualificationAttempts", 3),
  };
}

function normalizedDomains(input = []) {
  if (!Array.isArray(input)) throw new Error("qualificationDomains must be an array of rooted safety domains");
  return [...new Set(input.map((value) => exactRoot(value, "qualification domain")))].sort();
}

function candidateIdentity(input, expected) {
  return createDevDeliveryCandidateIdentity(input, expected, (value) => {
    const normalized = text(value);
    if (!DELIVERY_CLASSES.has(normalized)) throw new Error(`unsupported deliveryClass ${normalized}`);
    return normalized;
  });
}

function normalizeCandidate(input, expected) {
  const identity = candidateIdentity(input, expected);
  if (input.candidateId && input.candidateId !== identity.candidateId) throw new Error(`candidateId mismatch for PR #${identity.pullRequestNumber}`);
  const status = text(input.status || "queued");
  if (!["queued", "qualifying", "qualified", "landing", ...TERMINAL_STATES].includes(status)) throw new Error(`unsupported candidate status ${status || "<empty>"}`);
  const candidate = {
    ...identity,
    sourceHead: exactSha(input.sourceHead, "sourceHead"),
    sourcePatchRoot: exactRoot(input.sourcePatchRoot, "sourcePatchRoot"),
    sourceProofRoot: exactRoot(input.sourceProofRoot, "sourceProofRoot"),
    planRoot: exactRoot(input.planRoot, "planRoot"),
    closureRoot: exactRoot(input.closureRoot, "closureRoot"),
    dependencyRoot: exactRoot(input.dependencyRoot, "dependencyRoot"),
    toolchainRoot: exactRoot(input.toolchainRoot, "toolchainRoot"),
    enqueuedAt: timestamp(input.enqueuedAt, "candidate enqueuedAt"),
    updatedAt: timestamp(input.updatedAt || input.enqueuedAt, "candidate updatedAt"),
    status,
    qualification: input.qualification
      ? {
          evidenceRoot: exactRoot(input.qualification.evidenceRoot, "qualification evidenceRoot"),
          qualifiedAt: timestamp(input.qualification.qualifiedAt, "qualification qualifiedAt"),
        }
      : null,
    terminal: input.terminal
      ? {
          outcome: text(input.terminal.outcome),
          evidenceRoot: exactRoot(input.terminal.evidenceRoot, "terminal evidenceRoot"),
          reason: text(input.terminal.reason),
          settledAt: timestamp(input.terminal.settledAt, "terminal settledAt"),
        }
      : null,
  };
  if (Object.hasOwn(input, "qualificationDomains")) candidate.qualificationDomains = normalizedDomains(input.qualificationDomains);
  if (Object.hasOwn(input, "qualificationAttempts")) candidate.qualificationAttempts = nonNegativeInteger(input.qualificationAttempts, "candidate qualificationAttempts");
  if (Object.hasOwn(input, "landingOvertakes")) candidate.landingOvertakes = nonNegativeInteger(input.landingOvertakes, "candidate landingOvertakes");
  return candidate;
}

function normalizeQualificationLease(input) {
  if (input.schema !== DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA) throw new Error("qualification lease schema is unsupported");
  if (input.authority !== "qualification-only") throw new Error("qualification lease authority must be qualification-only");
  if (input.mergeGroupAdmission !== false) throw new Error("qualification lease cannot carry merge_group admission");
  const lease = {
    schema: input.schema,
    authority: input.authority,
    mergeGroupAdmission: false,
    candidateId: exactRoot(input.candidateId, "qualification lease candidateId"),
    token: exactRoot(input.token, "qualification lease token"),
    generation: positiveInteger(input.generation, "qualification lease generation"),
    issuedAt: timestamp(input.issuedAt, "qualification lease issuedAt"),
    expiresAt: timestamp(input.expiresAt, "qualification lease expiresAt"),
  };
  if (Object.hasOwn(input, "heartbeatAt")) lease.heartbeatAt = timestamp(input.heartbeatAt, "qualification lease heartbeatAt");
  return lease;
}

function normalizeLandingWarrant(input) {
  if (input.schema !== DEV_DELIVERY_LANDING_WARRANT_SCHEMA) throw new Error("Landing Warrant schema is unsupported");
  if (input.authority !== "merge-group-admission") throw new Error("Landing Warrant authority must be merge-group-admission");
  if (input.mergeGroupAdmission !== true) throw new Error("Landing Warrant must explicitly carry merge_group admission");
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
  if (Object.hasOwn(input, "heartbeatAt")) warrant.heartbeatAt = timestamp(input.heartbeatAt, "Landing Warrant heartbeatAt");
  return warrant;
}

export function createDevDeliveryAuthorityState({ repository: repositoryInput, protectedBase: protectedBaseInput, policy = {}, now = new Date().toISOString() } = {}) {
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
    migration: null,
    updatedAt: timestamp(now, "now"),
  });
}

function validateQualificationBindings(state) {
  if (state.qualificationLeases.length > state.policy.maxQualificationLeases) throw new Error("qualification lease bound exceeded");
  const qualificationIds = new Set();
  for (const lease of state.qualificationLeases) {
    if (qualificationIds.has(lease.candidateId)) throw new Error("candidate cannot hold two qualification leases");
    qualificationIds.add(lease.candidateId);
    const candidate = state.candidates.find((entry) => entry.candidateId === lease.candidateId);
    if (!candidate || candidate.status !== "qualifying") throw new Error("qualification lease must match one qualifying candidate");
  }
  return qualificationIds;
}

function validateCandidateBindings(state, qualificationIds) {
  for (const candidate of state.candidates) {
    if (candidate.status === "qualifying" && !qualificationIds.has(candidate.candidateId)) throw new Error("qualifying candidate exists without a Qualification Lease");
    if (candidate.status === "landing" && state.landingWarrant?.candidateId !== candidate.candidateId) throw new Error("landing candidate exists without the exclusive Landing Warrant");
    if (["qualified", "landing"].includes(candidate.status) && !candidate.qualification) throw new Error("qualified or landing candidate requires qualification evidence");
    if (["queued", "qualifying"].includes(candidate.status) && candidate.qualification) throw new Error("unqualified candidate cannot carry qualification evidence");
    if (!TERMINAL_STATES.has(candidate.status) && candidate.terminal) throw new Error("active candidate cannot carry terminal evidence");
    if (TERMINAL_STATES.has(candidate.status) && candidate.terminal?.outcome !== candidate.status) throw new Error("terminal candidate status and evidence outcome must match");
  }
  const active = state.candidates.filter((candidate) => ["qualifying", "qualified", "landing"].includes(candidate.status));
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const left = active[leftIndex];
      const right = active[rightIndex];
      const leftDomains = left.qualificationDomains || [];
      const rightDomains = right.qualificationDomains || [];
      if (leftDomains.length === 0 || rightDomains.length === 0 || leftDomains.some((domain) => rightDomains.includes(domain))) {
        throw new Error("active candidates violate the rooted qualification-domain safety boundary");
      }
    }
  }
  const { maxLandingOvertakes } = schedulerPolicy(state);
  if (state.candidates.some((candidate) => (candidate.landingOvertakes || 0) > maxLandingOvertakes)) {
    throw new Error("candidate landing overtake bound exceeded");
  }
}

export function normalizeDevDeliveryAuthorityState(input, expected = {}) {
  const state = clone(input || {});
  if (state.contract !== DEV_DELIVERY_AUTHORITY_CONTRACT || Number(state.schemaVersion) !== 2 || state.authorityMode !== DEV_DELIVERY_AUTHORITY_MODE) {
    throw new Error(`${DEV_DELIVERY_AUTHORITY_MODE} state must use ${DEV_DELIVERY_AUTHORITY_CONTRACT} schemaVersion 2`);
  }
  state.repository = repository(state.repository);
  state.protectedBase = protectedBase(state.protectedBase);
  if (expected.repository && state.repository !== expected.repository) throw new Error("dev delivery authority repository mismatch");
  if (expected.protectedBase && state.protectedBase !== expected.protectedBase) throw new Error("dev delivery authority protectedBase mismatch");
  state.generation = nonNegativeInteger(state.generation, "authority generation");
  state.qualificationCounter = nonNegativeInteger(state.qualificationCounter, "qualificationCounter");
  state.landingCounter = nonNegativeInteger(state.landingCounter, "landingCounter");
  state.policy = normalizePolicy(state.policy);
  state.migration = state.migration
    ? {
        schema: text(state.migration.schema),
        legacyContract: text(state.migration.legacyContract),
        legacyStateRoot: exactRoot(state.migration.legacyStateRoot, "migration legacyStateRoot"),
        migratedAt: timestamp(state.migration.migratedAt, "migration migratedAt"),
      }
    : null;
  if (state.migration && state.migration.schema !== DEV_DELIVERY_AUTHORITY_MIGRATION_SCHEMA) throw new Error("authority migration schema is unsupported");
  state.candidates = (state.candidates || []).map((candidate) => normalizeCandidate(candidate, state));
  validateDevDeliveryCandidateChain(state.candidates, TERMINAL_STATES);
  if (new Set(state.candidates.map((candidate) => candidate.candidateId)).size !== state.candidates.length) throw new Error("candidateId must be unique within authority state");
  state.qualificationLeases = (state.qualificationLeases || []).map(normalizeQualificationLease);
  const qualificationIds = validateQualificationBindings(state);
  state.landingWarrant = state.landingWarrant ? normalizeLandingWarrant(state.landingWarrant) : null;
  if (state.landingWarrant) {
    if (qualificationIds.has(state.landingWarrant.candidateId)) throw new Error("candidate cannot hold qualification and Landing authority together");
    const candidate = state.candidates.find((entry) => entry.candidateId === state.landingWarrant.candidateId);
    if (!candidate || candidate.status !== "landing") throw new Error("the exclusive Landing Warrant must match one landing candidate");
  }
  validateCandidateBindings(state, qualificationIds);
  state.updatedAt = timestamp(state.updatedAt, "authority updatedAt");
  const rooted = withStateRoot(state);
  if (input.stateRoot && input.stateRoot !== rooted.stateRoot) throw new Error("dev delivery authority stateRoot drift");
  return rooted;
}

function migratedCandidate(candidate, state) {
  return normalizeCandidate(
    {
      ...candidate,
      status: TERMINAL_STATES.has(candidate.status) ? candidate.status : "queued",
      qualification: null,
      terminal: candidate.terminal
        ? {
            outcome: candidate.terminal.outcome,
            evidenceRoot: candidate.terminal.evidenceRoot,
            reason: candidate.terminal.reason,
            settledAt: candidate.terminal.closedAt,
          }
        : null,
      qualificationDomains: [],
      qualificationAttempts: candidate.attempts || 0,
      landingOvertakes: 0,
    },
    state,
  );
}

export function migrateDevDeliveryAuthorityState(queueInput, { policy = {}, now = new Date().toISOString() } = {}) {
  const legacy = normalizeDevDeliveryQueue(queueInput);
  const state = createDevDeliveryAuthorityState({
    repository: legacy.repository,
    protectedBase: legacy.protectedBase,
    policy,
    now,
  });
  state.candidates = legacy.candidates.map((candidate) => migratedCandidate(candidate, state));
  state.generation = legacy.generation;
  state.qualificationCounter = legacy.fencingCounter;
  state.landingCounter = legacy.fencingCounter;
  state.migration = {
    schema: DEV_DELIVERY_AUTHORITY_MIGRATION_SCHEMA,
    legacyContract: legacy.contract,
    legacyStateRoot: legacy.stateRoot,
    migratedAt: timestamp(now, "now"),
  };
  if (legacy.activeWarrant) {
    const warrant = legacy.activeWarrant;
    state.qualificationCounter = Math.max(state.qualificationCounter, warrant.generation);
    state.landingCounter = Math.max(state.landingCounter, warrant.generation);
    const candidate = state.candidates.find((entry) => entry.candidateId === warrant.candidateId);
    if ((warrant.phase || "qualified") === "qualified") {
      candidate.status = "landing";
      candidate.qualification = {
        evidenceRoot: exactRoot(warrant.nativeProofRoot, "Warrant nativeProofRoot"),
        qualifiedAt: timestamp(warrant.qualifiedAt, "Warrant qualifiedAt"),
      };
      state.landingWarrant = {
        schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
        authority: "merge-group-admission",
        mergeGroupAdmission: true,
        candidateId: warrant.candidateId,
        token: warrant.fencingToken,
        generation: warrant.generation,
        issuedAt: warrant.issuedAt,
        expiresAt: warrant.expiresAt,
      };
    } else {
      candidate.status = "qualifying";
      state.qualificationLeases = [
        {
          schema: DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
          authority: "qualification-only",
          mergeGroupAdmission: false,
          candidateId: warrant.candidateId,
          token: warrant.fencingToken,
          generation: warrant.generation,
          issuedAt: warrant.issuedAt,
          expiresAt: warrant.expiresAt,
        },
      ];
    }
  }
  const migrated = normalizeDevDeliveryAuthorityState(withStateRoot(state));
  const receipt = {
    schema: DEV_DELIVERY_AUTHORITY_MIGRATION_SCHEMA,
    legacyStateRoot: legacy.stateRoot,
    nextStateRoot: migrated.stateRoot,
    activeAuthority: migrated.landingWarrant ? "landing-warrant" : migrated.qualificationLeases.length ? "qualification-lease" : "none",
  };
  return {
    state: migrated,
    receipt,
    receiptRoot: devDeliveryContentRoot(receipt),
  };
}

function transition(stateInput, mutate, nowInput) {
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

function receipt(transaction, action, details = {}) {
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

export function submitDevDeliveryAuthorityCandidate(stateInput, input, { now = new Date().toISOString() } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state) => {
      const candidate = normalizeCandidate(
        {
          ...input,
          status: "queued",
          enqueuedAt: input.enqueuedAt || currentTime,
          updatedAt: currentTime,
          qualification: null,
          terminal: null,
          qualificationDomains: input.qualificationDomains || [],
          qualificationAttempts: 0,
          landingOvertakes: 0,
        },
        state,
      );
      const conflicting = state.candidates.find((entry) => entry.pullRequestNumber === candidate.pullRequestNumber && !TERMINAL_STATES.has(entry.status));
      if (conflicting) {
        const exactFields = ["candidateId", "sourceHead", "sourcePatchRoot", "sourceProofRoot", "planRoot", "closureRoot", "dependencyRoot", "toolchainRoot"];
        const same = exactFields.every((field) => conflicting[field] === candidate[field]);
        const sameDomains = JSON.stringify(conflicting.qualificationDomains || []) === JSON.stringify(candidate.qualificationDomains || []);
        if (!same || !sameDomains) throw new Error(`PR #${candidate.pullRequestNumber} already has different active authority state`);
        return {
          candidate: conflicting,
          action: "duplicate-noop",
          mutated: false,
        };
      }
      state.candidates.push(candidate);
      return { candidate, action: "submitted" };
    },
    currentTime,
  );
  return receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.candidate.candidateId,
    pullRequestNumber: transaction.result.candidate.pullRequestNumber,
    sourceHead: transaction.result.candidate.sourceHead,
    authorityMode: DEV_DELIVERY_AUTHORITY_MODE,
    nextAction: "Acquire a bounded Qualification Lease.",
  });
}

function authorityToken(schema, state, candidate, generation, issuedAt) {
  return devDeliveryContentRoot({
    schema,
    repository: state.repository,
    protectedBase: state.protectedBase,
    candidateId: candidate.candidateId,
    generation,
    expectedOldStateRoot: state.stateRoot,
    issuedAt,
  });
}

function rootedSchedulerReason(state, code, candidate, conflicts = [], message = "") {
  const body = {
    schema: DEV_DELIVERY_SCHEDULER_REASON_SCHEMA,
    code,
    candidateId: candidate?.candidateId || null,
    conflictingCandidateIds: [...new Set(conflicts.map((entry) => entry.candidateId))].sort(),
    stateRoot: state.stateRoot,
    message,
  };
  return { ...body, reasonRoot: devDeliveryContentRoot(body) };
}

function activeSafetyCandidates(state, candidateId = "") {
  return state.candidates.filter((entry) => entry.candidateId !== candidateId && ["qualifying", "qualified", "landing"].includes(entry.status));
}

function qualificationEligibility(state, candidate) {
  const active = activeSafetyCandidates(state, candidate.candidateId);
  if (active.length === 0) return { eligible: true, reason: null };
  const domains = candidate.qualificationDomains || [];
  if (domains.length === 0) {
    return {
      eligible: false,
      reason: rootedSchedulerReason(state, "unknown-qualification-domain", candidate, active, "A candidate without rooted qualification domains cannot bypass an active safety boundary."),
    };
  }
  const unknown = active.filter((entry) => (entry.qualificationDomains || []).length === 0);
  if (unknown.length > 0) {
    return {
      eligible: false,
      reason: rootedSchedulerReason(state, "active-unknown-qualification-domain", candidate, unknown, "An active candidate with unknown qualification domains is a global safety boundary."),
    };
  }
  const domainSet = new Set(domains);
  const overlapping = active.filter((entry) => entry.qualificationDomains.some((domain) => domainSet.has(domain)));
  if (overlapping.length > 0) {
    return {
      eligible: false,
      reason: rootedSchedulerReason(state, "overlapping-qualification-domain", candidate, overlapping, "Overlapping rooted qualification domains must be serialized."),
    };
  }
  return { eligible: true, reason: null };
}

function queuedByAge(state) {
  return state.candidates.filter((candidate) => candidate.status === "queued").sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.candidateId.localeCompare(right.candidateId));
}

function landingEligibility(state, candidate) {
  const { maxLandingOvertakes } = schedulerPolicy(state);
  const older = state.candidates.filter((entry) => !TERMINAL_STATES.has(entry.status) && entry.candidateId !== candidate.candidateId && (entry.enqueuedAt < candidate.enqueuedAt || (entry.enqueuedAt === candidate.enqueuedAt && entry.candidateId < candidate.candidateId)));
  const exhausted = older.filter((entry) => (entry.landingOvertakes || 0) >= maxLandingOvertakes);
  if (exhausted.length === 0) return { eligible: true, older, reason: null };
  return {
    eligible: false,
    older,
    reason: rootedSchedulerReason(state, "landing-overtake-bound-reached", candidate, exhausted, `A predecessor has exhausted the configured ${maxLandingOvertakes}-landing overtake budget.`),
  };
}

function schedulerWake(state) {
  const available = Math.max(0, state.policy.maxQualificationLeases - state.qualificationLeases.length);
  const simulated = clone(state);
  const qualificationCandidateIds = [];
  const blockedReasons = [];
  for (const candidate of queuedByAge(state)) {
    if (qualificationCandidateIds.length >= available) break;
    const eligibility = qualificationEligibility(simulated, candidate);
    if (!eligibility.eligible) {
      blockedReasons.push(eligibility.reason);
      continue;
    }
    qualificationCandidateIds.push(candidate.candidateId);
    simulated.candidates.find((entry) => entry.candidateId === candidate.candidateId).status = "qualifying";
  }
  let landingCandidateId = null;
  let landingBlockedReason = null;
  if (!state.landingWarrant) {
    const qualified = state.candidates.filter((candidate) => candidate.status === "qualified").sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.candidateId.localeCompare(right.candidateId));
    for (const candidate of qualified) {
      const eligibility = landingEligibility(state, candidate);
      if (eligibility.eligible) {
        landingCandidateId = candidate.candidateId;
        break;
      }
      landingBlockedReason ||= eligibility.reason;
    }
  }
  const body = {
    schema: DEV_DELIVERY_SCHEDULER_WAKE_SCHEMA,
    stateRoot: state.stateRoot,
    qualificationCandidateIds,
    landingCandidateId,
    blockedReasonRoots: blockedReasons.map((reason) => reason.reasonRoot),
    landingBlockedReasonRoot: landingBlockedReason?.reasonRoot || null,
  };
  return {
    ...body,
    wakeRoot: devDeliveryContentRoot(body),
    blockedReasons,
    landingBlockedReason,
  };
}

function recoverExpiredQualificationLeases(state, now) {
  const expired = state.qualificationLeases.filter((lease) => Date.parse(lease.expiresAt) <= Date.parse(now));
  if (expired.length === 0) return [];
  const expiredIds = new Set(expired.map((lease) => lease.candidateId));
  state.qualificationLeases = state.qualificationLeases.filter((lease) => !expiredIds.has(lease.candidateId));
  const { maxQualificationAttempts } = schedulerPolicy(state);
  for (const candidate of state.candidates) {
    if (expiredIds.has(candidate.candidateId)) {
      if ((candidate.qualificationAttempts || 0) >= maxQualificationAttempts) {
        const reason = rootedSchedulerReason(state, "qualification-heartbeat-expired-terminal", candidate, [], `Qualification heartbeat expired after ${candidate.qualificationAttempts} attempts.`);
        candidate.status = "terminal-failure";
        candidate.terminal = {
          outcome: "terminal-failure",
          evidenceRoot: reason.reasonRoot,
          reason: reason.code,
          settledAt: now,
        };
      } else {
        candidate.status = "queued";
      }
      candidate.updatedAt = now;
    }
  }
  return expired;
}

export function acquireDevDeliveryQualificationLease(stateInput, { now = new Date().toISOString(), leaseSeconds } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const recovered = recoverExpiredQualificationLeases(state, currentTime);
      if (state.qualificationLeases.length >= state.policy.maxQualificationLeases)
        return {
          lease: null,
          recovered,
          action: "qualification-bound-full-noop",
          mutated: recovered.length > 0,
        };
      const blockedReasons = [];
      let candidate = null;
      for (const queued of queuedByAge(state)) {
        const eligibility = qualificationEligibility(state, queued);
        if (eligibility.eligible) {
          candidate = queued;
          break;
        }
        blockedReasons.push(eligibility.reason);
      }
      if (!candidate) {
        return {
          lease: null,
          recovered,
          blockedReasons,
          action: blockedReasons.length > 0 ? "qualification-safety-boundary-noop" : "no-queued-candidate-noop",
          mutated: recovered.length > 0,
        };
      }
      state.qualificationCounter += 1;
      candidate.qualificationAttempts = (candidate.qualificationAttempts || 0) + 1;
      const duration = positiveInteger(leaseSeconds, "qualification leaseSeconds", state.policy.qualificationLeaseSeconds);
      const lease = {
        schema: DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
        authority: "qualification-only",
        mergeGroupAdmission: false,
        candidateId: candidate.candidateId,
        generation: state.qualificationCounter,
        issuedAt: currentTime,
        heartbeatAt: currentTime,
        expiresAt: new Date(Date.parse(currentTime) + duration * 1000).toISOString(),
        token: "",
      };
      lease.token = authorityToken(lease.schema, before, candidate, lease.generation, currentTime);
      state.qualificationLeases.push(lease);
      candidate.status = "qualifying";
      candidate.updatedAt = currentTime;
      return {
        lease,
        recovered,
        candidate,
        blockedReasons,
        action: "qualification-lease-acquired",
      };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.candidate?.candidateId || null,
    authority: transaction.result.lease?.authority || null,
    mergeGroupAdmission: false,
    recoveredLeaseCount: transaction.result.recovered.length,
    blockedReasons: transaction.result.blockedReasons || [],
    nextAction: transaction.result.lease ? "Run qualification only; this lease cannot admit merge_group." : "Wait for a Qualification Lease slot or queued candidate.",
  });
  return {
    ...changed,
    lease: transaction.result.lease,
    wake: schedulerWake(changed.state),
  };
}

export function heartbeatDevDeliveryQualificationLease(stateInput, leaseInput, { now = new Date().toISOString(), leaseSeconds } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const lease = assertQualificationLease(before, leaseInput, currentTime);
      if (lease.heartbeatAt === currentTime)
        return {
          lease,
          action: "duplicate-qualification-heartbeat-noop",
          mutated: false,
        };
      const active = state.qualificationLeases.find((entry) => entry.candidateId === lease.candidateId);
      const duration = positiveInteger(leaseSeconds, "qualification leaseSeconds", state.policy.qualificationLeaseSeconds);
      active.heartbeatAt = currentTime;
      active.expiresAt = new Date(Date.parse(currentTime) + duration * 1000).toISOString();
      return { lease: active, action: "qualification-heartbeat" };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.lease.candidateId,
    authorityGeneration: transaction.result.lease.generation,
    expiresAt: transaction.result.lease.expiresAt,
    nextAction: "Continue qualification while the fenced lease remains current.",
  });
  return {
    ...changed,
    lease: transaction.result.lease,
    wake: schedulerWake(changed.state),
  };
}

function assertQualificationLease(state, input, now) {
  const token = exactRoot(input?.token, "qualification lease token");
  const generation = positiveInteger(input?.generation, "qualification lease generation");
  const candidateId = exactRoot(input?.candidateId, "candidateId");
  const lease = state.qualificationLeases.find((entry) => entry.candidateId === candidateId);
  if (!lease || lease.token !== token) throw new Error("stale qualification lease token");
  if (lease.generation !== generation) throw new Error("stale qualification lease generation");
  if (Date.parse(lease.expiresAt) <= Date.parse(now)) throw new Error("Qualification Lease expired");
  return lease;
}

export function completeDevDeliveryQualification(stateInput, leaseInput, { evidenceRoot, now = new Date().toISOString() } = {}) {
  const currentTime = timestamp(now, "now");
  const evidence = exactRoot(evidenceRoot, "qualification evidenceRoot");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const lease = assertQualificationLease(before, leaseInput, currentTime);
      const candidate = state.candidates.find((entry) => entry.candidateId === lease.candidateId);
      state.qualificationLeases = state.qualificationLeases.filter((entry) => entry.candidateId !== lease.candidateId);
      candidate.status = "qualified";
      candidate.qualification = {
        evidenceRoot: evidence,
        qualifiedAt: currentTime,
      };
      candidate.updatedAt = currentTime;
      return { lease, candidate };
    },
    currentTime,
  );
  const changed = receipt(transaction, "qualification-completed-lease-released", {
    candidateId: transaction.result.candidate.candidateId,
    qualificationEvidenceRoot: evidence,
    releasedQualificationToken: transaction.result.lease.token,
    mergeGroupAdmission: false,
    nextAction: "Wait for the single exclusive Landing Warrant.",
  });
  return { ...changed, wake: schedulerWake(changed.state) };
}

function recoverExpiredLandingWarrant(state, now) {
  if (!state.landingWarrant || Date.parse(state.landingWarrant.expiresAt) > Date.parse(now)) return null;
  const expired = clone(state.landingWarrant);
  const candidate = state.candidates.find((entry) => entry.candidateId === expired.candidateId);
  candidate.status = "qualified";
  candidate.updatedAt = now;
  state.landingWarrant = null;
  return expired;
}

export function recoverDevDeliveryAuthority(stateInput, { now = new Date().toISOString() } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state) => {
      const qualificationLeases = recoverExpiredQualificationLeases(state, currentTime);
      const landingWarrant = recoverExpiredLandingWarrant(state, currentTime);
      return {
        qualificationLeases,
        landingWarrant,
        action: qualificationLeases.length > 0 || landingWarrant ? "expired-authority-recovered" : "no-expired-authority-noop",
        mutated: qualificationLeases.length > 0 || Boolean(landingWarrant),
      };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    recoveredQualificationTokens: transaction.result.qualificationLeases.map((lease) => lease.token),
    recoveredLandingToken: transaction.result.landingWarrant?.token || null,
    nextAction: "Wake the next eligible qualification or landing candidate.",
  });
  return { ...changed, wake: schedulerWake(changed.state) };
}

export function acquireDevDeliveryLandingWarrant(stateInput, { now = new Date().toISOString(), leaseSeconds } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const recovered = recoverExpiredLandingWarrant(state, currentTime);
      if (state.landingWarrant) {
        return {
          warrant: state.landingWarrant,
          recovered,
          action: "exclusive-landing-warrant-retained-noop",
          mutated: Boolean(recovered),
        };
      }
      const qualified = state.candidates.filter((entry) => entry.status === "qualified").sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.candidateId.localeCompare(right.candidateId));
      let candidate = null;
      let blockedReason = null;
      let older = [];
      for (const entry of qualified) {
        const eligibility = landingEligibility(state, entry);
        if (eligibility.eligible) {
          candidate = entry;
          older = eligibility.older;
          break;
        }
        blockedReason ||= eligibility.reason;
      }
      if (!candidate) {
        return {
          warrant: null,
          recovered,
          blockedReason,
          action: blockedReason ? "landing-overtake-bound-noop" : "no-qualified-candidate-noop",
          mutated: Boolean(recovered),
        };
      }
      state.landingCounter += 1;
      const duration = positiveInteger(leaseSeconds, "landing leaseSeconds", state.policy.landingLeaseSeconds);
      const warrant = {
        schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
        authority: "merge-group-admission",
        mergeGroupAdmission: true,
        candidateId: candidate.candidateId,
        generation: state.landingCounter,
        issuedAt: currentTime,
        heartbeatAt: currentTime,
        expiresAt: new Date(Date.parse(currentTime) + duration * 1000).toISOString(),
        token: "",
      };
      warrant.token = authorityToken(warrant.schema, before, candidate, warrant.generation, currentTime);
      state.landingWarrant = warrant;
      candidate.status = "landing";
      candidate.updatedAt = currentTime;
      for (const predecessor of older) predecessor.landingOvertakes = (predecessor.landingOvertakes || 0) + 1;
      return {
        warrant,
        recovered,
        candidate,
        blockedReason: null,
        action: "landing-warrant-acquired",
      };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.warrant?.candidateId || null,
    authority: transaction.result.warrant?.authority || null,
    mergeGroupAdmission: Boolean(transaction.result.warrant),
    recoveredLandingWarrant: Boolean(transaction.result.recovered),
    blockedReason: transaction.result.blockedReason || null,
    nextAction: transaction.result.warrant ? "Admit only this exact candidate to merge_group." : "Wait for a qualified candidate.",
  });
  return {
    ...changed,
    warrant: transaction.result.warrant,
    wake: schedulerWake(changed.state),
  };
}

export function heartbeatDevDeliveryLandingWarrant(stateInput, warrantInput, { now = new Date().toISOString(), leaseSeconds } = {}) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const warrant = assertLandingWarrant(before, warrantInput, currentTime);
      if (warrant.heartbeatAt === currentTime)
        return {
          warrant,
          action: "duplicate-landing-heartbeat-noop",
          mutated: false,
        };
      const duration = positiveInteger(leaseSeconds, "landing leaseSeconds", state.policy.landingLeaseSeconds);
      state.landingWarrant.heartbeatAt = currentTime;
      state.landingWarrant.expiresAt = new Date(Date.parse(currentTime) + duration * 1000).toISOString();
      return { warrant: state.landingWarrant, action: "landing-heartbeat" };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.warrant.candidateId,
    authorityGeneration: transaction.result.warrant.generation,
    expiresAt: transaction.result.warrant.expiresAt,
    nextAction: "Continue the exact landing attempt while the Warrant remains current.",
  });
  return {
    ...changed,
    warrant: transaction.result.warrant,
    wake: schedulerWake(changed.state),
  };
}

function assertLandingWarrant(state, input, now, { allowExpired = false } = {}) {
  if (text(input?.schema) === DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA) throw new Error("Qualification Lease cannot admit merge_group");
  if (!state.landingWarrant) throw new Error("no active Landing Warrant");
  const token = exactRoot(input?.token, "Landing Warrant token");
  const generation = positiveInteger(input?.generation, "Landing Warrant generation");
  const candidateId = exactRoot(input?.candidateId, "candidateId");
  if (token !== state.landingWarrant.token) throw new Error("stale Landing Warrant token");
  if (generation !== state.landingWarrant.generation) throw new Error("stale Landing Warrant generation");
  if (candidateId !== state.landingWarrant.candidateId) throw new Error("Landing Warrant candidate mismatch");
  if (!allowExpired && Date.parse(state.landingWarrant.expiresAt) <= Date.parse(now)) throw new Error("Landing Warrant expired");
  return state.landingWarrant;
}

export function admitDevDeliveryMergeGroup(stateInput, authorityInput, { mergeGroupHead, now = new Date().toISOString() } = {}) {
  const state = normalizeDevDeliveryAuthorityState(stateInput);
  const currentTime = timestamp(now, "now");
  const warrant = assertLandingWarrant(state, authorityInput, currentTime);
  const candidate = state.candidates.find((entry) => entry.candidateId === warrant.candidateId);
  const admission = {
    schema: DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA,
    admitted: true,
    authority: "exclusive-landing-warrant",
    repository: state.repository,
    protectedBase: state.protectedBase,
    candidateId: candidate.candidateId,
    pullRequestNumber: candidate.pullRequestNumber,
    sourceHead: candidate.sourceHead,
    mergeGroupHead: exactSha(mergeGroupHead, "mergeGroupHead"),
    landingWarrantToken: warrant.token,
    landingWarrantGeneration: warrant.generation,
    stateRoot: state.stateRoot,
    admittedAt: currentTime,
  };
  return { admission, admissionRoot: devDeliveryContentRoot(admission) };
}

export function settleDevDeliveryAuthorityCandidate(stateInput, input, { now = new Date().toISOString() } = {}) {
  const currentTime = timestamp(now, "now");
  const outcome = text(input?.outcome);
  if (!TERMINAL_STATES.has(outcome)) throw new Error(`outcome must be one of ${[...TERMINAL_STATES].join(", ")}`);
  const sourceHead = exactSha(input?.sourceHead, "sourceHead");
  const evidenceRoot = exactRoot(input?.evidenceRoot, "evidenceRoot");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const pullRequestNumber = positiveInteger(input?.pullRequestNumber, "pullRequestNumber");
      const matching = state.candidates.filter((entry) => entry.pullRequestNumber === pullRequestNumber && entry.sourceHead === sourceHead);
      const activeIds = new Set([...before.qualificationLeases.map((lease) => lease.candidateId), before.landingWarrant?.candidateId].filter(Boolean));
      const candidate = matching.find((entry) => activeIds.has(entry.candidateId)) || matching.at(-1);
      if (!candidate)
        return {
          candidate: null,
          released: null,
          action: "terminal-event-not-applicable",
          mutated: false,
        };
      if (TERMINAL_STATES.has(candidate.status)) {
        if (candidate.status !== outcome) throw new Error("terminal candidate outcome does not match terminal event");
        if (candidate.terminal.evidenceRoot !== evidenceRoot) throw new Error("duplicate terminal event evidenceRoot drift");
        return {
          candidate,
          released: null,
          action: "duplicate-terminal-event-noop",
          mutated: false,
        };
      }
      if (outcome === "merged" && before.landingWarrant?.candidateId !== candidate.candidateId) throw new Error("merged settlement requires the exact active Landing Warrant");
      let released = null;
      const qualificationLease = before.qualificationLeases.find((entry) => entry.candidateId === candidate.candidateId);
      if (qualificationLease) {
        const token = exactRoot(input?.authorityToken, "authorityToken");
        const generation = positiveInteger(input?.authorityGeneration, "authorityGeneration");
        if (token !== qualificationLease.token || generation !== qualificationLease.generation) throw new Error("terminal settlement qualification authority mismatch");
        state.qualificationLeases = state.qualificationLeases.filter((entry) => entry.candidateId !== candidate.candidateId);
        released = { kind: "qualification-lease", token };
      }
      if (before.landingWarrant?.candidateId === candidate.candidateId) {
        assertLandingWarrant(
          before,
          {
            candidateId: candidate.candidateId,
            token: input?.authorityToken,
            generation: input?.authorityGeneration,
          },
          currentTime,
          { allowExpired: true },
        );
        state.landingWarrant = null;
        released = {
          kind: "landing-warrant",
          token: before.landingWarrant.token,
        };
      }
      candidate.status = outcome;
      candidate.terminal = {
        outcome,
        evidenceRoot,
        reason: text(input?.reason),
        settledAt: currentTime,
      };
      candidate.updatedAt = currentTime;
      return { candidate, released, action: "terminal-authority-released" };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.candidate?.candidateId || null,
    outcome,
    evidenceRoot,
    releasedAuthority: transaction.result.released,
    nextAction: "Authority is released immediately; select the next eligible candidate.",
  });
  return { ...changed, wake: schedulerWake(changed.state) };
}

export function observeDevDeliveryAuthorityState(stateInput, { now = new Date().toISOString() } = {}) {
  const state = normalizeDevDeliveryAuthorityState(stateInput);
  const states = {};
  for (const candidate of state.candidates) states[candidate.status] = (states[candidate.status] || 0) + 1;
  const wake = schedulerWake(state);
  return {
    schema: "kungfu.buildchain.dev-delivery-authority-observation/v1",
    authorityMode: state.authorityMode,
    repository: state.repository,
    protectedBase: state.protectedBase,
    stateRoot: state.stateRoot,
    generation: state.generation,
    qualification: {
      bound: state.policy.maxQualificationLeases,
      active: state.qualificationLeases,
      mergeGroupAdmission: false,
    },
    landing: {
      bound: 1,
      active: state.landingWarrant,
      mergeGroupAdmission: Boolean(state.landingWarrant),
    },
    fairness: {
      maxLandingOvertakes: schedulerPolicy(state).maxLandingOvertakes,
      candidates: state.candidates
        .filter((candidate) => !TERMINAL_STATES.has(candidate.status))
        .map((candidate) => ({
          candidateId: candidate.candidateId,
          landingOvertakes: candidate.landingOvertakes || 0,
        })),
    },
    wake,
    states,
    observedAt: timestamp(now, "now"),
  };
}

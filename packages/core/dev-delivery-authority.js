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

function normalizePolicy(policy = {}) {
  return {
    maxQualificationLeases: positiveInteger(policy.maxQualificationLeases, "policy maxQualificationLeases", 2),
    qualificationLeaseSeconds: positiveInteger(policy.qualificationLeaseSeconds, "policy qualificationLeaseSeconds", 3600),
    landingLeaseSeconds: positiveInteger(policy.landingLeaseSeconds, "policy landingLeaseSeconds", 900),
  };
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
  return {
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
    qualification: input.qualification ? { evidenceRoot: exactRoot(input.qualification.evidenceRoot, "qualification evidenceRoot"), qualifiedAt: timestamp(input.qualification.qualifiedAt, "qualification qualifiedAt") } : null,
    terminal: input.terminal ? { outcome: text(input.terminal.outcome), evidenceRoot: exactRoot(input.terminal.evidenceRoot, "terminal evidenceRoot"), reason: text(input.terminal.reason), settledAt: timestamp(input.terminal.settledAt, "terminal settledAt") } : null,
  };
}

function normalizeQualificationLease(input) {
  if (input.schema !== DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA) throw new Error("qualification lease schema is unsupported");
  if (input.authority !== "qualification-only") throw new Error("qualification lease authority must be qualification-only");
  if (input.mergeGroupAdmission !== false) throw new Error("qualification lease cannot carry merge_group admission");
  return {
    schema: input.schema,
    authority: input.authority,
    mergeGroupAdmission: false,
    candidateId: exactRoot(input.candidateId, "qualification lease candidateId"),
    token: exactRoot(input.token, "qualification lease token"),
    generation: positiveInteger(input.generation, "qualification lease generation"),
    issuedAt: timestamp(input.issuedAt, "qualification lease issuedAt"),
    expiresAt: timestamp(input.expiresAt, "qualification lease expiresAt"),
  };
}

function normalizeLandingWarrant(input) {
  if (input.schema !== DEV_DELIVERY_LANDING_WARRANT_SCHEMA) throw new Error("Landing Warrant schema is unsupported");
  if (input.authority !== "merge-group-admission") throw new Error("Landing Warrant authority must be merge-group-admission");
  if (input.mergeGroupAdmission !== true) throw new Error("Landing Warrant must explicitly carry merge_group admission");
  return {
    schema: input.schema,
    authority: input.authority,
    mergeGroupAdmission: true,
    candidateId: exactRoot(input.candidateId, "Landing Warrant candidateId"),
    token: exactRoot(input.token, "Landing Warrant token"),
    generation: positiveInteger(input.generation, "Landing Warrant generation"),
    issuedAt: timestamp(input.issuedAt, "Landing Warrant issuedAt"),
    expiresAt: timestamp(input.expiresAt, "Landing Warrant expiresAt"),
  };
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
    policy: normalizePolicy(policy),
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
  delete state.stateRoot;
  const now = timestamp(nowInput, "now");
  const result = mutate(state, before, now);
  if (result?.mutated === false) return { before, after: before, expectedOldStateRoot: before.stateRoot, result };
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
  return { state: transaction.after, receipt: value, receiptRoot: devDeliveryContentRoot(value) };
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
        },
        state,
      );
      const conflicting = state.candidates.find((entry) => entry.pullRequestNumber === candidate.pullRequestNumber && !TERMINAL_STATES.has(entry.status));
      if (conflicting) {
        const exactFields = ["candidateId", "sourceHead", "sourcePatchRoot", "sourceProofRoot", "planRoot", "closureRoot", "dependencyRoot", "toolchainRoot"];
        const same = exactFields.every((field) => conflicting[field] === candidate[field]);
        if (!same) throw new Error(`PR #${candidate.pullRequestNumber} already has different active authority state`);
        return { candidate: conflicting, action: "duplicate-noop", mutated: false };
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
  return devDeliveryContentRoot({ schema, repository: state.repository, protectedBase: state.protectedBase, candidateId: candidate.candidateId, generation, expectedOldStateRoot: state.stateRoot, issuedAt });
}

function recoverExpiredQualificationLeases(state, now) {
  const expired = state.qualificationLeases.filter((lease) => Date.parse(lease.expiresAt) <= Date.parse(now));
  if (expired.length === 0) return [];
  const expiredIds = new Set(expired.map((lease) => lease.candidateId));
  state.qualificationLeases = state.qualificationLeases.filter((lease) => !expiredIds.has(lease.candidateId));
  for (const candidate of state.candidates) {
    if (expiredIds.has(candidate.candidateId)) {
      candidate.status = "queued";
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
      if (state.qualificationLeases.length >= state.policy.maxQualificationLeases) return { lease: null, recovered, action: "qualification-bound-full-noop", mutated: recovered.length > 0 };
      const candidate = state.candidates.find((entry) => entry.status === "queued");
      if (!candidate) return { lease: null, recovered, action: "no-queued-candidate-noop", mutated: recovered.length > 0 };
      state.qualificationCounter += 1;
      const duration = positiveInteger(leaseSeconds, "qualification leaseSeconds", state.policy.qualificationLeaseSeconds);
      const lease = {
        schema: DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
        authority: "qualification-only",
        mergeGroupAdmission: false,
        candidateId: candidate.candidateId,
        generation: state.qualificationCounter,
        issuedAt: currentTime,
        expiresAt: new Date(Date.parse(currentTime) + duration * 1000).toISOString(),
        token: "",
      };
      lease.token = authorityToken(lease.schema, before, candidate, lease.generation, currentTime);
      state.qualificationLeases.push(lease);
      candidate.status = "qualifying";
      candidate.updatedAt = currentTime;
      return { lease, recovered, candidate, action: "qualification-lease-acquired" };
    },
    currentTime,
  );
  return {
    ...receipt(transaction, transaction.result.action, {
      candidateId: transaction.result.candidate?.candidateId || null,
      authority: transaction.result.lease?.authority || null,
      mergeGroupAdmission: false,
      recoveredLeaseCount: transaction.result.recovered.length,
      nextAction: transaction.result.lease ? "Run qualification only; this lease cannot admit merge_group." : "Wait for a Qualification Lease slot or queued candidate.",
    }),
    lease: transaction.result.lease,
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
      candidate.qualification = { evidenceRoot: evidence, qualifiedAt: currentTime };
      candidate.updatedAt = currentTime;
      return { lease, candidate };
    },
    currentTime,
  );
  return receipt(transaction, "qualification-completed-lease-released", {
    candidateId: transaction.result.candidate.candidateId,
    qualificationEvidenceRoot: evidence,
    releasedQualificationToken: transaction.result.lease.token,
    mergeGroupAdmission: false,
    nextAction: "Wait for the single exclusive Landing Warrant.",
  });
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
      const candidate = state.candidates.find((entry) => entry.status === "qualified");
      if (!candidate) return { warrant: null, recovered, action: "no-qualified-candidate-noop", mutated: Boolean(recovered) };
      state.landingCounter += 1;
      const duration = positiveInteger(leaseSeconds, "landing leaseSeconds", state.policy.landingLeaseSeconds);
      const warrant = {
        schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
        authority: "merge-group-admission",
        mergeGroupAdmission: true,
        candidateId: candidate.candidateId,
        generation: state.landingCounter,
        issuedAt: currentTime,
        expiresAt: new Date(Date.parse(currentTime) + duration * 1000).toISOString(),
        token: "",
      };
      warrant.token = authorityToken(warrant.schema, before, candidate, warrant.generation, currentTime);
      state.landingWarrant = warrant;
      candidate.status = "landing";
      candidate.updatedAt = currentTime;
      return { warrant, recovered, candidate, action: "landing-warrant-acquired" };
    },
    currentTime,
  );
  return {
    ...receipt(transaction, transaction.result.action, {
      candidateId: transaction.result.warrant?.candidateId || null,
      authority: transaction.result.warrant?.authority || null,
      mergeGroupAdmission: Boolean(transaction.result.warrant),
      recoveredLandingWarrant: Boolean(transaction.result.recovered),
      nextAction: transaction.result.warrant ? "Admit only this exact candidate to merge_group." : "Wait for a qualified candidate.",
    }),
    warrant: transaction.result.warrant,
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
      if (!candidate) return { candidate: null, released: null, action: "terminal-event-not-applicable", mutated: false };
      if (TERMINAL_STATES.has(candidate.status)) {
        if (candidate.status !== outcome) throw new Error("terminal candidate outcome does not match terminal event");
        if (candidate.terminal.evidenceRoot !== evidenceRoot) throw new Error("duplicate terminal event evidenceRoot drift");
        return { candidate, released: null, action: "duplicate-terminal-event-noop", mutated: false };
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
        released = { kind: "landing-warrant", token: before.landingWarrant.token };
      }
      candidate.status = outcome;
      candidate.terminal = { outcome, evidenceRoot, reason: text(input?.reason), settledAt: currentTime };
      candidate.updatedAt = currentTime;
      return { candidate, released, action: "terminal-authority-released" };
    },
    currentTime,
  );
  return receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.candidate?.candidateId || null,
    outcome,
    evidenceRoot,
    releasedAuthority: transaction.result.released,
    nextAction: "Authority is released immediately; select the next eligible candidate.",
  });
}

export function observeDevDeliveryAuthorityState(stateInput, { now = new Date().toISOString() } = {}) {
  const state = normalizeDevDeliveryAuthorityState(stateInput);
  const states = {};
  for (const candidate of state.candidates) states[candidate.status] = (states[candidate.status] || 0) + 1;
  return {
    schema: "kungfu.buildchain.dev-delivery-authority-observation/v1",
    authorityMode: state.authorityMode,
    repository: state.repository,
    protectedBase: state.protectedBase,
    stateRoot: state.stateRoot,
    generation: state.generation,
    qualification: { bound: state.policy.maxQualificationLeases, active: state.qualificationLeases, mergeGroupAdmission: false },
    landing: { bound: 1, active: state.landingWarrant, mergeGroupAdmission: Boolean(state.landingWarrant) },
    states,
    observedAt: timestamp(now, "now"),
  };
}

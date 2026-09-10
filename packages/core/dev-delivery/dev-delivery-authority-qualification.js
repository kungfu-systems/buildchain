import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { chainedDevDeliveryAttemptInput } from "./dev-delivery-candidate-identity.js";
import {
  DEV_DELIVERY_AUTHORITY_MODE,
  DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA,
  DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
  DEV_DELIVERY_SCHEDULER_REASON_SCHEMA,
  DEV_DELIVERY_SCHEDULER_WAKE_SCHEMA,
  TERMINAL_STATES,
  normalizeCandidate,
  receipt,
  schedulerPolicy,
  transition,
} from "./dev-delivery-authority-state.js";
import {
  createDevDeliveryBoundedQualificationReceipt,
  verifyDevDeliveryQualificationEvidence,
} from "./dev-delivery-authority-evidence.js";

export function submitDevDeliveryAuthorityCandidate(
  stateInput,
  input,
  { now = new Date().toISOString() } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state) => {
      const latestSamePullRequest = [...state.candidates]
        .reverse()
        .find(
          (entry) =>
            entry.pullRequestNumber === Number(input.pullRequestNumber),
        );
      const candidateInput = latestSamePullRequest
        ? chainedDevDeliveryAttemptInput({
            queue: state,
            candidate: latestSamePullRequest,
            input,
            currentTime,
            terminalStates: TERMINAL_STATES,
          }) || input
        : input;
      const candidate = normalizeCandidate(
        {
          ...candidateInput,
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
      if (
        candidate.deliveryClass !== "non-native-fast" &&
        !candidate.environmentRoot
      ) {
        throw new Error(
          "native delivery authority candidate requires environmentRoot",
        );
      }
      if (
        candidate.deliveryClass !== "non-native-fast" &&
        !candidate.nativeCommandContract
      ) {
        throw new Error(
          "native delivery authority candidate requires nativeCommandContract",
        );
      }
      const conflicting = state.candidates.find(
        (entry) =>
          entry.pullRequestNumber === candidate.pullRequestNumber &&
          !TERMINAL_STATES.has(entry.status),
      );
      if (conflicting) {
        const exactFields = [
          "candidateId",
          "sourceHead",
          "sourcePatchRoot",
          "sourceProofRoot",
          "planRoot",
          "closureRoot",
          "dependencyRoot",
          "toolchainRoot",
          "environmentRoot",
        ];
        const same = exactFields.every(
          (field) => conflicting[field] === candidate[field],
        );
        const sameDomains =
          JSON.stringify(conflicting.qualificationDomains || []) ===
          JSON.stringify(candidate.qualificationDomains || []);
        const sameEvidence =
          conflicting.nativeCommandContract?.commandRoot ===
            candidate.nativeCommandContract?.commandRoot &&
          JSON.stringify(conflicting.shardEvidenceRoots || []) ===
            JSON.stringify(candidate.shardEvidenceRoots || []) &&
          JSON.stringify(conflicting.affectedPaths || []) ===
            JSON.stringify(candidate.affectedPaths || []);
        if (!same || !sameDomains || !sameEvidence)
          throw new Error(
            `PR #${candidate.pullRequestNumber} already has different active authority state`,
          );
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

export function authorityToken(schema, state, candidate, generation, issuedAt) {
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

function rootedSchedulerReason(
  state,
  code,
  candidate,
  conflicts = [],
  message = "",
) {
  const body = {
    schema: DEV_DELIVERY_SCHEDULER_REASON_SCHEMA,
    code,
    candidateId: candidate?.candidateId || null,
    conflictingCandidateIds: [
      ...new Set(conflicts.map((entry) => entry.candidateId)),
    ].sort(),
    stateRoot: state.stateRoot,
    message,
  };
  return { ...body, reasonRoot: devDeliveryContentRoot(body) };
}

function activeSafetyCandidates(state, candidateId = "") {
  return state.candidates.filter(
    (entry) =>
      entry.candidateId !== candidateId &&
      ["qualifying", "qualified", "landing"].includes(entry.status),
  );
}

function qualificationEligibility(state, candidate) {
  const active = activeSafetyCandidates(state, candidate.candidateId);
  if (active.length === 0) return { eligible: true, reason: null };
  const domains = candidate.qualificationDomains || [];
  if (domains.length === 0) {
    return {
      eligible: false,
      reason: rootedSchedulerReason(
        state,
        "unknown-qualification-domain",
        candidate,
        active,
        "A candidate without rooted qualification domains cannot bypass an active safety boundary.",
      ),
    };
  }
  const unknown = active.filter(
    (entry) => (entry.qualificationDomains || []).length === 0,
  );
  if (unknown.length > 0) {
    return {
      eligible: false,
      reason: rootedSchedulerReason(
        state,
        "active-unknown-qualification-domain",
        candidate,
        unknown,
        "An active candidate with unknown qualification domains is a global safety boundary.",
      ),
    };
  }
  const domainSet = new Set(domains);
  const overlapping = active.filter((entry) =>
    entry.qualificationDomains.some((domain) => domainSet.has(domain)),
  );
  if (overlapping.length > 0) {
    return {
      eligible: false,
      reason: rootedSchedulerReason(
        state,
        "overlapping-qualification-domain",
        candidate,
        overlapping,
        "Overlapping rooted qualification domains must be serialized.",
      ),
    };
  }
  return { eligible: true, reason: null };
}

function queuedByAge(state) {
  return state.candidates
    .filter((candidate) => candidate.status === "queued")
    .sort(
      (left, right) =>
        left.enqueuedAt.localeCompare(right.enqueuedAt) ||
        left.candidateId.localeCompare(right.candidateId),
    );
}

export function landingEligibility(state, candidate) {
  if (
    candidate.qualification?.schema !==
      DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA ||
    candidate.qualification?.authority !== "verified-native-qualification" ||
    candidate.qualification?.nativeProofAuthority !== true
  ) {
    return {
      eligible: false,
      older: [],
      reason: rootedSchedulerReason(
        state,
        "native-qualification-authority-required",
        candidate,
        [],
        "Only complete verified native qualification may acquire new Landing authority.",
      ),
    };
  }
  const { maxLandingOvertakes } = schedulerPolicy(state);
  const older = state.candidates.filter(
    (entry) =>
      !TERMINAL_STATES.has(entry.status) &&
      entry.candidateId !== candidate.candidateId &&
      (entry.enqueuedAt < candidate.enqueuedAt ||
        (entry.enqueuedAt === candidate.enqueuedAt &&
          entry.candidateId < candidate.candidateId)),
  );
  const exhausted = older.filter(
    (entry) => (entry.landingOvertakes || 0) >= maxLandingOvertakes,
  );
  if (exhausted.length === 0) return { eligible: true, older, reason: null };
  return {
    eligible: false,
    older,
    reason: rootedSchedulerReason(
      state,
      "landing-overtake-bound-reached",
      candidate,
      exhausted,
      `A predecessor has exhausted the configured ${maxLandingOvertakes}-landing overtake budget.`,
    ),
  };
}

export function schedulerWake(state) {
  const available = Math.max(
    0,
    state.policy.maxQualificationLeases - state.qualificationLeases.length,
  );
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
    simulated.candidates.find(
      (entry) => entry.candidateId === candidate.candidateId,
    ).status = "qualifying";
  }
  let landingCandidateId = null;
  let landingBlockedReason = null;
  if (!state.landingWarrant) {
    const qualified = state.candidates
      .filter((candidate) => candidate.status === "qualified")
      .sort(
        (left, right) =>
          left.enqueuedAt.localeCompare(right.enqueuedAt) ||
          left.candidateId.localeCompare(right.candidateId),
      );
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

export function recoverExpiredQualificationLeases(state, now) {
  const expired = state.qualificationLeases.filter(
    (lease) => Date.parse(lease.expiresAt) <= Date.parse(now),
  );
  if (expired.length === 0) return [];
  const expiredIds = new Set(expired.map((lease) => lease.candidateId));
  state.qualificationLeases = state.qualificationLeases.filter(
    (lease) => !expiredIds.has(lease.candidateId),
  );
  const { maxQualificationAttempts } = schedulerPolicy(state);
  for (const candidate of state.candidates) {
    if (expiredIds.has(candidate.candidateId)) {
      if ((candidate.qualificationAttempts || 0) >= maxQualificationAttempts) {
        const reason = rootedSchedulerReason(
          state,
          "qualification-heartbeat-expired-terminal",
          candidate,
          [],
          `Qualification heartbeat expired after ${candidate.qualificationAttempts} attempts.`,
        );
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

export function acquireDevDeliveryQualificationLease(
  stateInput,
  { now = new Date().toISOString(), leaseSeconds } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const recovered = recoverExpiredQualificationLeases(state, currentTime);
      if (
        state.qualificationLeases.length >= state.policy.maxQualificationLeases
      )
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
          action:
            blockedReasons.length > 0
              ? "qualification-safety-boundary-noop"
              : "no-queued-candidate-noop",
          mutated: recovered.length > 0,
        };
      }
      state.qualificationCounter += 1;
      candidate.qualificationAttempts =
        (candidate.qualificationAttempts || 0) + 1;
      const duration = positiveInteger(
        leaseSeconds,
        "qualification leaseSeconds",
        state.policy.qualificationLeaseSeconds,
      );
      const lease = {
        schema: DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
        authority: "qualification-only",
        mergeGroupAdmission: false,
        candidateId: candidate.candidateId,
        generation: state.qualificationCounter,
        issuedAt: currentTime,
        heartbeatAt: currentTime,
        expiresAt: new Date(
          Date.parse(currentTime) + duration * 1000,
        ).toISOString(),
        token: "",
      };
      lease.token = authorityToken(
        lease.schema,
        before,
        candidate,
        lease.generation,
        currentTime,
      );
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
    nextAction: transaction.result.lease
      ? "Run qualification only; this lease cannot admit merge_group."
      : "Wait for a Qualification Lease slot or queued candidate.",
  });
  return {
    ...changed,
    lease: transaction.result.lease,
    wake: schedulerWake(changed.state),
  };
}

export function heartbeatDevDeliveryQualificationLease(
  stateInput,
  leaseInput,
  { now = new Date().toISOString(), leaseSeconds } = {},
) {
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
      const active = state.qualificationLeases.find(
        (entry) => entry.candidateId === lease.candidateId,
      );
      const duration = positiveInteger(
        leaseSeconds,
        "qualification leaseSeconds",
        state.policy.qualificationLeaseSeconds,
      );
      active.heartbeatAt = currentTime;
      active.expiresAt = new Date(
        Date.parse(currentTime) + duration * 1000,
      ).toISOString();
      return { lease: active, action: "qualification-heartbeat" };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.lease.candidateId,
    authorityGeneration: transaction.result.lease.generation,
    expiresAt: transaction.result.lease.expiresAt,
    nextAction:
      "Continue qualification while the fenced lease remains current.",
  });
  return {
    ...changed,
    lease: transaction.result.lease,
    wake: schedulerWake(changed.state),
  };
}

function assertQualificationLease(state, input, now) {
  const token = exactRoot(input?.token, "qualification lease token");
  const generation = positiveInteger(
    input?.generation,
    "qualification lease generation",
  );
  const candidateId = exactRoot(input?.candidateId, "candidateId");
  const lease = state.qualificationLeases.find(
    (entry) => entry.candidateId === candidateId,
  );
  if (!lease || lease.token !== token)
    throw new Error("stale qualification lease token");
  if (lease.generation !== generation)
    throw new Error("stale qualification lease generation");
  if (Date.parse(lease.expiresAt) <= Date.parse(now))
    throw new Error("Qualification Lease expired");
  return lease;
}

export function completeDevDeliveryQualification(
  stateInput,
  leaseInput,
  {
    sourceProof,
    nativeProof,
    qualificationContract,
    now = new Date().toISOString(),
  } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const lease = assertQualificationLease(before, leaseInput, currentTime);
      const candidate = state.candidates.find(
        (entry) => entry.candidateId === lease.candidateId,
      );
      const evidence = verifyDevDeliveryQualificationEvidence({
        state: before,
        candidate,
        lease,
        sourceProof,
        nativeProof,
        qualificationContract,
      });
      const qualificationReceipt = createDevDeliveryBoundedQualificationReceipt(
        {
          state: before,
          candidate,
          lease,
          evidence,
          qualifiedAt: currentTime,
        },
      );
      state.qualificationLeases = state.qualificationLeases.filter(
        (entry) => entry.candidateId !== lease.candidateId,
      );
      candidate.status = "qualified";
      candidate.qualification = {
        schema: DEV_DELIVERY_NATIVE_QUALIFICATION_SCHEMA,
        authority: "verified-native-qualification",
        nativeProofAuthority: true,
        ...evidence,
        qualificationReceiptRoot: qualificationReceipt.receiptRoot,
        qualifiedAt: currentTime,
      };
      candidate.updatedAt = currentTime;
      return { lease, candidate, qualificationReceipt };
    },
    currentTime,
  );
  return {
    state: transaction.after,
    receipt: transaction.result.qualificationReceipt.receipt,
    receiptRoot: transaction.result.qualificationReceipt.receiptRoot,
    wake: schedulerWake(transaction.after),
  };
}

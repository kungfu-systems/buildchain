import {
  devDeliveryClone as clone,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
  normalizeDevDeliveryAuthorityState,
  receipt,
  transition,
} from "./dev-delivery-authority-state.js";
import {
  authorityToken,
  landingEligibility,
  recoverExpiredQualificationLeases,
  schedulerWake,
} from "./dev-delivery-authority-qualification.js";
import {
  readGitHubLandingActiveProviderAttempt,
  readGitHubLandingProviderAttempt,
  readGitHubLandingTerminalState,
} from "./dev-delivery-landing-readback.js";
import { admitDevDeliveryMergeGroupWithVerifiedProviderAttempt } from "./dev-delivery-landing-admission-core.js";
import { DEV_DELIVERY_TESTING_PROVIDER_READBACK } from "./dev-delivery-landing-testing-port.js";
import { normalizeDevDeliveryProviderAttempt } from "./dev-delivery-provider-attempt.js";
import {
  assertDevDeliveryLandingWarrant,
  settleDevDeliveryAuthorityCandidateInternal,
} from "./dev-delivery-authority-settlement.js";

export {
  DEV_DELIVERY_AUTHORITY_CONTRACT,
  DEV_DELIVERY_AUTHORITY_MIGRATION_SCHEMA,
  DEV_DELIVERY_AUTHORITY_MODE,
  DEV_DELIVERY_AUTHORITY_RECEIPT_SCHEMA,
  DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
  DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA,
  DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
  DEV_DELIVERY_SCHEDULER_REASON_SCHEMA,
  DEV_DELIVERY_SCHEDULER_WAKE_SCHEMA,
  createDevDeliveryAuthorityState,
  migrateDevDeliveryAuthorityState,
  normalizeDevDeliveryAuthorityState,
} from "./dev-delivery-authority-state.js";
export {
  acquireDevDeliveryQualificationLease,
  completeDevDeliveryQualification,
  heartbeatDevDeliveryQualificationLease,
  submitDevDeliveryAuthorityCandidate,
} from "./dev-delivery-authority-qualification.js";
export {
  DEV_DELIVERY_BOUNDED_QUALIFICATION_CONTRACT_SCHEMA,
  DEV_DELIVERY_BOUNDED_QUALIFICATION_RECEIPT_SCHEMA,
  createDevDeliveryQualificationContract,
  verifyDevDeliveryQualificationEvidence,
} from "./dev-delivery-authority-evidence.js";
export { observeDevDeliveryAuthorityState } from "./dev-delivery-authority-observation.js";
export {
  DEV_DELIVERY_LANDING_TERMINAL_READBACK_SCHEMA,
  deriveDevDeliveryLandingProviderAttempt,
  readGitHubLandingActiveProviderAttempt,
  readGitHubLandingProviderAttempt,
  readGitHubLandingTerminalState,
  verifyLandingSettlementReadback,
  verifyExpiredLandingSettlementReadback,
} from "./dev-delivery-landing-readback.js";
function recoverExpiredLandingWarrant(state, now) {
  if (
    !state.landingWarrant ||
    Date.parse(state.landingWarrant.expiresAt) > Date.parse(now)
  )
    return null;
  return clone(state.landingWarrant);
}

export function recoverDevDeliveryAuthority(
  stateInput,
  { now = new Date().toISOString() } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state) => {
      const qualificationLeases = recoverExpiredQualificationLeases(
        state,
        currentTime,
      );
      const landingWarrant = recoverExpiredLandingWarrant(state, currentTime);
      return {
        qualificationLeases,
        landingWarrant,
        action:
          qualificationLeases.length > 0 && landingWarrant
            ? "expired-qualification-recovered-landing-stop-required"
            : qualificationLeases.length > 0
              ? "expired-qualification-authority-recovered"
              : landingWarrant
                ? "expired-landing-warrant-stop-required-noop"
                : "no-expired-authority-noop",
        mutated: qualificationLeases.length > 0,
      };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    recoveredQualificationTokens: transaction.result.qualificationLeases.map(
      (lease) => lease.token,
    ),
    retainedExpiredLandingToken:
      transaction.result.landingWarrant?.token || null,
    nextAction: transaction.result.landingWarrant
      ? "Prove the admitted provider attempt stopped or reconcile its terminal outcome, then settle this exact Landing fence."
      : "Wake the next eligible qualification or landing candidate.",
  });
  return { ...changed, wake: schedulerWake(changed.state) };
}

export function acquireDevDeliveryLandingWarrant(
  stateInput,
  { now = new Date().toISOString(), leaseSeconds } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const recovered = recoverExpiredLandingWarrant(state, currentTime);
      if (state.landingWarrant) {
        return {
          warrant: recovered ? null : state.landingWarrant,
          recovered,
          action: recovered
            ? "expired-landing-warrant-stop-required-noop"
            : "exclusive-landing-warrant-retained-noop",
          mutated: false,
        };
      }
      const qualified = state.candidates
        .filter((entry) => entry.status === "qualified")
        .sort(
          (left, right) =>
            left.enqueuedAt.localeCompare(right.enqueuedAt) ||
            left.candidateId.localeCompare(right.candidateId),
        );
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
          action: blockedReason
            ? "landing-overtake-bound-noop"
            : "no-qualified-candidate-noop",
          mutated: Boolean(recovered),
        };
      }
      state.landingCounter += 1;
      const duration = positiveInteger(
        leaseSeconds,
        "landing leaseSeconds",
        state.policy.landingLeaseSeconds,
      );
      const warrant = {
        schema: DEV_DELIVERY_LANDING_WARRANT_SCHEMA,
        authority: "merge-group-admission",
        mergeGroupAdmission: true,
        candidateId: candidate.candidateId,
        generation: state.landingCounter,
        issuedAt: currentTime,
        heartbeatAt: currentTime,
        expiresAt: new Date(
          Date.parse(currentTime) + duration * 1000,
        ).toISOString(),
        token: "",
      };
      warrant.token = authorityToken(
        warrant.schema,
        before,
        candidate,
        warrant.generation,
        currentTime,
      );
      state.landingWarrant = warrant;
      candidate.status = "landing";
      candidate.updatedAt = currentTime;
      for (const predecessor of older)
        predecessor.landingOvertakes = (predecessor.landingOvertakes || 0) + 1;
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
    retainedExpiredLandingWarrant: Boolean(transaction.result.recovered),
    blockedReason: transaction.result.blockedReason || null,
    nextAction: transaction.result.warrant
      ? "Admit only this exact candidate to merge_group."
      : transaction.result.recovered
        ? "Prove provider stop or reconcile terminal outcome, then settle the retained Landing fence."
        : "Wait for a qualified candidate.",
  });
  return {
    ...changed,
    warrant: transaction.result.warrant,
    wake: schedulerWake(changed.state),
  };
}

function applyDevDeliveryLandingHeartbeat(
  stateInput,
  warrantInput,
  { now = new Date().toISOString(), leaseSeconds, providerAttempt } = {},
) {
  const currentTime = timestamp(now, "now");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const warrant = assertDevDeliveryLandingWarrant(
        before,
        warrantInput,
        currentTime,
      );
      if (!warrant.providerAttempt) {
        throw new Error(
          "Landing heartbeat requires a persisted admitted provider attempt",
        );
      }
      if (!providerAttempt) {
        throw new Error(
          "Landing heartbeat requires the persisted admitted provider attempt input",
        );
      }
      const exactProviderAttempt = normalizeDevDeliveryProviderAttempt(
        providerAttempt,
        {
          repository: before.repository,
          sourceHead: state.candidates.find(
            (entry) => entry.candidateId === warrant.candidateId,
          )?.sourceHead,
          mergeGroupHead: warrant.mergeGroupHead,
          protectedBase: before.protectedBase,
        },
      );
      if (
        JSON.stringify(exactProviderAttempt) !==
        JSON.stringify(warrant.providerAttempt)
      ) {
        throw new Error(
          "Landing heartbeat provider attempt does not match persisted admission",
        );
      }
      if (warrant.heartbeatAt === currentTime)
        return {
          warrant,
          action: "duplicate-landing-heartbeat-noop",
          mutated: false,
        };
      const duration = positiveInteger(
        leaseSeconds,
        "landing leaseSeconds",
        state.policy.landingLeaseSeconds,
      );
      state.landingWarrant.heartbeatAt = currentTime;
      state.landingWarrant.expiresAt = new Date(
        Date.parse(currentTime) + duration * 1000,
      ).toISOString();
      return { warrant: state.landingWarrant, action: "landing-heartbeat" };
    },
    currentTime,
  );
  const changed = receipt(transaction, transaction.result.action, {
    candidateId: transaction.result.warrant.candidateId,
    authorityGeneration: transaction.result.warrant.generation,
    expiresAt: transaction.result.warrant.expiresAt,
    nextAction:
      "Continue the exact landing attempt while the Warrant remains current.",
  });
  return {
    ...changed,
    warrant: transaction.result.warrant,
    wake: schedulerWake(changed.state),
  };
}

export async function heartbeatDevDeliveryLandingWarrant(
  stateInput,
  warrantInput,
  {
    providerAttempt,
    now = new Date().toISOString(),
    leaseSeconds,
    token = process.env.GITHUB_TOKEN,
    apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  } = {},
) {
  const state = normalizeDevDeliveryAuthorityState(stateInput);
  const currentTime = timestamp(now, "now");
  const warrant = assertDevDeliveryLandingWarrant(
    state,
    warrantInput,
    currentTime,
  );
  const candidate = state.candidates.find(
    (entry) => entry.candidateId === warrant.candidateId,
  );
  if (!candidate || !warrant.providerAttempt) {
    throw new Error(
      "Landing heartbeat requires the persisted admitted provider attempt",
    );
  }
  if (!providerAttempt) {
    throw new Error(
      "Landing heartbeat requires the persisted admitted provider attempt input",
    );
  }
  const exactProviderAttempt = normalizeDevDeliveryProviderAttempt(
    providerAttempt,
    {
      repository: state.repository,
      sourceHead: candidate.sourceHead,
      mergeGroupHead: warrant.mergeGroupHead,
      protectedBase: state.protectedBase,
    },
  );
  if (
    JSON.stringify(exactProviderAttempt) !==
    JSON.stringify(warrant.providerAttempt)
  ) {
    throw new Error(
      "Landing heartbeat provider attempt does not match persisted admission",
    );
  }
  const activeAttempt = await readGitHubLandingActiveProviderAttempt({
    state,
    candidate,
    warrant,
    providerAttempt: exactProviderAttempt,
    token,
    apiUrl,
    now: currentTime,
  });
  return applyDevDeliveryLandingHeartbeat(state, warrantInput, {
    now: currentTime,
    leaseSeconds,
    providerAttempt: activeAttempt,
  });
}

export const heartbeatDevDeliveryLandingWarrantWithGitHubProvider =
  heartbeatDevDeliveryLandingWarrant;

export async function admitDevDeliveryMergeGroup(
  stateInput,
  authorityInput,
  {
    mergeGroupHead,
    providerRunId,
    providerRunAttempt,
    token = process.env.GITHUB_TOKEN,
    apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
    now = new Date().toISOString(),
  } = {},
) {
  const state = normalizeDevDeliveryAuthorityState(stateInput);
  const currentTime = timestamp(now, "now");
  const warrant = assertDevDeliveryLandingWarrant(
    state,
    authorityInput,
    currentTime,
  );
  const candidate = state.candidates.find(
    (entry) => entry.candidateId === warrant.candidateId,
  );
  if (!candidate) {
    throw new Error("merge_group admission requires the warranted candidate");
  }
  const providerAttempt = await readGitHubLandingProviderAttempt({
    state,
    candidate,
    mergeGroupHead,
    providerRunId,
    providerRunAttempt,
    token,
    apiUrl,
  });
  return admitDevDeliveryMergeGroupWithVerifiedProviderAttempt(
    state,
    authorityInput,
    { mergeGroupHead, providerAttempt, now: currentTime },
  );
}

export function settleDevDeliveryAuthorityCandidate(
  stateInput,
  input,
  options = {},
) {
  const now = options.now || new Date().toISOString();
  return settleDevDeliveryAuthorityCandidateInternal(stateInput, input, {
    now,
    sealedProviderReadback:
      options[DEV_DELIVERY_TESTING_PROVIDER_READBACK] || null,
  });
}

export async function settleDevDeliveryAuthorityCandidateWithGitHubProvider(
  stateInput,
  input,
  {
    now = new Date().toISOString(),
    token = process.env.GITHUB_TOKEN,
    apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  } = {},
) {
  const initial = normalizeDevDeliveryAuthorityState(stateInput);
  const pullRequestNumber = positiveInteger(
    input?.pullRequestNumber,
    "pullRequestNumber",
  );
  const sourceHead = exactSha(input?.sourceHead, "sourceHead");
  const candidate = initial.candidates.find(
    (entry) =>
      entry.pullRequestNumber === pullRequestNumber &&
      entry.sourceHead === sourceHead &&
      initial.landingWarrant?.candidateId === entry.candidateId,
  );
  const sealedProviderReadback =
    candidate && initial.landingWarrant?.providerAttempt
      ? await readGitHubLandingTerminalState({
          state: initial,
          candidate,
          warrant: initial.landingWarrant,
          token,
          apiUrl,
          now,
        })
      : null;
  return settleDevDeliveryAuthorityCandidateInternal(stateInput, input, {
    now,
    sealedProviderReadback,
  });
}

import {
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA,
  TERMINAL_STATES,
  normalizeDevDeliveryAuthorityState,
  receipt,
  transition,
} from "./dev-delivery-authority-state.js";
import { schedulerWake } from "./dev-delivery-authority-qualification.js";
import { verifyLandingSettlementReadback } from "./dev-delivery-landing-terminal-evidence.js";
import { normalizeDevDeliveryTerminalProviderEvidence } from "./dev-delivery-provider-attempt.js";
import { normalizeProviderFailureAuthorityBinding } from "./dev-delivery-warrant-settlement.js";

export function assertDevDeliveryLandingWarrant(
  state,
  input,
  now,
  { allowExpired = false } = {},
) {
  if (text(input?.schema) === DEV_DELIVERY_QUALIFICATION_LEASE_SCHEMA)
    throw new Error("Qualification Lease cannot admit merge_group");
  if (!state.landingWarrant) throw new Error("no active Landing Warrant");
  const token = exactRoot(input?.token, "Landing Warrant token");
  const generation = positiveInteger(
    input?.generation,
    "Landing Warrant generation",
  );
  const candidateId = exactRoot(input?.candidateId, "candidateId");
  if (token !== state.landingWarrant.token)
    throw new Error("stale Landing Warrant token");
  if (generation !== state.landingWarrant.generation)
    throw new Error("stale Landing Warrant generation");
  if (candidateId !== state.landingWarrant.candidateId)
    throw new Error("Landing Warrant candidate mismatch");
  if (
    !allowExpired &&
    Date.parse(state.landingWarrant.expiresAt) <= Date.parse(now)
  )
    throw new Error("Landing Warrant expired");
  return state.landingWarrant;
}

export function settleDevDeliveryAuthorityCandidateInternal(
  stateInput,
  input,
  { now = new Date().toISOString(), sealedProviderReadback = null } = {},
) {
  const currentTime = timestamp(now, "now");
  const initial = normalizeDevDeliveryAuthorityState(stateInput);
  const requestedPullRequestNumber = positiveInteger(
    input?.pullRequestNumber,
    "pullRequestNumber",
  );
  const requestedSourceHead = exactSha(input?.sourceHead, "sourceHead");
  const initialCandidate = initial.candidates.find(
    (entry) =>
      entry.pullRequestNumber === requestedPullRequestNumber &&
      entry.sourceHead === requestedSourceHead &&
      initial.landingWarrant?.candidateId === entry.candidateId,
  );
  const verifiedLanding =
    initialCandidate && initial.landingWarrant
      ? verifyLandingSettlementReadback({
          state: initial,
          candidate: initialCandidate,
          warrant: initial.landingWarrant,
          sealedProviderReadback,
        })
      : null;
  const outcome = text(verifiedLanding?.outcome || input?.outcome);
  if (!TERMINAL_STATES.has(outcome))
    throw new Error(
      `outcome must be one of ${[...TERMINAL_STATES].join(", ")}`,
    );
  const evidenceRoot = verifiedLanding
    ? verifiedLanding.evidenceRoot
    : exactRoot(input?.evidenceRoot, "evidenceRoot");
  const providerFailureAuthority = normalizeProviderFailureAuthorityBinding(
    input || {},
  );
  if (providerFailureAuthority && outcome !== "terminal-failure") {
    throw new Error(
      "provider failure authority is valid only for terminal-failure",
    );
  }
  const transaction = transition(
    stateInput,
    (state, before) => {
      const matching = state.candidates.filter(
        (entry) =>
          entry.pullRequestNumber === requestedPullRequestNumber &&
          entry.sourceHead === requestedSourceHead,
      );
      const activeIds = new Set(
        [
          ...before.qualificationLeases.map((lease) => lease.candidateId),
          before.landingWarrant?.candidateId,
        ].filter(Boolean),
      );
      const candidate =
        matching.find((entry) => activeIds.has(entry.candidateId)) ||
        matching.at(-1);
      if (!candidate)
        return {
          candidate: null,
          released: null,
          action: "terminal-event-not-applicable",
          mutated: false,
        };
      if (TERMINAL_STATES.has(candidate.status)) {
        if (candidate.status !== outcome)
          throw new Error(
            "terminal candidate outcome does not match terminal event",
          );
        if (candidate.terminal.evidenceRoot !== evidenceRoot)
          throw new Error("duplicate terminal event evidenceRoot drift");
        const durableFailureAuthority =
          normalizeProviderFailureAuthorityBinding(candidate.terminal);
        if (
          JSON.stringify(durableFailureAuthority) !==
          JSON.stringify(providerFailureAuthority)
        )
          throw new Error(
            "duplicate terminal event provider failure authority drift",
          );
        return {
          candidate,
          released: null,
          action: "duplicate-terminal-event-noop",
          mutated: false,
        };
      }
      if (
        outcome === "merged" &&
        before.landingWarrant?.candidateId !== candidate.candidateId
      )
        throw new Error(
          "merged settlement requires the exact active Landing Warrant",
        );
      let released = null;
      const qualificationLease = before.qualificationLeases.find(
        (entry) => entry.candidateId === candidate.candidateId,
      );
      if (qualificationLease) {
        const token = exactRoot(input?.authorityToken, "authorityToken");
        const generation = positiveInteger(
          input?.authorityGeneration,
          "authorityGeneration",
        );
        if (
          token !== qualificationLease.token ||
          generation !== qualificationLease.generation
        )
          throw new Error(
            "terminal settlement qualification authority mismatch",
          );
        state.qualificationLeases = state.qualificationLeases.filter(
          (entry) => entry.candidateId !== candidate.candidateId,
        );
        released = { kind: "qualification-lease", token };
      }
      if (before.landingWarrant?.candidateId === candidate.candidateId) {
        assertDevDeliveryLandingWarrant(
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
        reason: text(verifiedLanding?.reason || input?.reason),
        settledAt: currentTime,
        ...(providerFailureAuthority || {}),
        ...normalizeDevDeliveryTerminalProviderEvidence({
          providerAttempt: before.landingWarrant?.providerAttempt,
          providerTerminalReadbackRoot: verifiedLanding?.readbackRoot,
        }),
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
    providerTerminalReadbackRoot: verifiedLanding?.readbackRoot || null,
    ...(providerFailureAuthority || {}),
    nextAction:
      "Authority is released immediately; select the next eligible candidate.",
  });
  return { ...changed, wake: schedulerWake(changed.state) };
}

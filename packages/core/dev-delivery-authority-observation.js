import { devDeliveryTimestamp as timestamp } from "./dev-delivery-common.js";
import {
  TERMINAL_STATES,
  normalizeDevDeliveryAuthorityState,
  schedulerPolicy,
} from "./dev-delivery-authority-state.js";
import { schedulerWake } from "./dev-delivery-authority-qualification.js";

export function observeDevDeliveryAuthorityState(
  stateInput,
  { now = new Date().toISOString() } = {},
) {
  const state = normalizeDevDeliveryAuthorityState(stateInput);
  const states = {};
  for (const candidate of state.candidates) {
    states[candidate.status] = (states[candidate.status] || 0) + 1;
  }
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
    wake: schedulerWake(state),
    states,
    observedAt: timestamp(now, "now"),
  };
}

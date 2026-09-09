import {
  devDeliveryContentRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import {
  DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA,
  transition,
} from "./dev-delivery-authority-state.js";
import { schedulerWake } from "./dev-delivery-authority-qualification.js";
import { assertDevDeliveryLandingWarrant } from "./dev-delivery-authority-settlement.js";
import { normalizeDevDeliveryProviderAttempt } from "./dev-delivery-provider-attempt.js";

// This transition accepts an already verified provider attempt and is kept
// outside the package export graph. Production callers must enter through the
// live GitHub readback adapter in dev-delivery-authority-landing.js.
export function admitDevDeliveryMergeGroupWithVerifiedProviderAttempt(
  stateInput,
  authorityInput,
  { mergeGroupHead, providerAttempt, now = new Date().toISOString() } = {},
) {
  const currentTime = timestamp(now, "now");
  const exactMergeGroupHead = exactSha(mergeGroupHead, "mergeGroupHead");
  const transaction = transition(
    stateInput,
    (state, before) => {
      const warrant = assertDevDeliveryLandingWarrant(
        before,
        authorityInput,
        currentTime,
      );
      const candidate = state.candidates.find(
        (entry) => entry.candidateId === warrant.candidateId,
      );
      const exactProviderAttempt = normalizeDevDeliveryProviderAttempt(
        providerAttempt,
        {
          repository: before.repository,
          sourceHead: candidate.sourceHead,
          mergeGroupHead: exactMergeGroupHead,
          protectedBase: before.protectedBase,
        },
      );
      if (warrant.mergeGroupHead) {
        if (warrant.mergeGroupHead !== exactMergeGroupHead) {
          throw new Error(
            "Landing Warrant already admitted a different merge-group head",
          );
        }
        if (
          JSON.stringify(warrant.providerAttempt) !==
          JSON.stringify(exactProviderAttempt)
        ) {
          throw new Error(
            "Landing Warrant already admitted a different provider attempt",
          );
        }
        return {
          admission: {
            schema: DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA,
            admitted: true,
            authority: "exclusive-landing-warrant",
            repository: before.repository,
            protectedBase: before.protectedBase,
            candidateId: candidate.candidateId,
            pullRequestNumber: candidate.pullRequestNumber,
            sourceHead: candidate.sourceHead,
            mergeGroupHead: warrant.mergeGroupHead,
            landingWarrantToken: warrant.token,
            landingWarrantGeneration: warrant.generation,
            expectedOldStateRoot: warrant.expectedAdmissionStateRoot,
            admittedAt: warrant.admittedAt,
            providerAttempt: warrant.providerAttempt,
          },
          admissionRoot: warrant.mergeGroupAdmissionRoot,
          action: "duplicate-merge-group-admission-noop",
          mutated: false,
        };
      }
      const admission = {
        schema: DEV_DELIVERY_MERGE_GROUP_ADMISSION_SCHEMA,
        admitted: true,
        authority: "exclusive-landing-warrant",
        repository: before.repository,
        protectedBase: before.protectedBase,
        candidateId: candidate.candidateId,
        pullRequestNumber: candidate.pullRequestNumber,
        sourceHead: candidate.sourceHead,
        mergeGroupHead: exactMergeGroupHead,
        landingWarrantToken: warrant.token,
        landingWarrantGeneration: warrant.generation,
        expectedOldStateRoot: before.stateRoot,
        admittedAt: currentTime,
        providerAttempt: exactProviderAttempt,
      };
      const admissionRoot = devDeliveryContentRoot(admission);
      state.landingWarrant.mergeGroupHead = exactMergeGroupHead;
      state.landingWarrant.mergeGroupAdmissionRoot = admissionRoot;
      state.landingWarrant.expectedAdmissionStateRoot = before.stateRoot;
      state.landingWarrant.admittedAt = currentTime;
      state.landingWarrant.providerAttempt = exactProviderAttempt;
      return {
        admission,
        admissionRoot,
        action: "merge-group-head-admitted",
      };
    },
    currentTime,
  );
  const result = transaction.result;
  return {
    state: transaction.after,
    receipt: result.admission,
    receiptRoot: result.admissionRoot,
    admission: result.admission,
    admissionRoot: result.admissionRoot,
    wake: schedulerWake(transaction.after),
  };
}

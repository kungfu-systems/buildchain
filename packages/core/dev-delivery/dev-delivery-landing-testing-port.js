export const DEV_DELIVERY_TESTING_PROVIDER_READBACK = Symbol(
  "Buildchain dev delivery testing provider readback",
);

export { sealLandingTerminalReadbackForTesting } from "./dev-delivery-landing-terminal-evidence.js";
export { admitDevDeliveryMergeGroupWithVerifiedProviderAttempt as admitDevDeliveryMergeGroupForTesting } from "./dev-delivery-landing-admission-core.js";

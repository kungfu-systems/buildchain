export function lacksExactNativeExecutionContract(
  candidate,
  allowLegacyBaselineReadback = false,
) {
  const native =
    candidate.deliveryClass !== "non-native-fast" ||
    candidate.environmentRoot ||
    candidate.nativeCommandContract;
  return Boolean(
    native &&
    (!candidate.environmentRoot ||
      (!candidate.nativeCommandContract && !allowLegacyBaselineReadback)),
  );
}

export function lacksLiveNativeProof(
  candidate,
  status,
  { allowLegacyV3Readback: legacyReadback = false, allowLegacyBaselineReadback = legacyReadback, allowLegacyQueuedReadback = false } = {},
) {
  return (
    lacksExactNativeExecutionContract(candidate, allowLegacyBaselineReadback) &&
    !(status === "queued" && allowLegacyQueuedReadback) &&
    !TERMINAL_STATES.has(status)
  );
}
const TERMINAL_STATES = new Set([
  "merged",
  "terminal-failure",
  "dequeued",
  "cancelled",
  "superseded",
]);

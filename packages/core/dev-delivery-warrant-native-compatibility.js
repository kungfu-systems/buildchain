export function lacksExactNativeExecutionContract(
  candidate,
  allowLegacyV3Readback = false,
) {
  const native =
    candidate.deliveryClass !== "non-native-fast" ||
    candidate.environmentRoot ||
    candidate.nativeCommandContract;
  return Boolean(
    native &&
    (!candidate.environmentRoot ||
      (!candidate.nativeCommandContract && !allowLegacyV3Readback)),
  );
}

export function lacksLiveNativeProof(
  candidate,
  status,
  { allowLegacyV3Readback = false, allowLegacyQueuedReadback = false } = {},
) {
  return (
    lacksExactNativeExecutionContract(candidate, allowLegacyV3Readback) &&
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

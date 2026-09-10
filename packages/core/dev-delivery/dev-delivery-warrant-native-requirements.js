export function lacksExactNativeExecutionContract(candidate) {
  const native = candidate.deliveryClass !== "non-native-fast" || candidate.environmentRoot || candidate.nativeCommandContract;
  return Boolean(native && (!candidate.environmentRoot || !candidate.nativeCommandContract));
}
export function lacksLiveNativeProof(candidate) {
  return lacksExactNativeExecutionContract(candidate);
}

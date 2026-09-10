import { normalizeGateEnvironment } from "./contracts.js";
export function gateEnvironment({
  base,
  shared = {},
  platform = {},
  cacheProfileRef,
  cacheProfileDigest,
}) {
  return {
    ...base,
    ...normalizeGateEnvironment(shared, "gate-environment-json"),
    ...normalizeGateEnvironment(platform, "gate matrix entry environment"),
    ...(cacheProfileRef ? { SHIFU_CACHE_PROFILE_REF: cacheProfileRef } : {}),
    ...(cacheProfileDigest
      ? { SHIFU_CACHE_PROFILE_DIGEST: cacheProfileDigest }
      : {}),
  };
}

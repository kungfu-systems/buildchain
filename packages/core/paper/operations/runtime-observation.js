import {
  buildchainPackageIdentity,
  runtimeContractWorld,
  resolvePaperRuntimeGitSha,
} from "./runtime.js";
export function runtimeFacts({
  buildchainRoot,
  buildchainVersion,
  buildchainRef,
  buildchainSha,
}) {
  const identity = buildchainPackageIdentity(buildchainRoot, buildchainVersion);
  const contractWorld = runtimeContractWorld(buildchainRoot);
  return {
    version: identity.version,
    ref: buildchainRef,
    resolvedSha:
      buildchainSha ||
      resolvePaperRuntimeGitSha(buildchainRoot, identity.version),
    contract: contractWorld.contract,
    contractDigest: contractWorld.contractDigest,
    compatibilityDigest: contractWorld.compatibilityDigest,
    majorLine: contractWorld.majorLine,
  };
}

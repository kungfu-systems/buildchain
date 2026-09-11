import { exactSha, positiveInteger, jsonList } from "../warrant/values.js";
export function nativeCandidateRequest(request, { repository, branch }) {
  const leaseSeconds = positiveInteger(
    request["warrant-lease-seconds"] || 3600,
    "leaseSeconds",
  );
  const heartbeatSeconds = positiveInteger(
    request["native-heartbeat-seconds"] ||
      Math.max(15, Math.floor(leaseSeconds / 3)),
    "heartbeatSeconds",
  );
  if (heartbeatSeconds >= leaseSeconds)
    throw new Error("heartbeatSeconds must be less than leaseSeconds");
  return {
    repository,
    branch,
    pullRequestNumber: positiveInteger(
      request["expected-pr-number"],
      "pullRequestNumber",
    ),
    expectedHead: exactSha(request["expected-head-sha"], "expectedHead"),
    sourceIdentityRoot: request["source-identity-root"],
    sourcePatchRoot: request["source-patch-root"],
    planRoot: request["plan-root"],
    closureRoot: request["closure-root"],
    dependencyRoot: request["dependency-root"],
    toolchainRoot: request["toolchain-root"],
    environmentRoot: request["environment-root"],
    affectedPaths: jsonList(request["affected-paths-json"], "affectedPaths"),
    shardEvidenceRoots: jsonList(
      request["shard-evidence-roots-json"],
      "shardEvidenceRoots",
    ),
    nativeCommand: request["native-command"],
    leaseSeconds,
    heartbeatSeconds,
    wakeEventType: "buildchain-dev-delivery-wake",
  };
}

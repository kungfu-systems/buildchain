export function deliverySubmissionRequest(
  input,
  { repository, branch, sourceProofRoot, affectedPaths },
) {
  if (!input["environment-root"] && input["native-command"])
    throw new Error("Native command requires an exact environment root");
  return {
    repository,
    branch,
    pullRequestNumber: Number(input["expected-pr-number"]),
    sourceHead: input["expected-head-sha"],
    sourceRoot: input["source-root"],
    sourceIdentityRoot: input["source-identity-root"],
    sourcePatchRoot: input["source-patch-root"],
    sourceProofRoot,
    planRoot: input["plan-root"],
    closureRoot: input["closure-root"],
    dependencyRoot: input["dependency-root"],
    toolchainRoot: input["toolchain-root"],
    affectedPaths: JSON.stringify(affectedPaths),
    shardEvidenceRoots: input["shard-evidence-roots-json"],
    deliveryClass: input["delivery-class"],
    priority: input["delivery-priority"],
    ...(input["environment-root"]
      ? {
          environmentRoot: input["environment-root"],
          nativeCommand: input["native-command"] || "",
        }
      : {}),
    ...(input["native-command-root"]
      ? { nativeCommandRoot: input["native-command-root"] }
      : {}),
    ...(input["release-blocker-priority-json"]
      ? { releaseBlockerPriority: input["release-blocker-priority-json"] }
      : {}),
    ...(Number(input["source-workflow-run-id"]) > 0
      ? { sourceWorkflowRunId: Number(input["source-workflow-run-id"]) }
      : {}),
    execute: input["delivery-warrant-mode"] === "required",
  };
}

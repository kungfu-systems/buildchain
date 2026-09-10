import {
  text,
  bool,
  autoMergeMethod,
  repository,
  branch,
  workflowPath,
  integer,
  pullRequestBodyPrefix,
  optionalExactSha,
  optionalStateRoot,
} from "./values.js";
export function normalizeDevAlphaPatrolOptions(options = {}) {
  const createPullRequest = bool(options.createPullRequest, false);
  return {
    repository: repository(options.repository),
    sourceBranch: branch(options.sourceBranch, "sourceBranch"),
    targetBranch: branch(options.targetBranch, "targetBranch"),
    devWorkflowPath: workflowPath(options.devWorkflowPath, "devWorkflowPath"),
    alphaWorkflowPath: workflowPath(
      options.alphaWorkflowPath,
      "alphaWorkflowPath",
    ),
    maxAgeSeconds: integer(options.maxAgeSeconds, 7 * 24 * 60 * 60),
    pullRequestBodyPrefix: pullRequestBodyPrefix(options.pullRequestBodyPrefix),
    expectedSelectedSha: optionalExactSha(
      options.expectedSelectedSha,
      "expectedSelectedSha",
    ),
    expectedPriorStateRoot: optionalStateRoot(
      options.expectedPriorStateRoot,
      "expectedPriorStateRoot",
    ),
    expectedCutRoot: optionalStateRoot(
      options.expectedCutRoot,
      "expectedCutRoot",
    ),
    cutCreatedAt: text(options.cutCreatedAt),
    requireActiveReleaseTrain: bool(options.requireActiveReleaseTrain, true),
    buildchainRuntimeSha: optionalExactSha(
      options.buildchainRuntimeSha,
      "buildchainRuntimeSha",
    ),
    reactivationAuthorized: bool(options.reactivationAuthorized, false),
    transitionAuthority: {
      actor: text(options.transitionAuthority?.actor),
      workflow: text(options.transitionAuthority?.workflow),
      runId: text(options.transitionAuthority?.runId),
      runAttempt: text(options.transitionAuthority?.runAttempt),
    },
    createPullRequest,
    settlementAuthorized: bool(options.settlementAuthorized, createPullRequest),
    autoMerge: bool(options.autoMerge, false),
    mergeMethod: autoMergeMethod(options.mergeMethod),
    dryRun: bool(options.dryRun, true),
    now: text(options.now) || new Date().toISOString(),
    outputPath:
      text(options.outputPath) || ".buildchain/patrol/dev-alpha-candidate.json",
  };
}

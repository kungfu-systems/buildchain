import { resolveReleaseCandidateArtifacts } from "../candidate/resolve.js";
import { resumeFromCandidateRun } from "../recovery/candidate.js";
export async function qualifyPromotionCandidate(
  {
    request,
    intent,
    repository,
    runtimeSha,
    runtimeRoot,
    outputDir,
    token,
    apiUrl,
    recoveryRunId,
    recoveryRunAttempt,
  },
  {
    fresh = resolveReleaseCandidateArtifacts,
    recover = resumeFromCandidateRun,
  } = {},
) {
  const shared = {
    token,
    apiUrl,
    artifactName: request["artifact-name"],
    artifactPatterns: request["artifact-patterns"],
    requiredArtifactCount: request["required-artifact-count"],
    publishArtifactKind: request["publish-artifact-kind"],
    publishPackageMain: request["publish-package-main"],
    runtimeSha,
    outputDir,
  };
  if (request["resume-candidate-run-id"])
    return recover({
      ...shared,
      repository: request["resume-candidate-repository"],
      targetRepository: repository,
      candidateRunId: request["resume-candidate-run-id"],
      expectedWorkflowFile:
        request["resume-expected-workflow-file"] ||
        request["release-candidate-workflow-file"],
      expectedWorkflowName:
        request["resume-expected-workflow-name"] ||
        request["release-candidate-workflow-name"],
      channel: request["promotion-publication-channel"] || intent.channel,
      targetRef: intent["target-ref"],
      targetSha: intent["requested-sha"],
      expectedSourceTree: request["resume-expected-source-tree"],
      expectedCandidateRoot: request["resume-expected-candidate-root"],
      candidateRuntimeSha: request["resume-expected-candidate-runtime-sha"],
      runtimeSha: request["resume-buildchain-runtime-sha"],
      transactionId: request["resume-transaction-id"],
      rematerializeOnResume: request["publish-rematerialize-on-resume"],
      releasePatterns: request["github-release-payload-patterns"],
      runtimeRoot,
      recoveryRunId,
      recoveryRunAttempt,
      authorizationJson: request["promotion-runtime-authorization-json"],
      authorizationRoot: request["promotion-runtime-authorization-root"],
    });
  return fresh({
    ...shared,
    repository,
    targetRef: intent["target-ref"],
    targetSha: intent["requested-sha"],
    workflowFile: request["release-candidate-workflow-file"],
    workflowName: request["release-candidate-workflow-name"],
    githubReleasePayloadPatterns: request["github-release-payload-patterns"],
    waitSeconds: request["release-candidate-wait-seconds"],
    download: true,
  });
}

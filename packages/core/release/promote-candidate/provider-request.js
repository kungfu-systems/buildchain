import { read } from "./files.js";
import path from "node:path";
export function productProviderRequest({
  request,
  actor,
  runId,
  octokit,
  mutationOctokit,
  repository,
  targetRef,
  targetSha,
  candidate,
  candidatePassportPath,
  buildSummaryPath,
  qualification,
  providerInputs,
}) {
  return {
    octokit,
    mutationOctokit,
    repository,
    targetRef,
    targetSha,
    candidate,
    candidatePassportPath,
    buildSummaryPath,
    qualification,
    requiredStatusCheck: request["required-status-check"] || "check",
    registryToken: request["token"],
    publishCommand: request["publish-command"],
    sealedBundleRoot: providerInputs.sealedBundleRoot,
    sealedBundleManifest: providerInputs.sealedBundleManifest,
    requiredArtifactsPath: providerInputs.requiredArtifactsPath,
    publishMode: request["publish-mode"],
    publishAuth: request["publish-auth"] || "trusted-publishing",
    publishDistTag: request["publish-dist-tag"],
    publishPackageSetOrder:
      request["publish-package-set-order"] || "as-provided",
    publishPackageMain: providerInputs.publishPackageMain,
    releaseCandidateRecoveryReceiptPath:
      providerInputs.releaseCandidateRecoveryReceiptPath || "",
    publishRematerializeOnResume:
      request["publish-rematerialize-on-resume"] === true,
    publishTransactionOverride:
      request["publish-transaction-override"] === true,
    expectedTransactionId: request["resume-transaction-id"],
    publicationIntent: read(request["product-publication-intent-path"]),
    actor: actor,
    runId: runId,
  };
}

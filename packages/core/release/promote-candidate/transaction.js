import {
  resolveCandidateBuildSummaryPath,
  resolveCandidateProviderInputs,
  resolvePublicationTarget,
} from "./evidence-inputs.js";
import {
  assertCandidateEvidenceBinding,
  canonicalChannel,
  observeProtectedPublicationSource,
} from "./evidence-binding.js";
import { productProviderRequest } from "./provider-request.js";
import { createReleaseDocuments } from "./release-documents.js";
import { applyAndSettle } from "./provider-settlement.js";
import { read } from "./files.js";
import { candidatePublicationOutputs } from "./outputs.js";
import { completePublicationDevelopment } from "./publication-completion.js";
import {
  activateExactPnpm,
  planProductPublication,
} from "./product-provider.js";
import path from "node:path";
export async function promoteReleaseCandidate(
  request,
  { octokit, mutationOctokit, actor, runId, observe = () => {} },
) {
  const repository = request["repository"];
  const declaredSourceSha = request["source-sha"];
  const fallbackVersion = request["version"];
  const fallbackTag = request["tag"];
  const channel = request["channel"];
  const expectedTransactionId = request["resume-transaction-id"];
  const candidatePassportPath = request["candidate-passport-path"];
  const buildSummaryPath = resolveCandidateBuildSummaryPath({
    declaredPath: request["candidate-build-summary-path"],
  });
  const candidate = read(candidatePassportPath);
  const stageCapsules = read(request["stage-capsules-path"]);
  const qualification = read(request["publication-qualification-path"]);
  const token = request["token"];
  const publicationTarget = resolvePublicationTarget({
    recoveryReceiptPath: request["recovery-receipt-path"],
    candidate,
    repository,
    channel,
    sourceSha: declaredSourceSha,
    targetRef: request["target-ref"],
    targetSha: request["target-sha"],
    expectedTransactionId,
  });
  const sourceSha = publicationTarget.sourceSha;
  assertCandidateEvidenceBinding({ candidate, stageCapsules, repository });
  const sourceBinding = await observeProtectedPublicationSource({
    octokit,
    repository,
    protectedSourceSha: sourceSha,
    candidate,
  });
  const providerInputs = resolveCandidateProviderInputs({
    recoveryReceiptPath: request["recovery-receipt-path"],
    artifactKind: request["publish-artifact-kind"] || "npm",
    sealedBundleRoot: request["sealed-bundle-root"],
    sealedBundleManifest: request["sealed-bundle-manifest"],
    requiredArtifactsPath: request["required-artifacts-path"],
    publishPackageMain: request["publish-package-main"],
  });
  const providerRequest = productProviderRequest({
    request,
    actor,
    runId,
    octokit,
    mutationOctokit,
    repository,
    targetRef: publicationTarget.targetRef,
    targetSha: publicationTarget.targetSha,
    candidate,
    candidatePassportPath,
    buildSummaryPath,
    qualification,
    providerInputs,
  });
  const publicationPlan = await planProductPublication(providerRequest, {
    fallbackVersion,
    fallbackTag,
  });
  const documents = await createReleaseDocuments({
    request,
    actor,
    runId,
    repository,
    sourceSha,
    fallbackVersion,
    channel,
    candidate,
    stageCapsules,
    qualification,
    sourceBinding,
    publicationPlan,
    publicationIntent: providerRequest.publicationIntent,
    octokit,
  });
  activateExactPnpm();
  const settlement = await applyAndSettle({
    request,
    actor,
    runId,
    repository,
    sourceSha,
    channel,
    qualification,
    octokit,
    providerRequest,
    publicationPlan,
    documents,
  });
  await completePublicationDevelopment({
    repository,
    sourceSha,
    token,
    channel: canonicalChannel(channel),
    settlement,
    documents,
    sourceBinding,
    providerRequest,
    octokit,
    mutationOctokit,
  });
  const outputs = candidatePublicationOutputs(documents, settlement);
  observe(outputs);
  return { documents, settlement, outputs };
}

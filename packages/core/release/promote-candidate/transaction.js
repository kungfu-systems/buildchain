import { prepareCandidatePublication } from "./preparation.js";
import { applyAndSettle } from "./provider-settlement.js";
import { candidatePublicationOutputs } from "./outputs.js";
import { completePublicationDevelopment } from "./publication-completion.js";
import {
  readApplyDocuments,
  verifyPublicationSettlement,
} from "../../publication/settlement/transaction.js";
import { canonicalChannel } from "./evidence-binding.js";
import { activateExactPnpm } from "./product-provider.js";

export async function promoteReleaseCandidate(
  request,
  {
    octokit,
    mutationOctokit,
    actor,
    runId,
    observe = () => {},
    observeNode = (_node, effect) => effect(),
  },
) {
  const context = await observeNode("qualification", async () => {
    const prepared = await prepareCandidatePublication(request, {
      octokit,
      mutationOctokit,
      actor,
      runId,
    });
    if (request.retainRecoveryMaterials)
      await request.retainRecoveryMaterials();
    return prepared;
  });
  const {
    repository,
    sourceSha,
    token,
    channel,
    qualification,
    providerRequest,
    publicationPlan,
    documents,
    sourceBinding,
  } = context;
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
    observeNode,
  });
  await observeNode("next-development", () =>
    completePublicationDevelopment({
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
    }),
  );
  const outputs = candidatePublicationOutputs(documents, settlement);
  await observeNode(
    "settlement",
    async () =>
      verifyPublicationSettlement(readApplyDocuments(".buildchain"), {
        repository,
        tag: documents.tag,
        sourceSha: settlement.productProviderResult.publication.releaseSha,
        candidateSha: sourceSha,
      }),
    (status) => status,
  );
  observe(outputs);
  return { documents, settlement, outputs };
}

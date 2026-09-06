import fs from "node:fs";
import { settlePublication } from "../../scripts/v4-publication-settlement.mjs";
import { releaseAssetClient } from "../../scripts/release-asset-client.mjs";
import { advanceAlphaNextDevelopment } from "./product-provider.js";

export async function completePublicationDevelopment(
  {
    repository,
    sourceSha,
    token,
    channel,
    settlement,
    documents,
    sourceBinding,
    providerRequest,
    octokit,
    mutationOctokit,
  },
  {
    retain = settlePublication,
    client = releaseAssetClient,
    advance = advanceAlphaNextDevelopment,
    write = (file, value) =>
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`),
  } = {},
) {
  // Binary collection and independent review must not wait for the development PR.
  await retain({
    base: ".buildchain",
    repository,
    candidateSha: sourceSha,
    client: client(repository, { token }),
    applyOutcome: "pending",
  });
  if (channel !== "alpha") return;
  const nextDevelopment = await advance({
    repository,
    completedAlpha: {
      outcome: "succeeded",
      version: documents.version,
      exactTag: documents.tag,
      releaseSha: settlement.productProviderResult.publication.releaseSha,
      treeSha: sourceBinding.protectedSource.tree,
      publicationRoot: settlement.releaseReceipt.receiptRoot,
      completedAt: providerRequest.publicationIntent.sourceTimestamp,
    },
    octokit,
    mutationOctokit,
  });
  write(
    ".buildchain/release-tail/next-development-controller.json",
    nextDevelopment,
  );
}

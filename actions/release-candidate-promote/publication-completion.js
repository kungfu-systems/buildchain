import fs from "node:fs";
import { settlePublication } from "../../scripts/publication-settlement.mjs";
import { releaseAssetClient } from "../../scripts/release-asset-client.mjs";
import { advanceAlphaNextDevelopment, advanceStableNextDevelopment } from "./product-provider.js";

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
    advanceStable = advanceStableNextDevelopment,
    write = (file, value) =>
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`),
  } = {},
) {
  // Binary collection and independent review must not wait for the development PR.
  const retained = await retain({
    base: ".buildchain",
    repository,
    candidateSha: sourceSha,
    client: client(repository, { token }),
    applyOutcome: "pending",
  });
  if (!["alpha", "release", "stable"].includes(channel)) return;
  const stable = channel !== "alpha";
  const nextDevelopment = await (stable ? advanceStable : advance)({
    repository,
    [stable ? "completedStable" : "completedAlpha"]: {
      outcome: "succeeded",
      version: documents.version,
      exactTag: documents.tag,
      releaseSha: settlement.productProviderResult.publication.releaseSha,
      treeSha: sourceBinding.protectedSource.tree,
      publicationRoot: retained.receipt.receiptRoot,
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

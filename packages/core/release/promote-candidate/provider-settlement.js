import { write } from "./files.js";
import { publishGitHubReleaseEvidence } from "../github-release.js";
import {
  RELEASE_RECEIPT_CONTRACT,
  createReleaseReceipt,
} from "../release-invocation.js";
import { applyProductPublication } from "./product-provider.js";
import path from "node:path";
export async function applyAndSettle({
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
}) {
  let productProviderResult;
  try {
    productProviderResult = await applyProductPublication(
      providerRequest,
      documents.productPublicationPlan,
    );
  } catch (error) {
    if (error.providerProjection)
      write(
        ".buildchain/release-tail/product-provider-result.json",
        error.providerProjection,
      );
    throw error;
  }
  const productProviderPath = write(
    ".buildchain/release-tail/product-provider-result.json",
    productProviderResult,
  );
  const result = await publishGitHubReleaseEvidence({
    octokit,
    repository,
    sourceSha: productProviderResult.promotedSha,
    version: documents.version,
    tag: documents.tag,
    channel,
    publishEvidencePath: documents.evidencePath,
    releasePassportPath: documents.passportPath,
    releasePassportOutputDir: path.dirname(documents.passportPath),
    additionalAssetPaths: [
      ...request["artifact-paths"],
      ...(providerRequest.publicationIntent.artifactKind === "oci"
        ? [".buildchain/release-tail/oci-publication-readback.json"]
        : []),
    ],
    statePath: request["state-path"] || ".buildchain/release-tail/state.json",
    qualificationRoot: qualification.receiptRoot,
    failureAfterCapability: request["failure-after-capability"],
  });
  const releaseReceipt = createReleaseReceipt({
    schema: RELEASE_RECEIPT_CONTRACT,
    transactionRoot: documents.releaseTransaction.transactionRoot,
    outcome: "complete",
    releasePassportRoot: documents.passport.passportRoot,
    providerTransactionRoot: result.transaction.transactionRoot,
    providerStateRoot: result.transaction.stateRoot,
    providerReceiptRoots: [
      productProviderResult.root,
      ...result.transaction.receipts.map(({ receiptRoot }) => receiptRoot),
    ].sort(),
  });
  const releaseReceiptPath = write(
    ".buildchain/release-tail/release-receipt.json",
    { ...releaseReceipt.receipt, receiptRoot: releaseReceipt.receiptRoot },
  );
  return {
    productProviderPath,
    productProviderResult,
    releaseReceipt,
    releaseReceiptPath,
    result,
  };
}

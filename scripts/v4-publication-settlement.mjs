import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createV4ReleaseInvocation,
  createV4ReleaseReceipt,
  createV4ReleaseTransaction,
} from "../packages/core/v4-release-invocation.js";
import {
  releaseTailRoot,
  validateReleaseTailTransaction,
} from "../packages/core/release-tail-provider-plane.js";

export const SETTLEMENT_ASSET = "buildchain-publication-settlement.json";

export function verifyPublicationSettlement(
  documents,
  { repository, tag, sourceSha, publicPassport, candidateSha } = {},
) {
  const {
    invocation,
    transaction,
    receipt,
    passport,
    product,
    providerState,
    productState,
  } = documents;
  const projected = createV4ReleaseInvocation(invocation);
  const roots = createV4ReleaseTransaction({
    invocationRoot: projected.roots.invocationRoot,
    publisherRoot: projected.roots.publisherRoot,
    runtimeRoot: projected.roots.runtimeRoot,
    providerRoot: projected.roots.providerRoot,
    parentRoot: projected.roots.parentRoot,
  });
  const { receiptRoot, ...receiptBody } = receipt;
  const { passportRoot, ...passportBody } = passport;
  const { root: productRoot, ...productBody } = product;
  if (
    !validateReleaseTailTransaction(providerState).valid ||
    !validateReleaseTailTransaction(productState).valid
  )
    throw new Error("invalid provider transaction state");
  if (
    releaseTailRoot(transaction) !==
      releaseTailRoot({
        ...roots.transaction,
        transactionRoot: roots.transactionRoot,
      }) ||
    createV4ReleaseReceipt(receiptBody).receiptRoot !== receiptRoot ||
    receipt.transactionRoot !== roots.transactionRoot ||
    receipt.outcome !== "complete" ||
    passportRoot !== releaseTailRoot(passportBody) ||
    receipt.releasePassportRoot !== passportRoot ||
    productRoot !== releaseTailRoot(productBody) ||
    !receipt.providerReceiptRoots.includes(productRoot) ||
    receipt.providerTransactionRoot !== providerState.transactionRoot ||
    receipt.providerStateRoot !== providerState.stateRoot ||
    providerState.state !== "complete" ||
    productState.state !== "complete" ||
    product.transaction.stateRoot !== productState.stateRoot ||
    product.transaction.transactionRoot !== productState.transactionRoot ||
    productState.transactionRoot !== roots.transactionRoot ||
    providerState.receipts.some(
      ({ receiptRoot: root }) => !receipt.providerReceiptRoots.includes(root),
    )
  )
    throw new Error("terminal publication receipt lineage does not verify");
  verifyPublicationCoordinates(documents, {
    repository,
    tag,
    sourceSha,
    publicPassport,
    candidateSha,
  });
  return { publication: "complete", receiptRoot, sourceSha, tag, repository };
}

function verifyPublicationCoordinates(
  { invocation, passport, product },
  { repository, tag, sourceSha, publicPassport, candidateSha },
) {
  if (
    invocation.candidate.repository !== repository ||
    (candidateSha && invocation.candidate.commit !== candidateSha) ||
    passport.repository !== repository ||
    invocation.provider.repository !== repository ||
    invocation.target.tag !== tag ||
    passport.release.tag !== tag ||
    passport.release.version !== tag.replace(/^v/u, "") ||
    product.publication.exactTag !== tag ||
    product.publication.version !== passport.release.version ||
    product.publication.releaseSha !== sourceSha ||
    product.publication.state !== "complete" ||
    product.publication.finalizationNeeded ||
    passport.source.headSha !== invocation.candidate.commit ||
    passport.source.treeHash !== invocation.candidate.tree ||
    passport.policyDigest !== invocation.authority.policyRoot ||
    passport.publicationQualificationRoot !==
      invocation.authority.qualificationRoot ||
    (publicPassport &&
      releaseTailRoot(publicPassport) !== releaseTailRoot(passport))
  )
    throw new Error(
      "publication evidence does not match exact provider release coordinates",
    );
}

export function readApplyDocuments(base) {
  const read = (relative) =>
    JSON.parse(fs.readFileSync(path.join(base, relative)));
  return {
    invocation: read("release-tail/release-invocation.json"),
    transaction: read("release-tail/release-transaction.json"),
    receipt: read("release-tail/release-receipt.json"),
    product: read("release-tail/product-provider-result.json"),
    providerState: read("release-tail/state.json"),
    productState: read("release-tail/product-provider-transaction.json"),
    passport: read("release-passport/buildchain.release.json"),
  };
}

export async function settlePublication({
  base,
  client,
  applyOutcome,
  repository,
  candidateSha,
}) {
  const documents = readApplyDocuments(base);
  if (
    documents.invocation.candidate.repository !== repository ||
    (candidateSha && documents.invocation.candidate.commit !== candidateSha)
  )
    throw new Error(
      "publication settlement does not match the admitted repository and candidate",
    );
  const tag = documents.invocation.target.tag;
  const release = client.release(tag);
  const sourceSha = client.json(
    `repos/${repository}/commits/${encodeURIComponent(tag)}`,
  ).sha;
  const matches = release.assets.filter(
    ({ name }) => name === "buildchain.release.json",
  );
  if (matches.length !== 1)
    throw new Error(
      "exact public publication passport is missing or ambiguous",
    );
  const publicPassport = JSON.parse(client.assetBytes(matches[0]));
  const status = verifyPublicationSettlement(documents, {
    repository,
    tag,
    sourceSha,
    publicPassport,
  });
  // Publication completion is immutable; next-development and distribution progress stay separate.
  const settlement = {
    schemaVersion: 1,
    contract: "buildchain-v4-publication-settlement/v1",
    id: "v4-publication",
    release: { sourceSha, tag, channel: documents.invocation.target.channel },
    documents,
  };
  const file = path.join(base, "release-tail", SETTLEMENT_ASSET);
  client.write(file, settlement);
  await client.publish(release, [file]);
  const summary = {
    ...status,
    nextDevelopment: applyOutcome === "success" ? "advanced" : "incomplete",
    binaryDistribution: "pending-provider-readback",
  };
  client.write(
    path.join(base, "release-tail", "delivery-summary.json"),
    summary,
  );
  return { summary, receipt: documents.receipt };
}

async function main() {
  const { releaseAssetClient } = await import("./release-asset-client.mjs");
  const repository = process.env.GITHUB_REPOSITORY;
  const result = await settlePublication({
    base: process.argv[2],
    client: releaseAssetClient(repository),
    repository,
    candidateSha: process.env.CANDIDATE_SHA,
    applyOutcome: process.env.APPLY_OUTCOME,
  });
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `receipt-json=${JSON.stringify(result.receipt)}\nreceipt-root=${result.receipt.receiptRoot}\nstatus=complete\n`,
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Publication: **complete**, receipt \`${result.receipt.receiptRoot}\`. Next development: **${result.summary.nextDevelopment}**. Binary distribution: **pending provider readback**.\n`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

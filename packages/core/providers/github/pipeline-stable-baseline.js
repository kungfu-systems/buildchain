import { recordDigest } from "../../release/discussion/envelope.js";
import {
  SETTLEMENT_ASSET,
  verifyPublicationSettlement,
} from "../../publication/settlement/transaction.js";
import { readReleaseEvidenceAssets } from "./release-evidence-assets.js";

// Earlier publications materialized the floating entry after the exact tag.
// Only their completed immutable settlement can bind those two commits.
export async function readPipelineStableBaseline(plan, host, release, prior) {
  if ((prior?.commit || null) === plan.previousChannelCommit) return null;
  if (!release || !prior || !plan.previousChannelCommit)
    throw new Error(
      "Stable comparison differs from the retained published channel",
    );
  const evidence = await readReleaseEvidenceAssets(host, release, [
    SETTLEMENT_ASSET,
    "buildchain.release.json",
  ]);
  if (evidence.status !== "present")
    throw new Error(
      "Stable channel differs without a completed publication settlement",
    );
  const read = (name) =>
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(evidence.values[name]),
    );
  const settlement = read(SETTLEMENT_ASSET),
    publicPassport = read("buildchain.release.json"),
    repository = plan.source.repository,
    tag = release.tag,
    sourceSha = prior.commit;
  if (
    settlement.schemaVersion !== 1 ||
    settlement.contract !== "buildchain-v4-publication-settlement/v1" ||
    settlement.release?.tag !== tag ||
    settlement.release?.sourceSha !== sourceSha ||
    settlement.release?.channel !== "stable"
  )
    throw new Error(
      "Stable baseline settlement has different release coordinates",
    );
  const verified = verifyPublicationSettlement(settlement.documents, {
    repository,
    tag,
    sourceSha,
    publicPassport,
  });
  const { product, providerState, productState, invocation, passport } =
    settlement.documents;
  const ref = `refs/tags/v${plan.version.split(".")[0]}`,
    updates = product.updates.filter((value) => value.ref === ref);
  const subject = {
    repository,
    sourceSha,
    tag,
    version: tag.slice(1),
    channel: "stable",
  };
  if (
    invocation.target.channel !== "stable" ||
    passport.release.channel !== "stable" ||
    product.promotedSha !== plan.previousChannelCommit ||
    updates.length !== 1 ||
    updates[0].action !== "converged-release-tag" ||
    updates[0].sha !== plan.previousChannelCommit ||
    recordDigest(productState.subject) !== recordDigest(subject) ||
    recordDigest(providerState.subject) !==
      recordDigest({
        ...subject,
        sourceSha: plan.previousChannelCommit,
      })
  )
    throw new Error(
      "Stable baseline settlement does not bind the retained floating channel",
    );
  return {
    releaseId: release.id,
    tag,
    sourceSha,
    channelRef: ref,
    channelCommit: plan.previousChannelCommit,
    receiptRoot: verified.receiptRoot,
    assets: evidence.assets,
  };
}

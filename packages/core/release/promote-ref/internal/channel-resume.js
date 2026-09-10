import { readDurableReleaseTransaction } from "./durable-transaction-store.js";
import { releaseTransactionStateRef } from "../../publish-transaction.js";
import { notFound } from "./github-adapter.js";
import { stripTagPrefix } from "./promotion-policy.js";
import { parseAlphaPrereleaseRef } from "./tag-selection.js";
import {
  transactionHasPublishedMaterial,
  releaseCommitIncludesTransactionHead,
  releaseCommitMatchesTransactionMaterial,
} from "./transaction-recovery.js";
import { parseReleaseTransactionStateRef } from "./channel-tags.js";
export async function readDurableTransactionForVersion({
  octokit,
  owner,
  repo,
  version,
}) {
  if (!version) {
    return undefined;
  }
  try {
    return await readDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      stateRef: releaseTransactionStateRef(version),
    });
  } catch (error) {
    const message = error?.message || "";
    if (
      notFound(error) ||
      /missing state\.json|getTree is not a function/i.test(message)
    ) {
      return undefined;
    }
    throw error;
  }
}
export async function resumableAlphaTransactionState({
  octokit,
  owner,
  repo,
  cwd,
  refs,
  releasePrefix,
  targetRef,
  sourceSha,
  expectedVersion = "",
}) {
  const candidates = refs
    .map((ref) => parseAlphaPrereleaseRef(ref.ref, releasePrefix))
    .filter((ref) => ref?.source === "release-state")
    .filter(
      (ref) => !expectedVersion || stripTagPrefix(ref.tag) === expectedVersion,
    )
    .sort((a, b) => b.patch - a.patch || b.prerelease - a.prerelease);
  for (const candidate of candidates) {
    const version = stripTagPrefix(candidate.tag);
    let transaction;
    try {
      transaction = await readDurableReleaseTransaction({
        octokit,
        owner,
        repo,
        stateRef: releaseTransactionStateRef(version),
      });
    } catch (error) {
      const message = error?.message || "";
      if (notFound(error) || /missing state\.json/i.test(message)) {
        continue;
      }
      throw error;
    }
    const publishedMaterial = transactionHasPublishedMaterial(transaction);
    const exactTransactionSource = [
      transaction?.source_sha,
      transaction?.release_sha,
      transaction?.release_material_sha,
    ].includes(sourceSha);
    const includesTransactionHead = (transactionReleaseSha) =>
      releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha: sourceSha,
        transactionReleaseSha,
      });
    const transactionInSourceHistory =
      !publishedMaterial &&
      ((await includesTransactionHead(transaction?.release_sha)) ||
        (await includesTransactionHead(transaction?.release_material_sha)));
    const publishedMaterialMerge =
      publishedMaterial &&
      (await releaseCommitMatchesTransactionMaterial({
        octokit,
        owner,
        repo,
        releaseSha: sourceSha,
        transactionReleaseShas: [
          transaction?.release_sha,
          transaction?.release_material_sha,
        ],
      }));
    const exactCompletedTransaction =
      transaction?.state === "complete" && exactTransactionSource;
    if (
      transaction &&
      (!expectedVersion || transaction.version === expectedVersion) &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["abandoned", "failed_permanently"].includes(transaction.state) &&
      (exactCompletedTransaction ||
        (transaction.state !== "complete" &&
          (exactTransactionSource ||
            transactionInSourceHistory ||
            publishedMaterialMerge)))
    ) {
      return {
        ...candidate,
        version,
        transaction,
      };
    }
  }
  return undefined;
}
export async function resumableReleaseTransactionState({
  octokit,
  owner,
  repo,
  refs,
  releasePrefix,
  targetRef,
  sourceSha,
  expectedVersion = "",
}) {
  const candidates = refs
    .map((ref) => parseReleaseTransactionStateRef(ref.ref, releasePrefix))
    .filter(Boolean)
    .sort((a, b) => b.patch - a.patch);
  for (const candidate of candidates) {
    const version = stripTagPrefix(candidate.tag);
    let transaction;
    try {
      transaction = await readDurableReleaseTransaction({
        octokit,
        owner,
        repo,
        stateRef: releaseTransactionStateRef(version),
      });
    } catch (error) {
      const message = error?.message || "";
      if (notFound(error) || /missing state\.json/i.test(message)) {
        continue;
      }
      throw error;
    }
    const exactTransactionSource =
      transaction?.source_sha === sourceSha ||
      transaction?.release_sha === sourceSha ||
      transaction?.release_material_sha === sourceSha;
    const transactionInSourceHistory =
      !transactionHasPublishedMaterial(transaction) &&
      ((await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha: sourceSha,
        transactionReleaseSha: transaction?.release_sha,
      })) ||
        (await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: sourceSha,
          transactionReleaseSha: transaction?.release_material_sha,
        })));
    const exactCompletedTransaction =
      transaction?.state === "complete" && exactTransactionSource;
    if (
      transaction &&
      (!expectedVersion || transaction.version === expectedVersion) &&
      transaction.target_ref === targetRef &&
      transaction.exact_tag === candidate.tag &&
      !["abandoned", "failed_permanently"].includes(transaction.state) &&
      (exactCompletedTransaction ||
        (transaction.state !== "complete" &&
          (exactTransactionSource || transactionInSourceHistory)))
    ) {
      return {
        ...candidate,
        version,
        transaction,
      };
    }
  }
  return undefined;
}

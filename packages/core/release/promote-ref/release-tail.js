import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  publishGitHubReleaseEvidence,
  recoverCompleteGitHubReleaseEvidence,
  recoveryCompletedBeforeThisRun,
} from "../github-release.js";
import { recordGitHubReleaseTransactionCompletion } from "./internal/publish-transaction.js";
import { releaseCandidateRecoveryReceiptPath } from "./action-environment.js";
export async function publishReleaseTail({
  enabled,
  dryRun,
  releaseTailStatePath,
  result,
  octokit,
  token,
  sha,
  artifactPaths,
  targetRef,
} = {}) {
  if (!enabled || dryRun) return null;
  const releaseComplete = result.publishTransaction?.state === "complete";
  const finalizationComplete =
    result.publishTransaction?.finalizationNeeded !== true;
  if (!releaseComplete || !finalizationComplete) {
    core.info(
      `github-release=true is waiting for a complete release transaction before creating or updating the public GitHub Release; transaction-state=${result.publishTransaction?.state || ""} finalization-needed=${result.publishTransaction?.finalizationNeeded === true}`,
    );
    return null;
  }
  const explicitCompleteRecovery = recoveryCompletedBeforeThisRun(
    releaseCandidateRecoveryReceiptPath,
  );
  const releaseOptions = {
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    token,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    tag:
      result.publishTransaction?.publicReleaseTag ||
      result.publishTransaction?.exactTag ||
      "",
    target: result.publishTransaction?.releaseSha || sha,
    channel: result.publishTransaction?.channel || "",
        publishEvidencePath: result.publishTransaction?.evidencePath || "",
    releasePassportPath: result.publishTransaction?.releasePassportPath || "",
    releasePassportOutputDir:
      result.publishTransaction?.releasePassportOutputDir || "",
    additionalAssetPaths: result.publishTransaction?.sealedReleaseAssetPaths
      ?.length
      ? result.publishTransaction.sealedReleaseAssetPaths
      : artifactPaths,
    reuseExistingCompleteEvidence:
      explicitCompleteRecovery ||
      result.updates.some(
        (update) =>
          update.action === "resumed-advanced-publication" &&
          update.transactionState === "complete",
      ),
    repairMissingCompleteEvidence: explicitCompleteRecovery,
    targetRef,
  };
  const release = releaseOptions.reuseExistingCompleteEvidence
    ? await recoverCompleteGitHubReleaseEvidence(releaseOptions)
    : await publishGitHubReleaseEvidence({
      octokit,
      repository: `${github.context.repo.owner}/${github.context.repo.repo}`,
      sourceSha: releaseOptions.target,
      version:
        result.publishTransaction?.version ||
        String(releaseOptions.tag).replace(/^v/u, ""),
      tag: releaseOptions.tag,
      channel: releaseOptions.channel,
      publishEvidencePath: releaseOptions.publishEvidencePath,
      releasePassportPath: releaseOptions.releasePassportPath,
      releasePassportOutputDir: releaseOptions.releasePassportOutputDir,
      additionalAssetPaths: releaseOptions.additionalAssetPaths,
      statePath: releaseTailStatePath,
    });
  const completion = await recordGitHubReleaseTransactionCompletion({
    octokit,
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    cwd: process.cwd(),
    statePath: result.publishTransaction.statePath,
    evidencePath: result.publishTransaction.evidencePath,
    release,
  });
  result.publishTransaction.publicationState =
    completion.transaction.publication_state;
  result.publishTransaction.stateSha = completion.durable?.sha || "";
  core.setOutput(
    "transaction-publication-state",
    completion.transaction.publication_state,
  );
  core.setOutput("transaction-state-sha", completion.durable?.sha || "");
  core.info(
    `github release ${release.action}: ${release.tag} (${release.assetCount} assets)`,
  );
  return release;
}

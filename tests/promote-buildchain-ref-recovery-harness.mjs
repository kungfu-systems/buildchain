import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { alphaDistTagForPromotion } = await import("../packages/core/release/promote-ref/internal/publish-contract.js");
const { alignMajorBootstrapReleaseImpact, versionVerificationAllowedPathsForPromotion, assertAllowedLocalChanges, createTreeEquivalentReleaseImpact, discoverVersionStateFiles, runVersionVerification, resolveReleaseImpactInput, updateVersionStateContents } = await import("../packages/core/release/version-state.js");
const { assertExpectedPublicationVersion } = await import("../packages/core/release/promote-ref/internal/generated-ref.js");
const { assertChannelPromotionPr, assertProviderEnforcedChannelTransaction, assertProtectedChannel, resolveProtectedStatusCheckContext } = await import("../packages/core/release/promote-ref/internal/channel-governance.js");
const { assertPromotableRepository, assertPromotableTargetRef, expectedHeadRefForTarget, isAllowedReleaseLineRecoveryPath, parseReleaseLineRef, parseTags } = await import("../packages/core/release/promote-ref/internal/promotion-policy.js");
const { finalizationRequirements } = await import("../packages/core/release/promote-ref/internal/durable-transaction-operations.js");
const { ensureManagedChannelBranchProtection } = await import("../packages/core/release/promote-ref/internal/branch-protection.js");
const { latestAlphaForPatch, ownsMajorAlphaChannel, resolveTagsForTarget } = await import("../packages/core/release/promote-ref/internal/channel-tags.js");
const { persistDurableReleaseTransaction, restoreDurableReleaseTransaction } = await import("../packages/core/release/promote-ref/internal/durable-transaction-store.js");
const { promoteBuildchainRefs } = await import("../packages/core/release/promote-ref/lib.js");
const { recordGitHubReleaseTransactionCompletion, runPublishTransaction } = await import("../packages/core/release/promote-ref/internal/publish-transaction.js");
const { releaseCommitMatchesTransactionMaterial: testReleaseCommitMatchesTransactionMaterial } = await import("../packages/core/release/promote-ref/internal/transaction-recovery.js");
const { generateReleaseEvidenceInputs } = await import("../packages/core/release/promote-ref/internal/passport-generation.js");
const { releasePassportArtifactFiles } = await import("../packages/core/release/promote-ref/internal/passport-files.js");
const { selectAlphaTag, selectReleaseTag } = await import("../packages/core/release/promote-ref/internal/tag-selection.js");
const { validatePromotionReleaseCandidate } = await import("../packages/core/release/promote-ref/internal/candidate-admission.js");
const { loadBuildchainConfig } =
  await import("../packages/core/consumer/buildchain-config.js");
const { sha256Json } = await import("../packages/core/release/release-candidate.js");

const { explainReleaseLineDryRun, formatReleaseLineDryRun } =
  await import("../packages/core/release/release-line-dry-run.js");
const { transitionReleaseTransaction } =
  await import("../packages/core/release/publish-transaction.js");
const {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} = await import("../packages/core/publication/publication-artifact-candidate.js");
const { createPublicationSealedBundle } =
  await import("../packages/core/publication/publication-sealed-bundle.js");
const { validateRequiredPublishSourceLock } = await import("../packages/core/release/promote-ref/source-lock.js");
const { plannedPublicationExactTag } = await import("../packages/core/release/promote-ref/action-outputs.js");
const { collectGitHubReleaseEvidenceAssets, publishGitHubReleaseEvidence } = await import("../packages/core/release/github-release.js");
const { reuseCompleteGitHubReleaseEvidence } = await import("../packages/core/release/reuse-complete-release.js");
const { resolveExistingVersionState } = await import(
  "../packages/core/release/promote-ref/internal/version-state-operations.js"
);
const { containedReleaseExecutionIdentity, transactionContainedInRelease } =
  await import("../packages/core/release/promote-ref/internal/promote-release-channel.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import {
  GENERATED_COMMIT_SIGN_OFF,
  OTHER_SHA,
  SHA,
  alreadyExists,
  createGitMock,
  makeTempWorkspace,
  notFound,
  packageManifest,
  productionImpactJson,
  protectedChannel,
  run,
  signedGeneratedCommitMessage,
  transientGitHubError,
  versionStateBranchName,
} from "./helpers/promote-buildchain-ref-fixtures.mjs";
import { materializeCommandShim } from "./helpers/command-shim.mjs";

// prettier-ignore
export { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, recordGitHubReleaseTransactionCompletion, releasePassportArtifactFiles, resolveExistingVersionState, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, reuseCompleteGitHubReleaseEvidence, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion };

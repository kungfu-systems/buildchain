import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const {
  alphaDistTagForPromotion,
  alignMajorBootstrapReleaseImpact,
  versionVerificationAllowedPathsForPromotion,
  assertAllowedLocalChanges,
  assertExpectedPublicationVersion,
  assertChannelPromotionPr,
  assertProviderEnforcedChannelTransaction,
  assertProtectedChannel,
  assertPromotableRepository,
  assertPromotableTargetRef,
  createTreeEquivalentReleaseImpact,
  finalizationRequirements,
  discoverVersionStateFiles,
  ensureManagedChannelBranchProtection,
  expectedHeadRefForTarget,
  isAllowedReleaseLineRecoveryPath,
  latestAlphaForPatch,
  ownsMajorAlphaChannel,
  parseReleaseLineRef,
  parseTags,
  persistDurableReleaseTransaction,
  promoteBuildchainRefs,
  restoreDurableReleaseTransaction,
  runPublishTransaction,
  resolveTagsForTarget,
  testReleaseCommitMatchesTransactionMaterial,
  runVersionVerification,
  resolveReleaseImpactInput,
  generateReleaseEvidenceInputs,
  resolveProtectedStatusCheckContext,
  releasePassportArtifactFiles,
  selectAlphaTag,
  selectReleaseTag,
  updateVersionStateContents,
  validatePromotionReleaseCandidate,
} = await import("../actions/promote-buildchain-ref/lib.js");
const { loadBuildchainConfig } =
  await import("../packages/core/buildchain-config.js");
const { sha256Json } = await import("../packages/core/release-candidate.js");

const { explainReleaseLineDryRun, formatReleaseLineDryRun } =
  await import("../packages/core/release-line-dry-run.js");
const { transitionReleaseTransaction } =
  await import("../packages/core/publish-transaction.js");
const {
  PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT,
  publicationArtifactCandidateDigest,
} = await import("../packages/core/publication-artifact-candidate.js");
const { createPublicationSealedBundle } =
  await import("../packages/core/publication-sealed-bundle.js");
const {
  validateRequiredPublishSourceLock,
  plannedPublicationExactTag,
  collectGitHubReleaseEvidenceAssets,
  publishGitHubReleaseEvidence,
} = await import("../actions/promote-buildchain-ref/index.js");
const { containedReleaseExecutionIdentity, transactionContainedInRelease } =
  await import("../actions/promote-buildchain-ref/internal/promote-release-channel.js");

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
export { GENERATED_COMMIT_SIGN_OFF, OTHER_SHA, PUBLICATION_ARTIFACT_CANDIDATE_CONTRACT, SHA, alignMajorBootstrapReleaseImpact, alphaDistTagForPromotion, alreadyExists, assert, assertAllowedLocalChanges, assertChannelPromotionPr, assertExpectedPublicationVersion, assertPromotableRepository, assertPromotableTargetRef, assertProtectedChannel, assertProviderEnforcedChannelTransaction, collectGitHubReleaseEvidenceAssets, containedReleaseExecutionIdentity, createGitMock, createPublicationSealedBundle, createTreeEquivalentReleaseImpact, crypto, discoverVersionStateFiles, ensureManagedChannelBranchProtection, execFileSync, expectedHeadRefForTarget, explainReleaseLineDryRun, finalizationRequirements, formatReleaseLineDryRun, fs, generateReleaseEvidenceInputs, isAllowedReleaseLineRecoveryPath, latestAlphaForPatch, loadBuildchainConfig, makeTempWorkspace, materializeCommandShim, notFound, os, ownsMajorAlphaChannel, packageManifest, parseReleaseLineRef, parseTags, path, persistDurableReleaseTransaction, plannedPublicationExactTag, productionImpactJson, promoteBuildchainRefs, protectedChannel, publicationArtifactCandidateDigest, publishGitHubReleaseEvidence, releasePassportArtifactFiles, resolveProtectedStatusCheckContext, resolveReleaseImpactInput, resolveTagsForTarget, restoreDurableReleaseTransaction, root, run, runPublishTransaction, runVersionVerification, selectAlphaTag, selectReleaseTag, sha256Json, signedGeneratedCommitMessage, test, testReleaseCommitMatchesTransactionMaterial, transactionContainedInRelease, transitionReleaseTransaction, transientGitHubError, updateVersionStateContents, validatePromotionReleaseCandidate, validateRequiredPublishSourceLock, versionStateBranchName, versionVerificationAllowedPathsForPromotion };

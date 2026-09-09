import { createVersionStateOperations as createVersionStateOperationsModule } from "./internal/version-state-operations.js";
import {
  alignMajorBootstrapReleaseImpact,
  currentConfiguredVersion,
  discoverVersionStateFiles,
  runVersionVerification,
  sha256Content,
  uniquePaths,
  updateVersionStateContents,
  versionVerificationAllowedPathsForPromotion,
  versionVerificationEnv,
} from "../version-state.js";
import {
  discoverConfiguredDerivedVersionMaterial,
  getLifecycleStage,
  getVersionStrategy,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  getPublishContract,
} from "../../consumer/buildchain-config.js";
import {
  getGitCommitWithRetry,
  getGitRefOrUndefined,
  nonFastForwardUpdateRejected,
  notFound,
  retryGitHubOperation,
  listPullRequestsAssociatedWithCommitWithRetry,
  collectRemoteVersionMaterial,
  collectPromotionVersionMaterial,
  remoteVersionStateFilesMatch,
} from "./internal/github-adapter.js";
import {
  COMMIT_IDENTITY,
  signedGeneratedCommitMessage,
} from "./internal/generated-identity.js";
import { createDurableTransactionOperations as createDurableTransactionOperationsModule } from "./internal/durable-transaction-operations.js";
import path from "node:path";
import { releaseTransactionPublicationState } from "../publish-transaction.js";
import {
  assertExpectedPublicationVersion,
  createGeneratedVersionStateChecks,
  protectedBranchDirectUpdateError,
  protectedBranchUpdateRejected,
  versionStateBranchName,
} from "./internal/generated-ref.js";
import {
  beginTransactionFinalization,
  collectAndPersistReleasePassport,
  completeTransactionFinalization,
} from "./internal/passport-generation.js";
import {
  publicReleaseTagForTransaction,
  releaseTagForPublishedVersion,
  releaseCommitIncludesTransactionHead,
  uniqueShas,
  materializeTransactionSourceWorkspace,
  transactionAcceptedExactTagShas,
  transactionHasPublishedMaterial,
} from "./internal/transaction-recovery.js";
import { runPublishTransaction } from "./internal/publish-transaction.js";
import {
  splitPathList,
  validatePromotionReleaseCandidate,
} from "./internal/candidate-admission.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { ensureManagedChannelBranchProtection } from "./internal/branch-protection.js";
import {
  ownsMajorAlphaChannel,
  alphaTagsForPatch,
  currentAlphaVersionState,
  currentReleaseVersionState,
  latestAlphaForPatch,
  resolveTagsForTarget,
} from "./internal/channel-tags.js";
import {
  createRefMutationOperations as createRefMutationOperationsModule,
  createReconciliationOperations as createReconciliationOperationsModule,
} from "./internal/promotion-operations.js";
import {
  RELEASE_LINE_RECOVERY_PATHS,
  isAllowedReleaseLineRecoveryPath,
  parseReleaseLineRecoveryRef,
  stripTagPrefix,
  assertPromotableRepository,
  assertPromotableTargetRef,
  assertSha,
  getPromotionRule,
} from "./internal/promotion-policy.js";
import {
  assertChannelPromotionPr,
  getCommitInfo,
  getMajorGateSource,
  assertProtectedChannel,
} from "./internal/channel-governance.js";
import { parseVersionStateBranchName } from "./internal/generated-branch.js";
import { alphaDistTagForPromotion } from "./internal/publish-contract.js";
import {
  readDurableTransactionForVersion,
  resumableAlphaTransactionState,
  resumableReleaseTransactionState,
} from "./internal/channel-resume.js";
import { selectAlphaTag, selectReleaseTag } from "./internal/tag-selection.js";
import { normalizePromotionOptions } from "./internal/promotion-options.js";
import { verifyPublicationQualificationReceipt } from "../../publication/publication-authority.js";
import { promoteMajorChannel } from "./internal/promote-major-channel.js";
import { promoteAlphaChannel } from "./internal/promote-alpha-channel.js";
import { promoteReleaseChannel } from "./internal/promote-release-channel.js";
export function createVersionStateOperations(context) {
  return createVersionStateOperationsModule({
    ...context,
    COMMIT_IDENTITY,
    alignMajorBootstrapReleaseImpact,
    currentConfiguredVersion,
    discoverConfiguredDerivedVersionMaterial,
    discoverVersionStateFiles,
    getGitCommitWithRetry,
    getGitRefOrUndefined,
    getLifecycleStage,
    getVersionStrategy,
    loadConfiguredAnchorManifest,
    runVersionVerification,
    sha256Content,
    signedGeneratedCommitMessage,
    uniquePaths,
    updateVersionStateContents,
    versionVerificationAllowedPathsForPromotion,
    versionVerificationEnv,
  });
}
export function createDurableTransactionOperations(context) {
  return createDurableTransactionOperationsModule({
    ...context,
    assertExpectedPublicationVersion,
    beginTransactionFinalization,
    collectAndPersistReleasePassport,
    completeTransactionFinalization,
    getLifecycleStage,
    loadBuildchainConfig,
    path,
    publicReleaseTagForTransaction,
    releaseTagForPublishedVersion,
    releaseTransactionPublicationState,
    runPublishTransaction,
    splitPathList,
  });
}
export const REF_MUTATION_RUNTIME = {
  COMMIT_IDENTITY,
  createGeneratedVersionStateChecks,
  ensureManagedChannelBranchProtection,
  execFileSync,
  fs,
  getGitCommitWithRetry,
  getGitRefOrUndefined,
  nonFastForwardUpdateRejected,
  notFound,
  ownsMajorAlphaChannel,
  path,
  protectedBranchDirectUpdateError,
  protectedBranchUpdateRejected,
  releaseCommitIncludesTransactionHead,
  retryGitHubOperation,
  signedGeneratedCommitMessage,
  uniqueShas,
  versionStateBranchName,
};
export function createRefMutationOperations(context) {
  return createRefMutationOperationsModule(context, REF_MUTATION_RUNTIME);
}
export const RECONCILIATION_RUNTIME = {
  RELEASE_LINE_RECOVERY_PATHS,
  alphaTagsForPatch,
  assertChannelPromotionPr,
  getCommitInfo,
  getGitCommitWithRetry,
  isAllowedReleaseLineRecoveryPath,
  listPullRequestsAssociatedWithCommitWithRetry,
  parseReleaseLineRecoveryRef,
  parseVersionStateBranchName,
  releaseCommitIncludesTransactionHead,
  retryGitHubOperation,
};
export function createReconciliationOperations(context) {
  return createReconciliationOperationsModule(context, RECONCILIATION_RUNTIME);
}
export const PROMOTION_RUNTIME = {
  COMMIT_IDENTITY,
  fs,
  path,
  alignMajorBootstrapReleaseImpact,
  alphaDistTagForPromotion,
  alphaTagsForPatch,
  assertExpectedPublicationVersion,
  beginTransactionFinalization,
  collectAndPersistReleasePassport,
  collectRemoteVersionMaterial,
  collectPromotionVersionMaterial,
  remoteVersionStateFilesMatch,
  completeTransactionFinalization,
  currentAlphaVersionState,
  currentConfiguredVersion,
  currentReleaseVersionState,
  discoverConfiguredDerivedVersionMaterial,
  discoverVersionStateFiles,
  getCommitInfo,
  getGitCommitWithRetry,
  getGitRefOrUndefined,
  getLifecycleStage,
  getMajorGateSource,
  getPublishContract,
  getVersionStrategy,
  latestAlphaForPatch,
  loadConfiguredAnchorManifest,
  loadBuildchainConfig,
  materializeTransactionSourceWorkspace,
  publicReleaseTagForTransaction,
  readDurableTransactionForVersion,
  releaseTagForPublishedVersion,
  releaseCommitIncludesTransactionHead,
  releaseTransactionPublicationState,
  resumableAlphaTransactionState,
  resumableReleaseTransactionState,
  selectAlphaTag,
  selectReleaseTag,
  runPublishTransaction,
  runVersionVerification,
  sha256Content,
  signedGeneratedCommitMessage,
  splitPathList,
  stripTagPrefix,
  transactionAcceptedExactTagShas,
  transactionHasPublishedMaterial,
  uniquePaths,
  updateVersionStateContents,
  versionVerificationAllowedPathsForPromotion,
  versionVerificationEnv,
};
export async function promoteBuildchainRefs(options) {
  return runPromotion(normalizePromotionOptions(options));
}
export function parsePublicationQualificationJson(value, label) {
  if (!String(value || "").trim())
    throw new Error(`${label} is required before provider mutation`);
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}
export function createPublicationQualificationAssert(options, rule) {
  return ({
    version = options.expectedPublicationVersion,
    channel = rule.channel,
  } = {}) => {
    if (!options.requirePublicationQualification || options.dryRun) return;
    verifyPublicationQualificationReceipt({
      receipt: parsePublicationQualificationJson(
        options.publicationQualificationReceiptJson,
        "publication-qualification-receipt-json",
      ),
      capability: parsePublicationQualificationJson(
        options.publicationCapabilityJson,
        "publication-capability-json",
      ),
      gateAggregate: parsePublicationQualificationJson(
        options.publicationGateAggregateJson,
        "publication-gate-aggregate-json",
      ),
      usedNonces: parsePublicationQualificationJson(
        options.publicationUsedQualificationNoncesJson || "[]",
        "publication-used-qualification-nonces-json",
      ),
      expected: {
        sourceSha: options.sha,
        channel,
        ...(version ? { version } : {}),
        ...(options.publishPackageMain
          ? { target: `npm:${options.publishPackageMain}` }
          : {}),
      },
      now: options.publicationQualificationNow || new Date(),
    });
  };
}
export function publicationEnabledForPromotion(options) {
  return Boolean(
    options.publishTransaction ||
    options.publishCommand ||
    getLifecycleStage(loadBuildchainConfig(options.cwd), "publish"),
  );
}
export async function readResumableAdvancedTransaction(
  options,
  rule,
  branchSha,
) {
  const statePrefix = rule.releasePrefix.replace(/^v/, "").replaceAll(".", "-");
  const { data: stateRefs } = await options.octokit.rest.git.listMatchingRefs({
    owner: options.owner,
    repo: options.repo,
    ref: `heads/buildchain/release-state/${statePrefix}-`,
  });
  const resumeResolver =
    rule.channel === "alpha"
      ? resumableAlphaTransactionState
      : rule.channel === "release"
        ? resumableReleaseTransactionState
        : undefined;
  const resumable =
    resumeResolver &&
    (await resumeResolver({
      octokit: options.octokit,
      owner: options.owner,
      repo: options.repo,
      cwd: options.cwd,
      refs: stateRefs,
      releasePrefix: rule.releasePrefix,
      targetRef: options.targetRef,
      sourceSha: options.sha,
      expectedVersion: options.expectedPublicationVersion,
    }));
  if (!resumable)
    throw new Error(
      `Ref ${options.targetRef} advanced to ${branchSha}, but no exact resumable transaction accepts requested SHA ${options.sha}`,
    );
  return resumable.transaction;
}
export function supersededPromotionResult(
  options,
  branchSha,
  comparisonStatus,
) {
  return {
    owner: options.owner,
    repo: options.repo,
    sourceSha: options.sha,
    sha: branchSha,
    targetRef: options.targetRef,
    superseded: true,
    updates: [
      {
        action: "superseded-promotion",
        ref: options.targetRef,
        requestedSha: options.sha,
        currentSha: branchSha,
        comparisonStatus,
        reason: "target-ref-advanced",
        sha: branchSha,
      },
    ],
  };
}
export async function resolvePromotionHead(options, rule) {
  const { data: branchRef } = await options.octokit.rest.git.getRef({
    owner: options.owner,
    repo: options.repo,
    ref: `heads/${options.targetRef}`,
  });
  const branchSha = branchRef.object.sha;
  if (branchSha === options.sha) return { branchSha };
  let advancedPublicationTransaction;
  if (options.requireGovernance && !options.dryRun) {
    const { data: comparison } =
      await options.octokit.rest.repos.compareCommitsWithBasehead({
        owner: options.owner,
        repo: options.repo,
        basehead: `${options.sha}...${branchSha}`,
      });
    if (comparison.status !== "ahead")
      throw new Error(
        `Ref ${options.targetRef} moved incompatibly from requested SHA ${options.sha} to ${branchSha} (${comparison.status})`,
      );
    const publicationEnabled = publicationEnabledForPromotion(options);
    advancedPublicationTransaction =
      publicationEnabled && options.expectedPublicationVersion
        ? await readDurableTransactionForVersion({
            octokit: options.octokit,
            owner: options.owner,
            repo: options.repo,
            version: options.expectedPublicationVersion,
          })
        : undefined;
    let targetAdvancedByExactPublication =
      advancedPublicationTransaction?.source_sha === options.sha &&
      advancedPublicationTransaction?.target_ref === options.targetRef &&
      advancedPublicationTransaction?.release_sha === branchSha &&
      advancedPublicationTransaction?.version ===
        options.expectedPublicationVersion &&
      !["abandoned", "failed_permanently"].includes(
        advancedPublicationTransaction?.state || "",
      );
    if (
      !targetAdvancedByExactPublication &&
      options.publishTransactionOverride &&
      publicationEnabled
    ) {
      advancedPublicationTransaction = await readResumableAdvancedTransaction(
        options,
        rule,
        branchSha,
      );
      targetAdvancedByExactPublication = true;
    }
    if (!targetAdvancedByExactPublication) {
      return {
        branchSha,
        superseded: supersededPromotionResult(
          options,
          branchSha,
          comparison.status,
        ),
      };
    }
  } else if (
    options.dryRun &&
    options.publishTransactionOverride &&
    publicationEnabledForPromotion(options)
  ) {
    const { data: comparison } =
      await options.octokit.rest.repos.compareCommitsWithBasehead({
        owner: options.owner,
        repo: options.repo,
        basehead: `${options.sha}...${branchSha}`,
      });
    if (comparison.status !== "ahead")
      throw new Error(
        `Ref ${options.targetRef} moved incompatibly from requested SHA ${options.sha} to ${branchSha} (${comparison.status})`,
      );
    advancedPublicationTransaction = await readResumableAdvancedTransaction(
      options,
      rule,
      branchSha,
    );
  }
  if (!advancedPublicationTransaction)
    throw new Error(
      `Ref ${options.targetRef} points at ${branchSha}, not requested SHA ${options.sha}`,
    );
  return { branchSha, advancedPublicationTransaction };
}
export async function validatePromotionCandidate(options, rule, updates) {
  if (!options.promoteOnlyReleaseCandidate) return undefined;
  const targetCommitInfo = await getCommitInfo(
    options.octokit,
    options.owner,
    options.repo,
    options.sha,
  );
  const validation = validatePromotionReleaseCandidate({
    cwd: options.cwd,
    passportPath: options.releaseCandidatePassportPath,
    buildSummaryPath: options.releaseCandidateBuildSummaryPath,
    repository: `${options.owner}/${options.repo}`,
    targetChannel: rule.channel,
    version: options.releaseCandidateRecoveryReceiptPath
      ? options.expectedPublicationVersion
      : options.releaseCandidateVersion,
    recoveryReceiptPath: options.releaseCandidateRecoveryReceiptPath,
    targetRef: options.targetRef,
    sourceHeadSha: options.sha,
    sourceTreeSha: targetCommitInfo.treeSha,
    requireFamilyEvidence: options.releaseCandidateFamilyEvidenceRequired,
    familyEvidenceRoot: options.releaseCandidateFamilyEvidenceRoot,
    familyInitiativeId: options.releaseCandidateFamilyInitiativeId,
    familyAssignmentId: options.releaseCandidateFamilyAssignmentId,
  });
  updates.push({
    action: "verified-release-candidate",
    sha: options.sha,
    candidateHash: validation.candidateHash,
    platformCount: validation.platformCount,
    passportPath: path
      .relative(options.cwd, validation.passportPath)
      .split(path.sep)
      .join("/"),
    publicationVersionBinding: validation.publicationVersionBinding,
  });
  return validation;
}
export async function runPromotion(options) {
  let { requiredStatusCheck } = options;
  const {
    owner,
    repo,
    allowRepository,
    targetRef,
    sha,
    tags,
    octokit,
    publicationQualificationNow,
    requireGovernance,
    dryRun,
  } = options;
  assertPromotableRepository(owner, repo, allowRepository);
  assertPromotableTargetRef(targetRef);
  assertSha(sha);
  const rule = getPromotionRule(targetRef);
  const assertPublicationQualification = createPublicationQualificationAssert(
    options,
    rule,
  );
  assertPublicationQualification();
  const requestedTags = tags
    ? resolveTagsForTarget(targetRef, tags)
    : undefined;
  const { branchSha, advancedPublicationTransaction, superseded } =
    await resolvePromotionHead(options, rule);
  if (superseded) return superseded;

  const updates = [];
  if (advancedPublicationTransaction) {
    updates.push({
      action: "resumed-advanced-publication",
      ref: targetRef,
      requestedSha: sha,
      currentSha: branchSha,
      transactionId: advancedPublicationTransaction.id,
      transactionState: advancedPublicationTransaction.state,
      sha: branchSha,
    });
  }
  const promotionGeneratedAt = new Date().toISOString();
  const releaseCandidateValidation = await validatePromotionCandidate(
    options,
    rule,
    updates,
  );

  let reconciliationOperations;
  let versionOperations;
  const baseContext = {
    ...options,
    octokit,
    owner,
    repo,
    sha,
    targetRef,
    tags,
    publicationQualificationNow,
    requiredStatusCheck,
    rule,
    assertPublicationQualification,
    requestedTags,
    updates,
    promotionGeneratedAt,
    releaseCandidateValidation,
    advancedPublicationTransaction,
    advancedChannelSha: advancedPublicationTransaction ? branchSha : "",
    ...PROMOTION_RUNTIME,
    getReconciliationOperations: () => reconciliationOperations,
    getVersionStateOperations: () => versionOperations,
  };
  const refOperations = createRefMutationOperations(baseContext);
  reconciliationOperations = createReconciliationOperations({
    ...baseContext,
    ...refOperations,
  });
  versionOperations = createVersionStateOperations({
    ...baseContext,
    ...refOperations,
    ...reconciliationOperations,
  });
  const transactionOperations = createDurableTransactionOperations({
    ...baseContext,
    ...refOperations,
    ...reconciliationOperations,
    ...versionOperations,
  });
  const channelContext = {
    ...baseContext,
    ...refOperations,
    ...reconciliationOperations,
    ...versionOperations,
    ...transactionOperations,
  };

  if (requireGovernance && !dryRun) {
    requiredStatusCheck = await assertProtectedChannel({
      octokit,
      owner,
      repo,
      targetRef,
      sourceSha: sha,
      expectedChannelSha: advancedPublicationTransaction ? branchSha : sha,
      requiredStatusCheck,
    });
  }

  if (rule.channel === "major") {
    return promoteMajorChannel(channelContext);
  }

  const lineRefs = await refOperations.listLineRefs();
  const lineContext = { ...channelContext, lineRefs };
  if (rule.channel === "alpha") {
    return promoteAlphaChannel(lineContext);
  }
  return promoteReleaseChannel(lineContext);
}

import { getLifecycleStage } from "../../../consumer/buildchain-config.js";
import path from "node:path";
import {
  defaultReleaseStatePath,
  defaultPublishEvidencePath,
  parsePublishArtifactsJson,
  resolvePublishArtifactRequirements,
  releaseTransactionStateRef,
  readReleaseTransaction,
  readPublishEvidence,
  validatePublishEvidence,
  transitionReleaseTransaction,
} from "../../publish-transaction.js";
import fs from "node:fs";
import {
  resolvePublishContract,
  validatePublishContractForArtifacts,
  orderNpmArtifactsForPackageSet,
} from "./publish-contract.js";
import { preflightNpmTokenAuth } from "./npm-distribution.js";
import { resolveExistingNpmArtifacts } from "./npm-existing-evidence.js";
import {
  sealedBundleRecoveryRoot,
  readAndVerifySealedBundle,
  materialErrorRequiresRepair,
  transactionCoversRequiredArtifacts,
  releaseCommitIncludesTransactionHead,
  ensureTransactionCanResume,
  canRebindPublishedTransactionExactTag,
  canReplaceStaleVersionStateTransaction,
} from "./transaction-recovery.js";
import { restoreDurableReleaseTransaction } from "./durable-transaction-store.js";
export function preparePublishTransactionContext({
  octokit,
  owner,
  repo,
  cwd,
  loadedConfig,
  targetRef,
  sourceSha,
  releaseSha,
  version,
  exactTag,
  channel,
  line,
  publishTransaction,
  publishCommand = "",
  publishProvider,
  publishEvidencePath = "",
  transactionStatePath = "",
  expectedTransactionId = "",
  publishSealedBundleRoot = "",
  publishSealedBundleManifest = "",
  publishRequiredArtifactsJson = "",
  releaseMaterialSha = "",
  publishToolingSha = "",
  publishMode = "",
  publishAuth = "",
  publishDistTag = "",
  publishPackageSetOrder = "",
  publishPackageMain = "",
  publishRematerializeOnResume = false,
  actor = "",
  runId = "",
  explicitOverride = false,
  allowVersionStateFinalization = false,
  promotionGeneratedAt = new Date().toISOString(),
}) {
  const lifecyclePublish = getLifecycleStage(loadedConfig, "publish");
  const enabled = Boolean(
    publishTransaction || publishCommand || publishProvider || lifecyclePublish,
  );
  if (!enabled) {
    return undefined;
  }

  const repository = `${owner}/${repo}`;
  const resolvedStatePath = path.resolve(
    cwd,
    transactionStatePath || defaultReleaseStatePath(exactTag, cwd),
  );
  const resolvedEvidencePath = path.resolve(
    cwd,
    publishEvidencePath || defaultPublishEvidencePath(exactTag, cwd),
  );
  let requiredArtifacts = parsePublishArtifactsJson(
    publishRequiredArtifactsJson,
    "publish-required-artifacts-json",
  );
  const publishContract = resolvePublishContract({
    loadedConfig,
    channel,
    line,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
  });
  requiredArtifacts = resolvePublishArtifactRequirements(requiredArtifacts, {
    version,
    targetRef,
    sourceSha,
    releaseMaterialSha: releaseMaterialSha || releaseSha,
  });
  validatePublishContractForArtifacts({
    channel,
    contract: publishContract,
    requiredArtifacts,
  });
  const existingNpmPromotion =
    publishContract.mode === "promote-existing-version";
  if (existingNpmPromotion) {
    preflightNpmTokenAuth({ cwd });
  }
  requiredArtifacts = orderNpmArtifactsForPackageSet({
    artifacts: requiredArtifacts,
    contract: publishContract,
  });
  if (existingNpmPromotion) {
    requiredArtifacts = resolveExistingNpmArtifacts({ cwd, requiredArtifacts });
    requiredArtifacts = orderNpmArtifactsForPackageSet({
      artifacts: requiredArtifacts,
      contract: publishContract,
    });
  }
  const expected = {
    repository,
    version,
    exactTag,
    sourceSha,
    targetRef,
    releaseMaterialSha: releaseMaterialSha || releaseSha,
    publishToolingSha: publishToolingSha || releaseSha,
  };

  const durableStateRef = releaseTransactionStateRef(version);
  const requestedBundleRoot = sealedBundleRecoveryRoot(
    cwd,
    version,
    publishSealedBundleRoot,
  );
  const requestedBundleManifest = publishSealedBundleManifest
    ? JSON.parse(
        fs.readFileSync(path.resolve(cwd, publishSealedBundleManifest), "utf8"),
      )
    : undefined;
  return {
    octokit,
    owner,
    repo,
    cwd,
    loadedConfig,
    targetRef,
    sourceSha,
    releaseSha,
    version,
    exactTag,
    channel,
    line,
    publishCommand,
    publishProvider,
    publishRematerializeOnResume,
    actor,
    runId,
    explicitOverride,
    allowVersionStateFinalization,
    promotionGeneratedAt,
    repository,
    resolvedStatePath,
    resolvedEvidencePath,
    requiredArtifacts,
    publishContract,
    existingNpmPromotion,
    expected,
    durableStateRef,
    requestedBundleRoot,
    requestedBundleManifest,
    expectedTransactionId: String(expectedTransactionId || "").trim(),
  };
}
export async function restorePublishTransactionContext(context) {
  const {
    octokit,
    owner,
    repo,
    cwd,
    version,
    channel,
    sourceSha,
    releaseSha,
    targetRef,
    requiredArtifacts,
    expected,
    durableStateRef,
    resolvedStatePath,
    resolvedEvidencePath,
    requestedBundleRoot,
    requestedBundleManifest,
    expectedTransactionId,
  } = context;
  const durableExisting = await restoreDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    stateRef: durableStateRef,
    statePath: resolvedStatePath,
    evidencePath: resolvedEvidencePath,
    sealedBundleRoot: requestedBundleRoot,
  });
  const localExisting = readReleaseTransaction(resolvedStatePath);
  if (
    durableExisting &&
    localExisting &&
    durableExisting.id !== localExisting.id
  ) {
    throw new Error(
      `release transaction local state ${localExisting.id} conflicts with durable state ${durableExisting.id}`,
    );
  }
  let existing = durableExisting || localExisting;
  if (expectedTransactionId && !existing) {
    throw new Error(
      `expected release transaction ${expectedTransactionId} does not exist`,
    );
  }
  if (expectedTransactionId && existing.id !== expectedTransactionId) {
    throw new Error(
      `release transaction identity mismatch: expected ${expectedTransactionId}, got ${existing.id}`,
    );
  }
  const durableBundleVerification = durableExisting?.sealed_bundle?.root
    ? readAndVerifySealedBundle({
        cwd,
        bundleRoot: requestedBundleRoot,
        manifest: durableExisting.sealed_bundle,
      })
    : undefined;
  const requestedBundleVerification = requestedBundleManifest
    ? readAndVerifySealedBundle({
        cwd,
        bundleRoot: requestedBundleRoot,
        manifest: requestedBundleManifest,
      })
    : undefined;
  const localBundleVerification =
    !durableExisting && localExisting?.sealed_bundle?.root
      ? readAndVerifySealedBundle({
          cwd,
          bundleRoot: requestedBundleRoot,
          manifest: localExisting.sealed_bundle,
        })
      : undefined;
  if (
    durableBundleVerification &&
    requestedBundleVerification &&
    durableBundleVerification.root !== requestedBundleVerification.root
  ) {
    throw new Error(
      `sealed bundle root mismatch: durable=${durableBundleVerification.root} requested=${requestedBundleVerification.root}`,
    );
  }
  let sealedBundleVerification =
    durableBundleVerification ||
    requestedBundleVerification ||
    localBundleVerification;
  let existingEvidence = readPublishEvidence(resolvedEvidencePath);
  let existingValidation;
  if (existingEvidence) {
    existingValidation = validatePublishEvidence({
      evidence: existingEvidence,
      version,
      channel,
      sourceSha,
      releaseSha,
      targetRef,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      requiredArtifacts,
    });
  }
  return {
    ...context,
    durableExisting,
    localExisting,
    existing,
    sealedBundleVerification,
    existingEvidence,
    existingValidation,
  };
}
export async function canFinalizePublishVersionState({
  context,
  error,
  existing,
}) {
  const {
    allowVersionStateFinalization,
    explicitOverride,
    version,
    exactTag,
    targetRef,
    requiredArtifacts,
    octokit,
    owner,
    repo,
    releaseSha,
  } = context;
  if (
    !(allowVersionStateFinalization || explicitOverride) ||
    !materialErrorRequiresRepair(error) ||
    existing?.version !== version ||
    existing?.exact_tag !== exactTag ||
    existing?.target_ref !== targetRef ||
    !["published", "finalizing", "complete"].includes(existing.state || "") ||
    !transactionCoversRequiredArtifacts(existing, requiredArtifacts)
  ) {
    return false;
  }
  const includesHead = (transactionReleaseSha) =>
    releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha,
      transactionReleaseSha,
    });
  return (
    (await includesHead(existing.release_sha)) ||
    (await includesHead(existing.release_material_sha))
  );
}
export async function resolvePublishTransactionResume(context) {
  const {
    octokit,
    owner,
    repo,
    cwd,
    version,
    exactTag,
    targetRef,
    channel,
    releaseSha,
    requiredArtifacts,
    expected,
    explicitOverride,
    allowVersionStateFinalization,
    actor,
    runId,
    resolvedStatePath,
    resolvedEvidencePath,
    durableExisting,
    localExisting,
  } = context;
  let { existing, existingEvidence, existingValidation } = context;
  let versionStateFinalization = false;
  try {
    ensureTransactionCanResume({
      existing,
      expected,
      explicitOverride,
      evidence: existingEvidence,
      validation: existingValidation,
    });
  } catch (error) {
    const canRebindExactTag = await canRebindPublishedTransactionExactTag({
      octokit,
      owner,
      repo,
      error,
      existing,
      validation: existingValidation,
      version,
      exactTag,
      releaseSha,
      releaseMaterialSha: expected.releaseMaterialSha,
      requiredArtifacts,
    });
    const canFinalizeVersionState = await canFinalizePublishVersionState({
      context,
      error,
      existing,
    });
    const canReplaceStaleVersionState = canReplaceStaleVersionStateTransaction({
      error,
      existing,
      version,
      exactTag,
      targetRef,
      channel,
      allowVersionStateFinalization,
      explicitOverride,
      localOnly: Boolean(localExisting && !durableExisting),
    });
    if (
      !canRebindExactTag &&
      !canFinalizeVersionState &&
      !canReplaceStaleVersionState
    ) {
      throw error;
    }
    if (canRebindExactTag) {
      existing = {
        ...transitionReleaseTransaction(existing, existing.state, {
          actor,
          runId,
          failure: "",
        }),
        exact_tag: exactTag,
        state_path: path
          .relative(cwd, resolvedStatePath)
          .split(path.sep)
          .join("/"),
        evidence_path: path
          .relative(cwd, resolvedEvidencePath)
          .split(path.sep)
          .join("/"),
      };
    } else if (canFinalizeVersionState) {
      versionStateFinalization = true;
    } else {
      existing = undefined;
      existingEvidence = undefined;
      existingValidation = undefined;
      fs.rmSync(resolvedStatePath, { force: true });
      fs.rmSync(resolvedEvidencePath, { force: true });
    }
  }
  return {
    ...context,
    existing,
    existingEvidence,
    existingValidation,
    versionStateFinalization,
  };
}
export function publishTransactionEnvironment(
  {
    version,
    channel,
    sourceSha,
    targetRef,
    resolvedStatePath,
    resolvedEvidencePath,
    releaseSha,
    expected,
    promotionGeneratedAt,
    sealedBundleVerification,
    requiredArtifacts,
    publishContract,
  },
  { useSealedBundle = true } = {},
) {
  const sealedBundle = useSealedBundle ? sealedBundleVerification : undefined;
  return {
    BUILDCHAIN_VERSION: version,
    BUILDCHAIN_CHANNEL: channel,
    BUILDCHAIN_SOURCE_SHA: sourceSha,
    BUILDCHAIN_TARGET_REF: targetRef,
    BUILDCHAIN_RELEASE_STATE: resolvedStatePath,
    BUILDCHAIN_EVIDENCE_DIR: path.dirname(resolvedEvidencePath),
    BUILDCHAIN_RELEASE_SHA: releaseSha,
    BUILDCHAIN_RELEASE_MATERIAL_SHA: expected.releaseMaterialSha,
    BUILDCHAIN_PUBLISH_TOOLING_SHA: expected.publishToolingSha,
    BUILDCHAIN_SITE_GENERATED_AT: promotionGeneratedAt,
    BUILDCHAIN_SITE_PUBLISHED_AT: promotionGeneratedAt,
    BUILDCHAIN_SITE_TIMESTAMP_POLICY: "ci-injected",
    BUILDCHAIN_SURFACE_GENERATED_AT: promotionGeneratedAt,
    BUILDCHAIN_SURFACE_PUBLISHED_AT: promotionGeneratedAt,
    BUILDCHAIN_SURFACE_TIMESTAMP_POLICY: "ci-injected",
    BUILDCHAIN_PUBLISH_EVIDENCE: resolvedEvidencePath,
    BUILDCHAIN_SEALED_BUNDLE_ROOT: sealedBundle?.root || "",
    BUILDCHAIN_SEALED_NPM_TARBALL: sealedBundle?.npm.absolutePath || "",
    BUILDCHAIN_SEALED_NPM_INTEGRITY: sealedBundle?.npm.integrity || "",
    BUILDCHAIN_SEALED_NPM_SHA256: sealedBundle?.npm.sha256 || "",
    BUILDCHAIN_REQUIRED_ARTIFACTS: JSON.stringify(requiredArtifacts),
    BUILDCHAIN_PUBLISH_MODE: publishContract.mode,
    BUILDCHAIN_PUBLISH_AUTH: publishContract.auth,
    BUILDCHAIN_NPM_DIST_TAG: publishContract.distTag,
    BUILDCHAIN_PACKAGE_SET_ORDER: publishContract.packageSetOrder,
    BUILDCHAIN_PACKAGE_SET_MAIN_PACKAGE: publishContract.mainPackage,
  };
}
export async function reopenValidatedRepair(
  transaction,
  durable,
  validation,
  explicitOverride,
  actor,
  runId,
  persist,
) {
  if (
    transaction.state !== "repair_required" ||
    !explicitOverride ||
    !validation?.valid
  )
    return { transaction, durable };
  return persist(
    transitionReleaseTransaction(transaction, "publishing", {
      actor,
      runId,
      failure: "",
    }),
  );
}

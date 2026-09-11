import {
  createReleaseTransaction,
  attachReleaseTransactionSealedBundle,
  writeReleaseTransaction,
  readPublishEvidence,
  validatePublishEvidence,
  planTransactionRecovery,
  transitionReleaseTransaction,
  recordReleaseTransactionMilestone,
  readReleaseTransaction,
} from "../../publish-transaction.js";
import { persistDurableReleaseTransaction } from "./durable-transaction-store.js";
import path from "node:path";
import {
  preparePublishTransactionContext,
  restorePublishTransactionContext,
  resolvePublishTransactionResume,
  publishTransactionEnvironment,
  reopenValidatedRepair,
} from "./transaction-context.js";
import {
  sealedBundleDurableFiles,
  validateTransactionEvidence,
  materialErrorRequiresRepair,
} from "./transaction-recovery.js";
import {
  findTransactionEvidencePath,
  packageSetFromArtifacts,
  promoteExistingNpmArtifacts,
  writeDistTagPromotionEvidence,
} from "./npm-distribution.js";
import {
  runResumeRematerializedPublish,
  runPublishCommand,
} from "./publish-command.js";
import { writeExistingNpmEvidence } from "./npm-existing-evidence.js";
async function preservePublishFailure(
  context,
  transaction,
  persistTransaction,
  error,
) {
  const { actor, runId } = context;
  if (["published", "finalizing", "complete"].includes(transaction.state)) {
    try {
      transaction = transitionReleaseTransaction(
        transaction,
        transaction.state,
        {
          actor,
          runId,
          failure: error.message,
        },
      );
      await persistTransaction(transaction);
    } catch (persistError) {
      error.message = `${error.message}; additionally failed to preserve post-publish transaction state: ${persistError.message}`;
    }
    throw error;
  }
  const nextState = materialErrorRequiresRepair(error)
    ? "repair_required"
    : "publish_failed";
  if (transaction.state !== "repair_required") {
    transaction = transitionReleaseTransaction(transaction, nextState, {
      actor,
      runId,
      failure: error.message,
    });
    await persistTransaction(transaction);
  }
  throw error;
}
async function executePublishTransaction(context, initial, persistTransaction) {
  const {
    octokit,
    owner,
    repo,
    cwd,
    loadedConfig,
    targetRef,
    sourceSha,
    releaseSha,
    version,
    channel,
    publishCommand,
    publishProvider,
    publishRematerializeOnResume,
    actor,
    runId,
    explicitOverride,
    resolvedStatePath,
    resolvedEvidencePath,
    requiredArtifacts,
    publishContract,
    existingNpmPromotion,
    expected,
    existing,
    existingEvidence,
    existingValidation,
    sealedBundleVerification,
  } = context;
  let { transaction, durable } = initial;
  let validation;
  let publishSource = existingEvidence ? "existing-evidence" : "";
  let distTagEvidencePath = "";
  const publishEnvironment = publishTransactionEnvironment(context);

  try {
    const evidence =
      existingEvidence || readPublishEvidence(resolvedEvidencePath);
    if (evidence) {
      validation = existingValidation;
    }
    if (evidence && !validation) {
      validation = validatePublishEvidence({
        evidence,
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
    const recovery = planTransactionRecovery({
      transaction,
      evidence,
      validation,
      explicitOverride,
    });
    if (recovery.blocked) {
      throw new Error(`release transaction cannot recover: ${recovery.reason}`);
    }
    ({ transaction, durable } = await reopenValidatedRepair(
      transaction,
      durable,
      validation,
      explicitOverride,
      actor,
      runId,
      persistTransaction,
    ));
    if (
      existing &&
      existing.state !== "complete" &&
      validation?.valid &&
      publishRematerializeOnResume
    ) {
      publishSource = runResumeRematerializedPublish({
        existingNpmPromotion,
        cwd,
        publishCommand,
        publishProvider,
        loadedConfig,
        context,
        version,
        published: true,
      });
    }
    if (!validation?.valid) {
      if (transaction.state === "repair_required" && explicitOverride) {
        transaction = transitionReleaseTransaction(transaction, "publishing", {
          actor,
          runId,
          failure: "",
        });
      } else if (transaction.state !== "publishing") {
        transaction = transitionReleaseTransaction(transaction, "publishing", {
          actor,
          runId,
        });
      }
      ({ transaction, durable } = await persistTransaction(transaction));
      publishSource = publishRequiredArtifacts(context, publishEnvironment);
      if (publishSource === "none") {
        throw new Error(
          "publish transaction requires lifecycle.publish, publish-command, or existing evidence",
        );
      }
    }
    validation = validateTransactionEvidence({
      evidencePath: resolvedEvidencePath,
      version,
      channel,
      sourceSha,
      releaseSha,
      targetRef,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      requiredArtifacts,
    });
    distTagEvidencePath = writeDistTagPromotionEvidence({
      evidencePath: resolvedEvidencePath,
      mode: publishContract.mode,
      auth: publishContract.auth,
      distTag: publishContract.distTag,
      source: publishSource || "validated-evidence",
      artifacts: validation.evidence.artifacts,
    });
    if (
      transaction.state === "publishing" ||
      transaction.state === "publish_failed"
    ) {
      transaction = transitionReleaseTransaction(transaction, "published", {
        actor,
        runId,
        failure: "",
      });
    }
    transaction = {
      ...transaction,
      artifacts: validation.evidence.artifacts,
      evidence: [
        path.relative(cwd, resolvedEvidencePath).split(path.sep).join("/"),
        path.relative(cwd, distTagEvidencePath).split(path.sep).join("/"),
      ],
    };
    transaction = recordReleaseTransactionMilestone(
      transaction,
      "package-published",
      {
        artifactCount: validation.evidence.artifacts.length,
        sealedBundleRoot: transaction.sealed_bundle?.root || "",
      },
    );
    ({ transaction, durable } = await persistTransaction(transaction));
    return publishTransactionResult({
      cwd,
      distTagEvidencePath,
      durable,
      octokit,
      owner,
      publishContract,
      repo,
      resolvedEvidencePath,
      resolvedStatePath,
      sealedBundleVerification,
      transaction,
      validation,
    });
  } catch (error) {
    return preservePublishFailure(
      context,
      transaction,
      persistTransaction,
      error,
    );
  }
}
export async function runPublishTransaction(options) {
  const prepared = preparePublishTransactionContext(options);
  if (!prepared) return undefined;
  const restored = await restorePublishTransactionContext(prepared);
  const context = await resolvePublishTransactionResume(restored);
  const {
    octokit,
    owner,
    repo,
    cwd,
    targetRef,
    sourceSha,
    releaseSha,
    version,
    exactTag,
    channel,
    line,
    actor,
    runId,
    repository,
    resolvedStatePath,
    resolvedEvidencePath,
    requiredArtifacts,
    publishContract,
    expected,
    durableExisting,
    existing,
    sealedBundleVerification,
    versionStateFinalization,
  } = context;
  let transaction =
    existing ||
    createReleaseTransaction({
      repository,
      version,
      exactTag,
      channel,
      line,
      sourceSha,
      targetRef,
      releaseSha,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      actor,
      runId,
    });
  if (sealedBundleVerification) {
    transaction = attachReleaseTransactionSealedBundle(
      transaction,
      sealedBundleVerification.manifest,
      {
        actor,
        runId,
      },
    );
  }
  let sealedBundleFilesPending = Boolean(
    sealedBundleVerification && !durableExisting?.sealed_bundle?.root,
  );
  const persistTransaction = async (record) => {
    const persisted = writeReleaseTransaction(resolvedStatePath, record);
    const durable = await persistDurableReleaseTransaction({
      octokit,
      owner,
      repo,
      cwd,
      transaction: persisted,
      evidencePath: resolvedEvidencePath,
      extraFiles: sealedBundleFilesPending
        ? sealedBundleDurableFiles(sealedBundleVerification)
        : [],
    });
    sealedBundleFilesPending = false;
    return { transaction: persisted, durable };
  };
  let durable;
  ({ transaction, durable } = await persistTransaction(transaction));
  if (versionStateFinalization) {
    return {
      transaction,
      validation: undefined,
      statePath: resolvedStatePath,
      evidencePath: resolvedEvidencePath,
      distTagEvidencePath: findTransactionEvidencePath({
        cwd,
        transaction,
        fallbackName: "dist-tag-evidence.json",
      }),
      packageSet: packageSetFromArtifacts({
        artifacts: transaction.artifacts || requiredArtifacts,
        contract: publishContract,
      }),
      publishContract,
      sealedBundle: sealedBundleVerification,
      durable,
      octokit,
      owner,
      repo,
      cwd,
    };
  }
  return executePublishTransaction(
    context,
    { transaction, durable },
    persistTransaction,
  );
}
export async function persistTransactionResult(result, transaction) {
  const persisted = writeReleaseTransaction(result.statePath, transaction);
  const durable = await persistDurableReleaseTransaction({
    octokit: result.octokit,
    owner: result.owner,
    repo: result.repo,
    cwd: result.cwd,
    transaction: persisted,
    evidencePath: result.evidencePath,
  });
  return { ...result, transaction: persisted, durable };
}
export async function recordGitHubReleaseTransactionCompletion({
  octokit,
  owner,
  repo,
  cwd = process.cwd(),
  statePath,
  evidencePath,
  release,
} = {}) {
  const resolvedStatePath = path.resolve(cwd, statePath);
  const transaction = readReleaseTransaction(resolvedStatePath);
  if (!transaction) {
    throw new Error(
      `release transaction state is missing: ${resolvedStatePath}`,
    );
  }
  if (transaction.state !== "complete") {
    throw new Error(
      `github release completion requires a complete transaction, got ${transaction.state}`,
    );
  }
  const completed = recordReleaseTransactionMilestone(
    transaction,
    "github-release",
    {
      action: String(release?.action || ""),
      tag: String(release?.tag || ""),
      url: String(release?.url || ""),
      assetCount: Number(release?.assetCount || 0),
    },
  );
  const persisted = writeReleaseTransaction(resolvedStatePath, completed);
  const durable = await persistDurableReleaseTransaction({
    octokit,
    owner,
    repo,
    cwd,
    transaction: persisted,
    evidencePath: path.resolve(cwd, evidencePath),
  });
  return {
    transaction: persisted,
    durable,
  };
}

function publishRequiredArtifacts(context, publishEnvironment) {
  const {
    existingNpmPromotion,
    cwd,
    requiredArtifacts,
    publishContract,
    resolvedEvidencePath,
    version,
    channel,
    sourceSha,
    releaseSha,
    targetRef,
    expected,
    publishRematerializeOnResume,
    publishCommand,
    publishProvider,
    loadedConfig,
  } = context;
  let publishSource;
  if (existingNpmPromotion) {
    publishSource = promoteExistingNpmArtifacts({
      cwd,
      artifacts: requiredArtifacts,
      distTag: publishContract.distTag,
    });
    writeExistingNpmEvidence({
      evidencePath: resolvedEvidencePath,
      version,
      channel,
      sourceSha,
      releaseSha,
      targetRef,
      releaseMaterialSha: expected.releaseMaterialSha,
      publishToolingSha: expected.publishToolingSha,
      artifacts: requiredArtifacts,
    });
  } else {
    publishSource = publishRematerializeOnResume
      ? runResumeRematerializedPublish({
          existingNpmPromotion,
          cwd,
          publishCommand,
          publishProvider,
          loadedConfig,
          context,
          version,
        })
      : runPublishCommand({
          cwd,
          command: publishCommand,
          provider: publishProvider,
          loadedConfig,
          env: publishEnvironment,
        });
  }
  return publishSource;
}

function publishTransactionResult({
  cwd,
  distTagEvidencePath,
  durable,
  octokit,
  owner,
  publishContract,
  repo,
  resolvedEvidencePath,
  resolvedStatePath,
  sealedBundleVerification,
  transaction,
  validation,
}) {
  return {
    transaction,
    validation,
    statePath: resolvedStatePath,
    evidencePath: resolvedEvidencePath,
    distTagEvidencePath,
    packageSet: packageSetFromArtifacts({
      artifacts: validation.evidence.artifacts,
      contract: publishContract,
    }),
    publishContract,
    sealedBundle: sealedBundleVerification,
    durable,
    octokit,
    owner,
    repo,
    cwd,
  };
}

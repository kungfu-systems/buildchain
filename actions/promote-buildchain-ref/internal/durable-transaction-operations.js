function finalizationRequirements(material, rematerialize = false) { return (material?.artifacts || []).map((artifact) => rematerialize && artifact?.kind === "github-release" ? { ...artifact, digest: "" } : artifact); }

function releasePassportOutputPath(context) {
  return context.path.resolve(
    context.cwd,
    context.releasePassportOutputDir || ".buildchain/release-passport",
  );
}

function createDurableTransactionOperations(context) {
  const {
    octokit,
    owner,
    repo,
    sha,
    targetRef,
    tags,
    dryRun,
    allowRepository,
    cwd,
    versionState,
    requireVersionState,
    requireGovernance,
    verificationCommand,
    requiredStatusCheck,
    statusCheckOctokit,
    pullRequestOctokit,
    refUpdateOctokit,
    branchProtectionBypassApps,
    branchProtectionBypassUsers,
    branchProtectionBypassTeams,
    reconciliationWorkspace,
    publishTransaction,
    publishCommand,
    publishEvidencePath,
    transactionStatePath,
    expectedTransactionId,
    publishSealedBundleRoot,
    publishSealedBundleManifest,
    publishRequiredArtifactsJson,
    releaseMaterialSha,
    publishToolingSha,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
    publishRematerializeOnResume: rematerialize,
    expectedPublicationVersion,
    requirePublicationQualification,
    publicationCapabilityJson,
    publicationGateAggregateJson,
    publicationQualificationReceiptJson,
    publicationUsedQualificationNoncesJson,
    publicationQualificationNow,
    releasePassport,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportPromotionRoutingJson,
    releasePassportV4RuntimeResumeEvidenceJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd2ClaimJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
    releasePassportKfdAdopterManifestJson,
    releasePassportKfdSupportMatrixJson,
    releasePassportKfdProductGateJsons,
    releasePassportInvariantPassportJsons,
    releasePassportInvariantPassportCommand,
    releasePassportEvidenceJsons,
    releasePassportAttachmentCommand,
    releasePassportBuildchainSelfKfd,
    releasePassportGitHubArtifactAttestationPolicyJsons,
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    actor,
    runId,
    publishTransactionOverride,
    rule,
    assertPublicationQualification,
    requestedTags,
    updates,
    promotionGeneratedAt,
    releaseCandidateValidation,
    advancedPublicationTransaction,
    lineRefs,
    listLineRefs,
    listMajorAlphaRefs,
    ownsMajorAlphaFloatingTag,
    ensureTag,
    updateTag,
    updateMajorAlphaFloatingTag,
    readRefSha,
    updateBranch,
    updateDefaultBranch,
    assertOnlyAllowedChangesBetween,
    listChangedPathsBetweenTrees,
    assertOnlyAllowedReleaseRecoveryChangesBetween,
    findMatchingReleaseRecoveryPullRequest,
    findMatchingTargetPullRequest,
    findAlphaMaterialFromPromotionPullRequest,
    assertPromotionPrOrVersionStateParent,
    assertReleasePrOrVersionStateParent,
    isSettledAlphaVersionState,
    createVersionStateCommit,
    shouldPromoteMajorTag,
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
  } = context;
  let latestPublishTransaction;
  const executePublishTransaction = async ({
    version,
    exactTag,
    channel,
    line,
    releaseSha,
    releaseCandidateVersion = "",
    sourceShaOverride = sha,
    releaseMaterialShaOverride = releaseMaterialSha,
    publishToolingShaOverride = publishToolingSha,
    publishDistTagOverride = publishDistTag,
    durablePublicationMaterial: material,
    allowVersionStateFinalization = false,
  }) => {
    const transactionVersion = version;
    assertExpectedPublicationVersion(
      expectedPublicationVersion,
      transactionVersion,
    );
    if (
      dryRun &&
      (publishTransaction ||
        publishCommand ||
        getLifecycleStage(loadBuildchainConfig(cwd), "publish"))
    ) {
      updates.push({
        action: "dry-run-publish-transaction",
        version: transactionVersion,
        tag: exactTag,
        publicTag: releaseTagForPublishedVersion(transactionVersion),
        sha: releaseSha,
        ...(releaseCandidateVersion ? { releaseCandidateVersion } : {}),
      });
      return undefined;
    }
    assertPublicationQualification({ version: transactionVersion, channel });
    latestPublishTransaction = await runPublishTransaction({
      octokit,
      owner,
      repo,
      cwd,
      loadedConfig: loadBuildchainConfig(cwd),
      targetRef,
      sourceSha: sourceShaOverride,
      releaseSha,
      version: transactionVersion,
      exactTag,
      channel,
      line,
      publishTransaction,
      publishCommand,
      publishEvidencePath,
      transactionStatePath,
      expectedTransactionId,
      publishSealedBundleRoot,
      publishSealedBundleManifest: material ? "" : publishSealedBundleManifest,
      publishRequiredArtifactsJson: material
        ? JSON.stringify(finalizationRequirements(material, rematerialize))
        : publishRequiredArtifactsJson,
      releaseMaterialSha: releaseMaterialShaOverride,
      publishToolingSha: publishToolingShaOverride,
      publishMode,
      publishAuth,
      publishDistTag: publishDistTagOverride,
      publishPackageSetOrder,
      publishPackageMain,
      publishRematerializeOnResume: rematerialize,
      actor,
      runId,
      explicitOverride: publishTransactionOverride,
      allowVersionStateFinalization,
      promotionGeneratedAt,
    });
    if (latestPublishTransaction) {
      updates.push({
        action: "publish-transaction",
        version,
        tag: exactTag,
        sha: latestPublishTransaction.transaction.release_sha,
        state: latestPublishTransaction.transaction.state,
        transactionId: latestPublishTransaction.transaction.id,
        statePath: path
          .relative(cwd, latestPublishTransaction.statePath)
          .split(path.sep)
          .join("/"),
        evidencePath: path
          .relative(cwd, latestPublishTransaction.evidencePath)
          .split(path.sep)
          .join("/"),
        stateRef: latestPublishTransaction.transaction.state_ref,
        stateSha: latestPublishTransaction.durable?.sha,
      });
    }
    return latestPublishTransaction;
  };
  const markFinalizing = async () => {
    latestPublishTransaction = await beginTransactionFinalization(latestPublishTransaction, actor, runId);
  };
  const markComplete = async ({
    channel,
    line,
    passportCwd = cwd,
    passportBuildSummaryPath = releasePassportBuildSummaryPath,
    passportPlatformManifestPaths = splitPathList(
      releasePassportPlatformManifestPaths,
    ),
    passportPromotionRoutingJson = releasePassportPromotionRoutingJson,
    passportV4ConsumerPolicyCertificationJson =
      context.releasePassportV4ConsumerPolicyCertificationJson,
    passportKfd1WitnessJsons = splitPathList(releasePassportKfd1WitnessJsons),
    passportKfd2ClaimJsons = splitPathList(releasePassportKfd2ClaimJsons),
    passportKfd3PrebuildWitnessJsons = splitPathList(
      releasePassportKfd3PrebuildWitnessJsons,
    ),
    passportKfd3ArtifactWitnessJsons = splitPathList(
      releasePassportKfd3ArtifactWitnessJsons,
    ),
    passportKfdAdopterManifestJson = releasePassportKfdAdopterManifestJson,
    passportKfdSupportMatrixJson = releasePassportKfdSupportMatrixJson,
    passportKfdProductGateJsons = splitPathList(
      releasePassportKfdProductGateJsons,
    ),
    passportInvariantPassportJsons = splitPathList(
      releasePassportInvariantPassportJsons,
    ),
    passportReleaseEvidenceJsons = splitPathList(releasePassportEvidenceJsons),
    passportReleaseCandidateValidation = releaseCandidateValidation,
  } = {}) => {
    latestPublishTransaction = await completeTransactionFinalization(
      latestPublishTransaction,
      actor,
      runId,
    );
    latestPublishTransaction = await collectAndPersistReleasePassport({
      result: latestPublishTransaction,
      owner,
      repo,
      cwd: passportCwd,
      sourceSha: sha,
      targetRef,
      channel: channel || rule.channel,
      line: line || rule.releasePrefix || "",
      packageName: publishPackageMain,
      outputDir: releasePassportOutputPath(context),
      productName: releasePassportProductName,
      buildSummaryPath: passportBuildSummaryPath,
      platformManifestPaths: passportPlatformManifestPaths,
      impactJson: releasePassportImpactJson,
      promotionRoutingJson: passportPromotionRoutingJson,
      v4ConsumerPolicyCertificationJson: passportV4ConsumerPolicyCertificationJson,
      v4ConsumerPolicyCertificationRoot:
        context.releasePassportV4ConsumerPolicyCertificationRoot,
      v4RuntimeResumeEvidenceJson: releasePassportV4RuntimeResumeEvidenceJson,
      kfd1WitnessJsons: passportKfd1WitnessJsons,
      kfd2ClaimJsons: passportKfd2ClaimJsons,
      kfd3PrebuildWitnessJsons: passportKfd3PrebuildWitnessJsons,
      kfd3ArtifactWitnessJsons: passportKfd3ArtifactWitnessJsons,
      kfd3ArtifactVerifyCommand: releasePassportKfd3ArtifactVerifyCommand,
      kfdAdopterManifestJson: passportKfdAdopterManifestJson,
      kfdSupportMatrixJson: passportKfdSupportMatrixJson,
      kfdProductGateJsons: passportKfdProductGateJsons,
      invariantPassportJsons: passportInvariantPassportJsons,
      invariantPassportCommand: releasePassportInvariantPassportCommand,
      releaseEvidenceJsons: passportReleaseEvidenceJsons,
      releaseEvidenceCommand: releasePassportAttachmentCommand,
      buildchainSelfKfd: Boolean(releasePassportBuildchainSelfKfd),
      githubArtifactAttestationPolicyJsons: splitPathList(
        releasePassportGitHubArtifactAttestationPolicyJsons,
      ),
      enabled: Boolean(releasePassport),
      releaseCandidateValidation: passportReleaseCandidateValidation,
    });
    if (latestPublishTransaction?.transaction) {
      const publicReleaseTag =
        latestPublishTransaction.publicReleaseTag ||
        publicReleaseTagForTransaction(latestPublishTransaction.transaction);
      if (
        publicReleaseTag &&
        publicReleaseTag !== latestPublishTransaction.transaction.exact_tag
      ) {
        await ensureTag(
          publicReleaseTag,
          latestPublishTransaction.transaction.source_sha,
        );
      }
    }
    return latestPublishTransaction;
  };

  const withPublishTransaction = (result, extra = {}) => {
    if (!latestPublishTransaction) {
      return result;
    }
    return {
      ...result,
      publishTransaction: {
        id: latestPublishTransaction.transaction.id,
        state: latestPublishTransaction.transaction.state,
        publicationState: releaseTransactionPublicationState(
          latestPublishTransaction.transaction,
        ),
        failure: latestPublishTransaction.transaction.failure || "",
        exactTag: latestPublishTransaction.transaction.exact_tag,
        publicReleaseTag:
          latestPublishTransaction.publicReleaseTag ||
          publicReleaseTagForTransaction(latestPublishTransaction.transaction),
        channel: latestPublishTransaction.transaction.channel,
        releaseSha: latestPublishTransaction.transaction.release_sha,
        stateRef: latestPublishTransaction.transaction.state_ref,
        stateSha: latestPublishTransaction.durable?.sha,
        statePath: path
          .relative(cwd, latestPublishTransaction.statePath)
          .split(path.sep)
          .join("/"),
        evidencePath: path
          .relative(cwd, latestPublishTransaction.evidencePath)
          .split(path.sep)
          .join("/"),
        releasePassportPath: latestPublishTransaction.releasePassport
          ?.passportPath
          ? path
              .relative(
                cwd,
                latestPublishTransaction.releasePassport.passportPath,
              )
              .split(path.sep)
              .join("/")
          : "",
        releasePassportOutputDir: latestPublishTransaction.releasePassport
          ?.outputDir
          ? path
              .relative(cwd, latestPublishTransaction.releasePassport.outputDir)
              .split(path.sep)
              .join("/")
          : "",
        releasePassportStateSha:
          latestPublishTransaction.releasePassport?.stateSha || "",
        sealedBundleRoot:
          latestPublishTransaction.transaction.sealed_bundle?.root || "",
        resumeCommand:
          latestPublishTransaction.transaction.resume_command || "",
        sealedNpmTarballPath:
          latestPublishTransaction.sealedBundle?.npm.absolutePath || "",
        sealedReleaseAssetPaths:
          latestPublishTransaction.sealedBundle?.releaseAssets.map(
            (entry) => entry.absolutePath,
          ) || [],
        ...extra,
      },
    };
  };
  const getLatestPublishTransaction = () => latestPublishTransaction;
  return {
    executePublishTransaction,
    markFinalizing,
    markComplete,
    withPublishTransaction,
    getLatestPublishTransaction,
  };
}

export { createDurableTransactionOperations };

async function promoteAlphaChannel(context) {
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
    publishRequiredArtifactsJson,
    releaseMaterialSha,
    publishToolingSha,
    publishMode,
    publishAuth,
    publishDistTag,
    publishPackageSetOrder,
    publishPackageMain,
    publishRematerializeOnResume,
    expectedPublicationVersion,
    requirePublicationQualification,
    publicationCapabilityJson,
    publicationGateAggregateJson,
    publicationQualificationReceiptJson,
    publicationUsedQualificationNoncesJson,
    publicationQualificationNow,
    releasePassport,
    releasePassportOutputDir,
    releasePassportProductName,
    releasePassportBuildSummaryPath,
    releasePassportPlatformManifestPaths,
    releasePassportImpactJson,
    releasePassportPromotionRoutingJson,
    releasePassportKfd1WitnessJsons,
    releasePassportKfd2ClaimJsons,
    releasePassportKfd3PrebuildWitnessJsons,
    releasePassportKfd3ArtifactWitnessJsons,
    releasePassportKfd3ArtifactVerifyCommand,
    releasePassportKfdSupportMatrixJson,
    releasePassportKfdProductGateJsons,
    releasePassportInvariantPassportJsons,
    releasePassportInvariantPassportCommand,
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
    executePublishTransaction,
    markFinalizing,
    markComplete,
    withPublishTransaction,
    getLatestPublishTransaction,
    fs,
    alphaDistTagForPromotion,
    currentAlphaVersionState,
    getLifecycleStage,
    getPublishContract,
    loadBuildchainConfig,
    materializeTransactionSourceWorkspace,
    publicReleaseTagForTransaction,
    readDurableTransactionForVersion,
    releaseCommitIncludesTransactionHead,
    resumableAlphaTransactionState,
    selectAlphaTag,
    stripTagPrefix,
    transactionAcceptedExactTagShas,
    transactionHasPublishedMaterial,
  } = context;
  const ownsMajorAlphaTag = await ownsMajorAlphaFloatingTag();
  const sharedAlphaAuthorityMajor = getPublishContract(
    loadBuildchainConfig(cwd),
  )?.sharedAlphaAuthorityMajor;
  const alphaPublishDistTag = alphaDistTagForPromotion({
    ownsMajorAlphaTag,
    line: rule.releasePrefix,
    publishDistTag,
    sharedAlphaAuthorityMajor,
  });
  const explicitAlphaTags = requestedTags
    ? requestedTags.filter((tag) => tag.includes("-alpha."))
    : [];
  if (explicitAlphaTags.length > 1) {
    throw new Error(
      "Alpha promotion accepts at most one explicit prerelease tag",
    );
  }
  const currentAlpha = explicitAlphaTags[0]
    ? undefined
    : currentAlphaVersionState({
        cwd,
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
      });
  const currentAlphaTransaction = currentAlpha
    ? await readDurableTransactionForVersion({
        octokit,
        owner,
        repo,
        version: currentAlpha.version,
      })
    : undefined;
  const publishTransactionEnabled = Boolean(
    publishTransaction ||
    publishCommand ||
    getLifecycleStage(loadBuildchainConfig(cwd), "publish"),
  );
  const resumableAlpha =
    explicitAlphaTags[0] || !publishTransactionEnabled
      ? undefined
      : await resumableAlphaTransactionState({
          octokit,
          owner,
          repo,
          cwd,
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          targetRef,
          sourceSha: sha,
          expectedVersion: expectedPublicationVersion,
        });
  const currentAlphaTagSha = currentAlpha
    ? await readRefSha(`tags/${currentAlpha.tag}`)
    : undefined;
  const currentAlphaFloatingSha = currentAlpha
    ? await readRefSha(`tags/${rule.alphaTag}`)
    : undefined;
  const currentAlphaMajorFloatingSha =
    currentAlpha && ownsMajorAlphaTag
      ? await readRefSha(`tags/${rule.majorAlphaTag}`)
      : undefined;
  const currentAlphaDevSha = currentAlpha
    ? await readRefSha(`heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`)
    : undefined;
  const currentAlphaAcceptedExactShas = transactionAcceptedExactTagShas(
    currentAlphaTransaction,
    sha,
  );
  const currentAlphaSettled =
    currentAlpha &&
    currentAlphaDevSha === sha &&
    currentAlphaFloatingSha === sha &&
    (!ownsMajorAlphaTag || currentAlphaMajorFloatingSha === sha) &&
    currentAlphaTagSha &&
    currentAlphaAcceptedExactShas.includes(currentAlphaTagSha);
  const currentAlphaHasFinalizationRefs =
    currentAlpha &&
    Boolean(
      currentAlphaTagSha || currentAlphaFloatingSha || currentAlphaDevSha,
    );
  const currentAlphaTransactionOpen =
    currentAlphaTransaction &&
    !["complete", "abandoned", "failed_permanently"].includes(
      currentAlphaTransaction.state,
    );
  const currentAlphaContainsTransaction =
    currentAlphaTransactionOpen &&
    ((await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: sha,
      transactionReleaseSha: currentAlphaTransaction.release_sha,
    })) ||
      (await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha: sha,
        transactionReleaseSha: currentAlphaTransaction.release_material_sha,
      })));
  const currentAlphaCanReplaceStaleTransaction =
    currentAlphaTransactionOpen &&
    !currentAlphaContainsTransaction &&
    !transactionHasPublishedMaterial(currentAlphaTransaction);
  const currentAlphaCanFinalize =
    currentAlpha &&
    (!currentAlphaTransactionOpen ||
      currentAlphaContainsTransaction ||
      currentAlphaSettled ||
      currentAlphaCanReplaceStaleTransaction);
  const currentAlphaNeedsContainedPublishedFinalization =
    currentAlpha &&
    currentAlphaTransactionOpen &&
    ["published", "finalizing"].includes(currentAlphaTransaction.state || "") &&
    transactionHasPublishedMaterial(currentAlphaTransaction) &&
    currentAlphaContainsTransaction &&
    currentAlpha.version === currentAlphaTransaction.version &&
    currentAlpha.tag === currentAlphaTransaction.exact_tag &&
    currentAlphaTransaction.target_ref === targetRef &&
    (!expectedPublicationVersion ||
      expectedPublicationVersion === currentAlphaTransaction.version) &&
    !currentAlphaTagSha;
  if (currentAlphaNeedsContainedPublishedFinalization) {
    if (dryRun) {
      updates.push({
        action: "dry-run-publish-transaction",
        version: currentAlphaTransaction.version,
        tag: currentAlphaTransaction.exact_tag,
        publicTag: publicReleaseTagForTransaction(currentAlphaTransaction),
        sha: currentAlphaTransaction.release_sha,
        finalizationOnly: true,
      });
      updates.push({
        action: "contained-published-transaction-finalization",
        tag: currentAlphaTransaction.exact_tag,
        sourceSha: currentAlphaTransaction.source_sha,
        releaseSha: currentAlphaTransaction.release_sha,
        currentChannelSha: sha,
        sha: currentAlphaTransaction.release_sha,
      });
      return {
        owner,
        repo,
        sourceSha: sha,
        sha,
        targetRef,
        updates,
      };
    }

    let finalizationSource;
    try {
      if (releasePassport) {
        finalizationSource = await materializeTransactionSourceWorkspace({
          octokit,
          owner,
          repo,
          cwd,
          sourceSha: currentAlphaTransaction.source_sha,
        });
      }
      await executePublishTransaction({
        version: currentAlphaTransaction.version,
        exactTag: currentAlphaTransaction.exact_tag,
        channel: currentAlphaTransaction.channel || rule.channel,
        line: currentAlphaTransaction.line || rule.releasePrefix,
        releaseSha: currentAlphaTransaction.release_sha,
        sourceShaOverride: currentAlphaTransaction.source_sha,
        releaseMaterialShaOverride:
          currentAlphaTransaction.release_material_sha ||
          currentAlphaTransaction.release_sha,
        publishToolingShaOverride:
          currentAlphaTransaction.publish_tooling_sha ||
          currentAlphaTransaction.release_sha,
        publishDistTagOverride: alphaPublishDistTag,
      });
      await markFinalizing();
      await ensureTag(
        currentAlphaTransaction.exact_tag,
        currentAlphaTransaction.release_sha,
        {
          acceptedExistingShas: transactionAcceptedExactTagShas(
            currentAlphaTransaction,
            currentAlphaTransaction.release_sha,
          ),
        },
      );
      await updateTag(rule.alphaTag, currentAlphaTransaction.release_sha);
      await updateMajorAlphaFloatingTag({
        sha: currentAlphaTransaction.release_sha,
      });
      await markComplete({
        passportCwd: finalizationSource?.workspace || cwd,
        passportBuildSummaryPath: "",
        passportPlatformManifestPaths: [],
        passportPromotionRoutingJson: "",
        passportKfd1WitnessJsons: [],
        passportKfd2ClaimJsons: [],
        passportKfd3PrebuildWitnessJsons: [],
        passportKfd3ArtifactWitnessJsons: [],
        passportKfdSupportMatrixJson: "",
        passportKfdProductGateJsons: [],
        passportInvariantPassportJsons: [],
        passportReleaseCandidateValidation: null,
      });
    } finally {
      if (finalizationSource?.root) {
        fs.rmSync(finalizationSource.root, {
          recursive: true,
          force: true,
        });
      }
    }
    updates.push({
      action: "finalized-contained-published-transaction",
      tag: currentAlphaTransaction.exact_tag,
      sourceSha: currentAlphaTransaction.source_sha,
      releaseSha: currentAlphaTransaction.release_sha,
      currentChannelSha: sha,
      sha: currentAlphaTransaction.release_sha,
    });
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha,
      targetRef,
      updates,
    });
  }
  let selectedAlpha = explicitAlphaTags[0]
    ? { tag: explicitAlphaTags[0] }
    : currentAlphaTransactionOpen &&
        currentAlphaContainsTransaction &&
        !currentAlphaSettled
      ? currentAlpha
      : currentAlpha &&
          currentAlphaCanFinalize &&
          currentAlphaHasFinalizationRefs &&
          !currentAlphaTagSha
        ? currentAlpha
        : resumableAlpha
          ? resumableAlpha
          : currentAlphaTransactionOpen &&
              currentAlpha &&
              currentAlphaContainsTransaction &&
              !currentAlphaTagSha
            ? currentAlpha
            : selectAlphaTag({
                refs: lineRefs,
                releasePrefix: rule.releasePrefix,
                sha,
              });
  const settledAlphaVersionState =
    await isSettledAlphaVersionState(selectedAlpha);
  if (settledAlphaVersionState) {
    updates.push({ ref: targetRef, action: "already-promoted", sha });
    updates.push({
      ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
      action: "already-promoted",
      sha,
    });
    updates.push({ tag: selectedAlpha.tag, action: "existing", sha });
    updates.push({ tag: rule.alphaTag, action: "existing", sha });
    updates.push(
      ownsMajorAlphaTag
        ? { tag: rule.majorAlphaTag, action: "existing", sha }
        : {
            tag: rule.majorAlphaTag,
            action: "skipped-newer-minor-alpha-exists",
            sha,
          },
    );
    if (publishTransaction || publishCommand) {
      const settledVersion =
        selectedAlpha.version || stripTagPrefix(selectedAlpha.tag);
      await executePublishTransaction({
        version: settledVersion,
        exactTag: selectedAlpha.tag,
        channel: rule.channel,
        line: rule.releasePrefix,
        releaseSha: sha,
        publishDistTagOverride: alphaPublishDistTag,
        allowVersionStateFinalization: true,
      });
      if (!dryRun && getLatestPublishTransaction()) {
        await markFinalizing();
        await markComplete();
      }
    }
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha,
      targetRef,
      updates,
    });
  }
  const prepareAlphaCommit = async (candidate) => {
    const version = stripTagPrefix(candidate.tag);
    if (candidate.transaction?.release_sha) {
      return {
        version,
        publishVersion: version,
        commit: { action: "existing-publish-transaction", files: [] },
        sha: candidate.transaction.release_sha,
      };
    }
    const commit = await createVersionStateCommit({
      baseSha: sha,
      version,
      message: `chore(release): prepare ${candidate.tag}`,
    });
    if (requireGovernance && !dryRun) {
      await assertPromotionPrOrVersionStateParent({
        commitSha: sha,
        targetRef,
        allowedPaths: commit.files,
      });
    }
    return {
      version,
      publishVersion: commit.publishVersion || version,
      commit,
      sha: commit.sha,
    };
  };
  let alpha = await prepareAlphaCommit(selectedAlpha);
  const currentAlphaRequiresNewPublication =
    currentAlpha &&
    selectedAlpha.tag === currentAlpha.tag &&
    currentAlphaTransactionOpen &&
    transactionHasPublishedMaterial(currentAlphaTransaction) &&
    !["existing", "existing-publish-transaction"].includes(alpha.commit.action);
  if (currentAlphaRequiresNewPublication) {
    updates.push({
      tag: selectedAlpha.tag,
      action: "advanced-published-transaction",
      sha: alpha.sha,
    });
    selectedAlpha = selectAlphaTag({
      refs: lineRefs,
      releasePrefix: rule.releasePrefix,
      sha,
    });
    alpha = await prepareAlphaCommit(selectedAlpha);
  }
  try {
    await executePublishTransaction({
      version: alpha.publishVersion || alpha.version,
      exactTag: selectedAlpha.tag,
      channel: rule.channel,
      line: rule.releasePrefix,
      releaseSha: alpha.sha,
      publishDistTagOverride: alphaPublishDistTag,
      allowVersionStateFinalization:
        currentAlpha &&
        selectedAlpha.tag === currentAlpha.tag &&
        alpha.commit.action === "existing",
    });
  } catch (error) {
    const staleCurrentAlpha =
      currentAlpha &&
      selectedAlpha.tag === currentAlpha.tag &&
      /release transaction identity mismatch/.test(error.message || "");
    if (!staleCurrentAlpha) {
      throw error;
    }
    updates.push({
      tag: selectedAlpha.tag,
      action: "stale-publish-transaction",
      sha: alpha.sha,
    });
    selectedAlpha = selectAlphaTag({
      refs: lineRefs,
      releasePrefix: rule.releasePrefix,
      sha,
    });
    alpha = await prepareAlphaCommit(selectedAlpha);
    await executePublishTransaction({
      version: alpha.publishVersion || alpha.version,
      exactTag: selectedAlpha.tag,
      channel: rule.channel,
      line: rule.releasePrefix,
      releaseSha: alpha.sha,
      publishDistTagOverride: alphaPublishDistTag,
    });
  }
  if (versionState) {
    await markFinalizing();
    const targetUpdate = await updateBranch(targetRef, alpha.sha, "updated", {
      title: `Prepare ${selectedAlpha.tag}`,
      body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
      allowPendingPullRequest: true,
    });
    if (targetUpdate.pending) {
      return withPublishTransaction(
        {
          owner,
          repo,
          sourceSha: sha,
          sha: alpha.sha,
          targetRef,
          pendingPullRequest:
            targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
          updates,
        },
        { finalizationNeeded: true },
      );
    }
    const devUpdate = await updateBranch(
      `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
      alpha.sha,
      "updated",
      {
        title: `Prepare ${selectedAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
        allowNonFastForwardSkip: true,
        allowPendingPullRequest: true,
      },
    );
    if (devUpdate.pending) {
      return withPublishTransaction(
        {
          owner,
          repo,
          sourceSha: sha,
          sha: alpha.sha,
          targetRef,
          pendingPullRequest:
            devUpdate.pullRequest.html_url || devUpdate.pullRequest.url,
          updates,
        },
        { finalizationNeeded: true },
      );
    }
  }
  await markFinalizing();
  await ensureTag(selectedAlpha.tag, alpha.sha, {
    acceptedExistingShas: transactionAcceptedExactTagShas(
      getLatestPublishTransaction()?.transaction || currentAlphaTransaction,
      alpha.sha,
    ),
    acceptedExistingMaterialShas: transactionAcceptedExactTagShas(
      getLatestPublishTransaction()?.transaction || currentAlphaTransaction,
      "",
    ),
  });
  await updateTag(rule.alphaTag, alpha.sha);
  await updateMajorAlphaFloatingTag({ sha: alpha.sha });
  await markComplete();
  return withPublishTransaction({
    owner,
    repo,
    sourceSha: sha,
    sha: alpha.sha,
    targetRef,
    updates,
  });
}

export { promoteAlphaChannel };

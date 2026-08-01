async function promoteMajorChannel(context) {
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
    getCommitInfo,
    getMajorGateSource,
    getVersionStrategy,
    loadBuildchainConfig,
    materializeTransactionSourceWorkspace,
    publicReleaseTagForTransaction,
    readDurableTransactionForVersion,
    releaseCommitIncludesTransactionHead,
    selectAlphaTag,
    selectReleaseTag,
    stripTagPrefix,
    transactionAcceptedExactTagShas,
    transactionHasPublishedMaterial,
  } = context;
  const resolveMajorGateSource = async () => {
    try {
      return await getMajorGateSource({
        octokit,
        owner,
        repo,
        sha,
        targetRef,
      });
    } catch (directError) {
      const commit = await getCommitInfo(octokit, owner, repo, sha);
      for (const parentSha of commit.parents) {
        try {
          return await getMajorGateSource({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
        } catch {
          // Try the next parent before surfacing the direct lineage failure.
        }
      }
      throw directError;
    }
  };
  const majorGate = await resolveMajorGateSource();
  const majorRule = {
    ...rule,
    ...majorGate,
    majorAlphaTag: `v${majorGate.major}-alpha`,
    tags: [majorGate.majorTag, majorGate.minorTag],
  };
  const refs = await listLineRefs(majorRule.releasePrefix);
  const explicitReleaseTags = requestedTags
    ? requestedTags.filter(
        (tag) =>
          !tag.includes("-alpha.") &&
          tag.startsWith(`${majorRule.releasePrefix}.`),
      )
    : [];
  if (explicitReleaseTags.length > 1) {
    throw new Error(
      "publish-gate/major promotion accepts at most one explicit release tag",
    );
  }
  const initialMajorTag = `${majorRule.releasePrefix}.0`;
  const initialMajorVersion = stripTagPrefix(initialMajorTag);
  const initialMajorTransaction = explicitReleaseTags[0]
    ? undefined
    : await readDurableTransactionForVersion({
        octokit,
        owner,
        repo,
        version: initialMajorVersion,
      });
  const initialMajorExactSha = initialMajorTransaction
    ? await readRefSha(`tags/${initialMajorTag}`)
    : undefined;
  const initialMajorContainsTransaction =
    initialMajorTransaction &&
    ((await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: sha,
      transactionReleaseSha: initialMajorTransaction.release_sha,
    })) ||
      (await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha: sha,
        transactionReleaseSha: initialMajorTransaction.release_material_sha,
      })));
  const initialMajorAcceptedExactShas = transactionAcceptedExactTagShas(
    initialMajorTransaction,
    sha,
  );
  const containedPublishedMajorTransaction =
    initialMajorTransaction &&
    ["published", "finalizing", "complete"].includes(
      initialMajorTransaction.state || "",
    ) &&
    transactionHasPublishedMaterial(initialMajorTransaction) &&
    initialMajorTransaction.version === initialMajorVersion &&
    initialMajorTransaction.exact_tag === initialMajorTag &&
    initialMajorTransaction.target_ref === targetRef &&
    initialMajorTransaction.channel === (majorRule.channel || "major") &&
    initialMajorTransaction.line === majorRule.releasePrefix &&
    (!expectedPublicationVersion ||
      expectedPublicationVersion === initialMajorTransaction.version) &&
    initialMajorContainsTransaction &&
    (!initialMajorExactSha ||
      initialMajorAcceptedExactShas.includes(initialMajorExactSha))
      ? initialMajorTransaction
      : undefined;
  if (containedPublishedMajorTransaction && dryRun) {
    updates.push({
      action: "dry-run-publish-transaction",
      version: containedPublishedMajorTransaction.version,
      tag: containedPublishedMajorTransaction.exact_tag,
      publicTag: publicReleaseTagForTransaction(
        containedPublishedMajorTransaction,
      ),
      sha: containedPublishedMajorTransaction.release_sha,
      finalizationOnly: true,
    });
    updates.push({
      action: "contained-published-transaction-finalization",
      tag: containedPublishedMajorTransaction.exact_tag,
      sourceSha: containedPublishedMajorTransaction.source_sha,
      releaseSha: containedPublishedMajorTransaction.release_sha,
      currentChannelSha: sha,
      sha: containedPublishedMajorTransaction.release_sha,
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
  const selectedRelease = containedPublishedMajorTransaction
    ? {
        tag: containedPublishedMajorTransaction.exact_tag,
        patch: 0,
      }
    : explicitReleaseTags[0]
      ? {
          tag: explicitReleaseTags[0],
          patch: Number(explicitReleaseTags[0].split(".").pop()),
        }
      : selectReleaseTag({
          refs,
          releasePrefix: majorRule.releasePrefix,
          sha,
        });
  if (selectedRelease.patch !== 0) {
    throw new Error(
      `publish-gate/major promotion must create the first patch of the next major line; got ${selectedRelease.tag}`,
    );
  }
  const releaseVersion = stripTagPrefix(selectedRelease.tag);
  const releaseCommit = containedPublishedMajorTransaction
    ? {
        sha: containedPublishedMajorTransaction.release_sha,
        version: containedPublishedMajorTransaction.version,
        action: "contained-published-transaction",
        publishVersion: containedPublishedMajorTransaction.version,
        files: [],
        versionStrategy: getVersionStrategy(loadBuildchainConfig(cwd)),
      }
    : await createVersionStateCommit({
        baseSha: sha,
        version: releaseVersion,
        message: `chore(release): release ${selectedRelease.tag}`,
      });
  const releaseSha = releaseCommit.sha;
  if (requireGovernance && !dryRun) {
    if (releaseCommit.action === "existing") {
      await assertPromotionPrOrVersionStateParent({
        commitSha: sha,
        targetRef,
        allowedPaths: releaseCommit.files,
      });
    }
  }
  let finalizationSource;
  try {
    if (containedPublishedMajorTransaction && releasePassport) {
      finalizationSource = await materializeTransactionSourceWorkspace({
        octokit,
        owner,
        repo,
        cwd,
        sourceSha: containedPublishedMajorTransaction.source_sha,
      });
    }
    await executePublishTransaction({
      version: releaseCommit.publishVersion || releaseVersion,
      exactTag: selectedRelease.tag,
      channel: majorRule.channel || "major",
      line: majorRule.releasePrefix,
      releaseSha,
      sourceShaOverride: containedPublishedMajorTransaction?.source_sha || sha,
      releaseMaterialShaOverride:
        containedPublishedMajorTransaction?.release_material_sha ||
        containedPublishedMajorTransaction?.release_sha ||
        releaseMaterialSha,
      publishToolingShaOverride:
        containedPublishedMajorTransaction?.publish_tooling_sha ||
        containedPublishedMajorTransaction?.release_sha ||
        publishToolingSha,
      allowVersionStateFinalization:
        releaseCommit.action === "existing" ||
        Boolean(containedPublishedMajorTransaction),
    });
    if (versionState) {
      await markFinalizing();
      if (!containedPublishedMajorTransaction) {
        const gateUpdate = await updateBranch(
          targetRef,
          releaseSha,
          "updated",
          {
            title: `Release ${selectedRelease.tag}`,
            body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
            allowPendingPullRequest: true,
          },
        );
        if (gateUpdate.pending) {
          return withPublishTransaction(
            {
              owner,
              repo,
              sourceSha: sha,
              sha: releaseSha,
              targetRef,
              pendingPullRequest:
                gateUpdate.pullRequest.html_url || gateUpdate.pullRequest.url,
              updates,
            },
            { finalizationNeeded: true },
          );
        }
      }
      const releaseBranchUpdate = await updateBranch(
        `release/v${majorRule.major}/v${majorRule.major}.0`,
        releaseSha,
        "updated",
        {
          title: `Release ${selectedRelease.tag}`,
          body: `Create the generated version-state commit for ${selectedRelease.tag}.`,
          allowPendingPullRequest: true,
        },
      );
      if (releaseBranchUpdate.pending) {
        return withPublishTransaction(
          {
            owner,
            repo,
            sourceSha: sha,
            sha: releaseSha,
            targetRef,
            pendingPullRequest:
              releaseBranchUpdate.pullRequest.html_url ||
              releaseBranchUpdate.pullRequest.url,
            updates,
          },
          { finalizationNeeded: true },
        );
      }
    }
    await markFinalizing();
    await ensureTag(selectedRelease.tag, releaseSha, {
      acceptedExistingShas: transactionAcceptedExactTagShas(
        containedPublishedMajorTransaction,
        releaseSha,
      ),
    });
    await updateTag(majorRule.minorTag, releaseSha);
    await updateTag(majorRule.majorTag, releaseSha);
    await markComplete(
      containedPublishedMajorTransaction
        ? {
            channel: majorRule.channel || "major",
            line: majorRule.releasePrefix,
            passportCwd: finalizationSource?.workspace || cwd,
            passportBuildSummaryPath: "",
            passportPlatformManifestPaths: [],
            passportPromotionRoutingJson: "",
            passportKfd1WitnessJsons: [],
            passportKfd2ClaimJsons: [],
            passportKfdSupportMatrixJson: "",
            passportKfdProductGateJsons: [],
            passportKfd3PrebuildWitnessJsons: [],
            passportKfd3ArtifactWitnessJsons: [],
            passportInvariantPassportJsons: [],
            passportReleaseCandidateValidation: null,
          }
        : {
            channel: majorRule.channel || "major",
            line: majorRule.releasePrefix,
          },
    );
  } finally {
    if (finalizationSource?.root) {
      fs.rmSync(finalizationSource.root, {
        recursive: true,
        force: true,
      });
    }
  }
  if (containedPublishedMajorTransaction) {
    updates.push({
      action: "finalized-contained-published-transaction",
      tag: containedPublishedMajorTransaction.exact_tag,
      sourceSha: containedPublishedMajorTransaction.source_sha,
      releaseSha: containedPublishedMajorTransaction.release_sha,
      currentChannelSha: sha,
      sha: containedPublishedMajorTransaction.release_sha,
    });
  }

  if (releaseCommit.versionStrategy?.next === "manual") {
    updates.push({
      ref: `dev/v${majorRule.major}/v${majorRule.major}.0`,
      action: "next-anchor-required",
      versionStrategy: releaseCommit.versionStrategy.strategy,
      manifest: releaseCommit.anchorManifest?.path,
      sha: releaseSha,
    });
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaRequired: true,
      targetRef,
      updates,
    });
  }

  const explicitAlphaTags = requestedTags
    ? requestedTags.filter((tag) => tag.includes("-alpha."))
    : [];
  if (explicitAlphaTags.length > 1) {
    throw new Error(
      "publish-gate/major promotion accepts at most one explicit next-alpha tag",
    );
  }
  const selectedNextAlpha = explicitAlphaTags[0]
    ? { tag: explicitAlphaTags[0] }
    : selectAlphaTag({
        refs,
        releasePrefix: majorRule.releasePrefix,
        sha: releaseSha,
        patchAfterRelease: 1,
      });
  const nextAlphaVersion = stripTagPrefix(selectedNextAlpha.tag);
  let nextAlphaSha = versionState ? selectedNextAlpha.sha : sha;
  if (versionState && selectedNextAlpha.exists && nextAlphaSha) {
    updates.push({
      version: nextAlphaVersion,
      action: "existing-version-state",
      sha: nextAlphaSha,
    });
  } else if (versionState) {
    const nextAlphaRef = `alpha/v${majorRule.major}/v${majorRule.major}.0`;
    const nextAlphaBaseSha =
      (await readRefSha(`heads/${nextAlphaRef}`)) || releaseSha;
    const nextAlphaCommit = await createVersionStateCommit({
      baseSha: nextAlphaBaseSha,
      version: nextAlphaVersion,
      message: `chore(release): prepare ${selectedNextAlpha.tag}`,
    });
    nextAlphaSha = nextAlphaCommit.sha;
  }
  if (versionState) {
    const nextAlphaUpdate = await updateBranch(
      `alpha/v${majorRule.major}/v${majorRule.major}.0`,
      nextAlphaSha,
      "updated",
      {
        title: `Prepare ${selectedNextAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
        allowPendingPullRequest: true,
      },
    );
    if (nextAlphaUpdate.pending) {
      return withPublishTransaction(
        {
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          nextAlphaSha,
          targetRef,
          pendingPullRequest:
            nextAlphaUpdate.pullRequest.html_url ||
            nextAlphaUpdate.pullRequest.url,
          updates,
        },
        { finalizationNeeded: true },
      );
    }
    const nextDevRef = `dev/v${majorRule.major}/v${majorRule.major}.0`;
    await updateBranch(nextDevRef, nextAlphaSha, "updated", {
      title: `Prepare ${selectedNextAlpha.tag}`,
      body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
    });
    await updateDefaultBranch(nextDevRef);
  }
  await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
  await updateTag(majorRule.alphaTag, nextAlphaSha);
  await updateTag(majorRule.majorAlphaTag, nextAlphaSha);
  return withPublishTransaction({
    owner,
    repo,
    sourceSha: sha,
    sha: releaseSha,
    nextAlphaSha,
    targetRef,
    updates,
  });
}

export { promoteMajorChannel };

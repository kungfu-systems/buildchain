async function promoteReleaseChannel(context) {
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
    alphaTagsForPatch,
    collectRemoteVersionMaterial,
    currentReleaseVersionState,
    getCommitInfo,
    latestAlphaForPatch,
    readDurableTransactionForVersion,
    releaseCommitIncludesTransactionHead,
    resumableReleaseTransactionState,
    selectAlphaTag,
    selectReleaseTag,
    stripTagPrefix,
    transactionAcceptedExactTagShas,
    transactionHasPublishedMaterial,
  } = context;
  const explicitReleaseTags = requestedTags
    ? requestedTags.filter(
        (tag) =>
          !tag.includes("-alpha.") && tag.startsWith(`${rule.releasePrefix}.`),
      )
    : [];
  if (explicitReleaseTags.length > 1) {
    throw new Error("Release promotion accepts at most one explicit patch tag");
  }
  const selectedRelease = explicitReleaseTags[0]
    ? {
        tag: explicitReleaseTags[0],
        patch: Number(explicitReleaseTags[0].split(".").pop()),
      }
    : undefined;
  const resumableRelease = selectedRelease
    ? undefined
    : await resumableReleaseTransactionState({
        octokit,
        owner,
        repo,
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
        targetRef,
        sourceSha: sha,
        expectedVersion: expectedPublicationVersion,
      });
  const currentRelease = selectedRelease
    ? undefined
    : resumableRelease ||
      currentReleaseVersionState({
        cwd,
        refs: lineRefs,
        releasePrefix: rule.releasePrefix,
      });
  const currentReleaseTransaction = currentRelease
    ? currentRelease.transaction ||
      (await readDurableTransactionForVersion({
        octokit,
        owner,
        repo,
        version: currentRelease.version,
      }))
    : undefined;
  const currentReleaseExactSha = currentRelease
    ? await readRefSha(`tags/${currentRelease.tag}`)
    : undefined;
  const currentReleaseMinorSha = currentRelease
    ? await readRefSha(`tags/${rule.minorTag}`)
    : undefined;
  const currentReleaseMajorSha = currentRelease
    ? await readRefSha(`tags/${rule.majorTag}`)
    : undefined;
  const currentReleaseAcceptedExactShas = transactionAcceptedExactTagShas(
    currentReleaseTransaction,
    sha,
  );
  const currentReleaseSettled =
    currentRelease &&
    currentReleaseMinorSha === sha &&
    currentReleaseMajorSha === sha &&
    currentReleaseExactSha &&
    currentReleaseAcceptedExactShas.includes(currentReleaseExactSha);
  const selectedReleaseCandidate =
    selectedRelease ||
    (currentRelease && !currentReleaseSettled
      ? currentRelease
      : selectReleaseTag({
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          sha,
        }));
  const sourceAlpha = latestAlphaForPatch(
    lineRefs,
    rule.releasePrefix,
    selectedReleaseCandidate.patch,
  );
  let sourceAlphaMaterial =
    (await findAlphaMaterialFromPromotionPullRequest({
      commitSha: sha,
      targetRef,
      releasePrefix: rule.releasePrefix,
      patch: selectedReleaseCandidate.patch,
      refs: lineRefs,
    })) || sourceAlpha;
  if (currentReleaseTransaction?.source_sha) {
    for (const candidate of alphaTagsForPatch(
      lineRefs,
      rule.releasePrefix,
      selectedReleaseCandidate.patch,
    )) {
      if (!candidate.sha) {
        continue;
      }
      if (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: currentReleaseTransaction.source_sha,
          transactionReleaseSha: candidate.sha,
        })
      ) {
        sourceAlphaMaterial = candidate;
        break;
      }
    }
  }
  const currentReleaseContainsPublishedMaterial =
    currentRelease &&
    currentReleaseTransaction &&
    ["published", "finalizing", "complete"].includes(
      currentReleaseTransaction.state || "",
    ) &&
    transactionHasPublishedMaterial(currentReleaseTransaction) &&
    currentRelease.version === currentReleaseTransaction.version &&
    currentRelease.tag === currentReleaseTransaction.exact_tag &&
    currentReleaseTransaction.target_ref === targetRef &&
    (!expectedPublicationVersion ||
      expectedPublicationVersion === currentReleaseTransaction.version) &&
    ((await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: sha,
      transactionReleaseSha: currentReleaseTransaction.release_sha,
    })) ||
      (await releaseCommitIncludesTransactionHead({
        octokit,
        owner,
        repo,
        releaseSha: sha,
        transactionReleaseSha: currentReleaseTransaction.release_material_sha,
      })));
  const floatingAlphaSha = sourceAlpha?.sha
    ? await readRefSha(`tags/${rule.alphaTag}`)
    : undefined;
  if (
    sourceAlpha?.sha &&
    floatingAlphaSha &&
    floatingAlphaSha !== sourceAlpha.sha
  ) {
    const floatingContainsExact = await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: floatingAlphaSha,
      transactionReleaseSha: sourceAlpha.sha,
    });
    const targetContainsFloating = await releaseCommitIncludesTransactionHead({
      octokit,
      owner,
      repo,
      releaseSha: sha,
      transactionReleaseSha: floatingAlphaSha,
    });
    if (floatingContainsExact && targetContainsFloating) {
      sourceAlphaMaterial = {
        ...sourceAlpha,
        tag: rule.alphaTag,
        exactTag: sourceAlpha.tag,
        sha: floatingAlphaSha,
      };
    }
  }
  const releaseVersion = stripTagPrefix(selectedReleaseCandidate.tag);
  const releaseCommit = await createVersionStateCommit({
    baseSha: sha,
    version: releaseVersion,
    message: `chore(release): release ${selectedReleaseCandidate.tag}`,
    preserveExistingLifecycleIdentity: Boolean(
      currentReleaseContainsPublishedMaterial,
    ),
  });
  const releaseSha = releaseCommit.sha;
  if (requireGovernance && !dryRun) {
    if (!sourceAlpha?.sha) {
      throw new Error(
        `Release promotion requires an existing ${rule.releasePrefix}.${selectedReleaseCandidate.patch}-alpha.N tag`,
      );
    }
    const alphaCommit = await getCommitInfo(
      octokit,
      owner,
      repo,
      sourceAlphaMaterial.sha,
    );
    const releaseTreeAllowedPaths =
      releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
    await assertReleasePrOrVersionStateParent({
      commitSha: releaseSha,
      targetRef,
      alphaSha: sourceAlphaMaterial.sha,
      alphaTag: sourceAlphaMaterial.tag,
      alphaTreeSha: alphaCommit.treeSha,
      allowedPaths: releaseTreeAllowedPaths,
      allowDirectAllowedChanges:
        releaseCommit.action === "anchored-manual" &&
        releaseCommit.versionStrategy?.strategy === "anchored" &&
        releaseCommit.versionStrategy?.next === "manual" &&
        releaseCommit.files.length > 0 &&
        Boolean(releaseCommit.anchorManifest) &&
        releaseCommit.hasVersionVerification,
      exactReleaseCandidateSource: promoteOnlyReleaseCandidate
        ? releaseCandidateValidation
        : undefined,
    });
  }
  const promotionVersionMaterial =
    releaseCommit.derivedVersionMaterial?.length > 0 && sourceAlphaMaterial?.sha
      ? await (async () => {
          const allowedPaths =
            releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
          const [
            alphaCommit,
            releaseCommitInfo,
            alphaMaterial,
            releaseMaterial,
          ] = await Promise.all([
            getCommitInfo(octokit, owner, repo, sourceAlphaMaterial.sha),
            getCommitInfo(octokit, owner, repo, releaseSha),
            collectRemoteVersionMaterial({
              octokit,
              owner,
              repo,
              commitSha: sourceAlphaMaterial.sha,
              paths: allowedPaths,
            }),
            collectRemoteVersionMaterial({
              octokit,
              owner,
              repo,
              commitSha: releaseSha,
              paths: allowedPaths,
            }),
          ]);
          return {
            schemaVersion: 1,
            contract: "kungfu-buildchain-anchored-version-material/v1",
            strategy: releaseCommit.versionStrategy,
            alpha: {
              ref: sourceAlphaMaterial.tag,
              commit: sourceAlphaMaterial.sha,
              tree: alphaCommit.treeSha,
              material: alphaMaterial,
            },
            release: {
              ref: targetRef,
              commit: releaseSha,
              tree: releaseCommitInfo.treeSha,
              material: releaseMaterial,
            },
            allowedPaths,
            versionFiles: releaseCommit.files,
            manifest: releaseCommit.anchorManifest?.path || "",
            derivedPaths: releaseCommit.derivedVersionMaterial.map(
              (file) => file.path,
            ),
            derivedFiles: releaseCommit.derivedVersionMaterial,
          };
        })()
      : undefined;
  await executePublishTransaction({
    version: releaseCommit.publishVersion || releaseVersion,
    exactTag: selectedReleaseCandidate.tag,
    channel: rule.channel,
    line: rule.releasePrefix,
    releaseSha,
    releaseCandidateVersion: stripTagPrefix(
      sourceAlphaMaterial?.exactTag || sourceAlphaMaterial?.tag || "",
    ),
    allowVersionStateFinalization: releaseCommit.action === "existing",
  });
  if (versionState) {
    await markFinalizing();
    const targetUpdate = await updateBranch(targetRef, releaseSha, "updated", {
      title: `Release ${selectedReleaseCandidate.tag}`,
      body: `Create the generated version-state commit for ${selectedReleaseCandidate.tag}.`,
      allowPendingPullRequest: true,
    });
    if (targetUpdate.pending) {
      return withPublishTransaction(
        {
          owner,
          repo,
          sourceSha: sha,
          sha: releaseSha,
          targetRef,
          pendingPullRequest:
            targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
          updates,
        },
        { finalizationNeeded: true },
      );
    }
  }
  await markFinalizing();
  await ensureTag(selectedReleaseCandidate.tag, releaseSha, {
    acceptedExistingShas: transactionAcceptedExactTagShas(
      getLatestPublishTransaction()?.transaction || currentReleaseTransaction,
      releaseSha,
    ),
    acceptedExistingMaterialShas: transactionAcceptedExactTagShas(
      getLatestPublishTransaction()?.transaction || currentReleaseTransaction,
      "",
    ),
  });
  await updateTag(rule.minorTag, releaseSha);
  const ownsMajorFloatingTag = await shouldPromoteMajorTag();
  if (ownsMajorFloatingTag) {
    await updateTag(rule.majorTag, releaseSha);
  } else {
    updates.push({
      tag: rule.majorTag,
      action: "skipped-next-minor-exists",
      sha: releaseSha,
    });
  }
  await markComplete();

  try {
    if (releaseCommit.versionStrategy?.next === "manual") {
      if (ownsMajorFloatingTag) {
        await updateDefaultBranch(
          `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
        );
      }
      updates.push({
        ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
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
        versionMaterial: promotionVersionMaterial,
        updates,
      });
    }

    const explicitAlphaTags = requestedTags
      ? requestedTags.filter((tag) => tag.includes("-alpha."))
      : [];
    if (explicitAlphaTags.length > 1) {
      throw new Error(
        "Release promotion accepts at most one explicit next-alpha tag",
      );
    }
    const selectedNextAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : selectAlphaTag({
          refs: lineRefs,
          releasePrefix: rule.releasePrefix,
          sha: releaseSha,
          patchAfterRelease: selectedReleaseCandidate.patch + 1,
        });
    const nextAlphaVersion = stripTagPrefix(selectedNextAlpha.tag);
    let nextAlphaSha = versionState ? selectedNextAlpha.sha : sha;
    let nextAlphaVersionStateFiles = [];
    if (versionState && selectedNextAlpha.exists && nextAlphaSha) {
      updates.push({
        version: nextAlphaVersion,
        action: "existing-version-state",
        sha: nextAlphaSha,
      });
    } else if (versionState) {
      const nextAlphaCommit = await createVersionStateCommit({
        baseSha: releaseSha,
        version: nextAlphaVersion,
        message: `chore(release): prepare ${selectedNextAlpha.tag}`,
      });
      nextAlphaSha = nextAlphaCommit.sha;
      nextAlphaVersionStateFiles = nextAlphaCommit.files || [];
    }
    if (versionState) {
      const nextDevRef = `dev/v${rule.major}/v${rule.major}.${rule.minor}`;
      if (ownsMajorFloatingTag) {
        await updateDefaultBranch(nextDevRef);
      }
      const nextAlphaRef = `alpha/v${rule.major}/v${rule.major}.${rule.minor}`;
      const nextAlphaUpdate = await updateBranch(
        nextAlphaRef,
        nextAlphaSha,
        "updated",
        {
          title: `Prepare ${selectedNextAlpha.tag}`,
          body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
          allowPendingPullRequest: true,
          allowMergeCommitOnNonFastForward: true,
          allowMergeCommitOnNonFastForwardPaths: nextAlphaVersionStateFiles,
        },
      );
      if (nextAlphaUpdate.pending) {
        return withPublishTransaction({
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
        });
      }
      if (nextAlphaUpdate.mergeSha) {
        nextAlphaSha = nextAlphaUpdate.mergeSha;
      }
      await updateBranch(nextDevRef, nextAlphaSha, "updated", {
        title: `Prepare ${selectedNextAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
        allowMergeCommitOnNonFastForward: true,
        allowMergeCommitOnNonFastForwardPaths: nextAlphaVersionStateFiles,
        reconciliationVersion: nextAlphaVersion,
      });
    }
    await ensureTag(selectedNextAlpha.tag, nextAlphaSha);
    await updateTag(rule.alphaTag, nextAlphaSha);
    await updateMajorAlphaFloatingTag({ sha: nextAlphaSha });
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaSha,
      targetRef,
      versionMaterial: promotionVersionMaterial,
      updates,
    });
  } catch (error) {
    updates.push({
      ref: `dev/v${rule.major}/v${rule.major}.${rule.minor}`,
      action: "deferred-post-release-bookkeeping",
      reason: error?.message || String(error),
      sha: releaseSha,
    });
    return withPublishTransaction({
      owner,
      repo,
      sourceSha: sha,
      sha: releaseSha,
      nextAlphaRequired: true,
      targetRef,
      versionMaterial: promotionVersionMaterial,
      updates,
    });
  }
}

export { promoteReleaseChannel };

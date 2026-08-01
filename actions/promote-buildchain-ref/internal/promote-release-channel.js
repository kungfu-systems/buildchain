async function selectReleaseState(context) {
  const explicitReleaseTags = context.requestedTags
    ? context.requestedTags.filter(
        (tag) =>
          !tag.includes("-alpha.") &&
          tag.startsWith(`${context.rule.releasePrefix}.`),
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
    : await context.resumableReleaseTransactionState({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        refs: context.lineRefs,
        releasePrefix: context.rule.releasePrefix,
        targetRef: context.targetRef,
        sourceSha: context.sha,
        expectedVersion: context.expectedPublicationVersion,
      });
  const currentRelease = selectedRelease
    ? undefined
    : resumableRelease ||
      context.currentReleaseVersionState({
        cwd: context.cwd,
        refs: context.lineRefs,
        releasePrefix: context.rule.releasePrefix,
      });
  const currentReleaseTransaction = currentRelease
    ? currentRelease.transaction ||
      (await context.readDurableTransactionForVersion({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        version: currentRelease.version,
      }))
    : undefined;
  const currentReleaseExactSha = currentRelease
    ? await context.readRefSha(`tags/${currentRelease.tag}`)
    : undefined;
  const currentReleaseMinorSha = currentRelease
    ? await context.readRefSha(`tags/${context.rule.minorTag}`)
    : undefined;
  const currentReleaseMajorSha = currentRelease
    ? await context.readRefSha(`tags/${context.rule.majorTag}`)
    : undefined;
  const acceptedExactShas = context.transactionAcceptedExactTagShas(
    currentReleaseTransaction,
    context.sha,
  );
  const currentReleaseSettled =
    currentRelease &&
    currentReleaseMinorSha === context.sha &&
    currentReleaseMajorSha === context.sha &&
    currentReleaseExactSha &&
    acceptedExactShas.includes(currentReleaseExactSha);
  const selectedReleaseCandidate =
    selectedRelease ||
    (currentRelease && !currentReleaseSettled
      ? currentRelease
      : context.selectReleaseTag({
          refs: context.lineRefs,
          releasePrefix: context.rule.releasePrefix,
          sha: context.sha,
        }));
  return {
    selectedReleaseCandidate,
    currentRelease,
    currentReleaseTransaction,
  };
}

async function transactionContainedInRelease(context, transaction) {
  if (!transaction) return false;
  return (
    (await context.releaseCommitIncludesTransactionHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      releaseSha: context.sha,
      transactionReleaseSha: transaction.release_sha,
    })) ||
    (await context.releaseCommitIncludesTransactionHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      releaseSha: context.sha,
      transactionReleaseSha: transaction.release_material_sha,
    }))
  );
}

async function resolveReleaseAlphaMaterial(context, state) {
  const sourceAlpha = context.latestAlphaForPatch(
    context.lineRefs,
    context.rule.releasePrefix,
    state.selectedReleaseCandidate.patch,
  );
  let sourceAlphaMaterial =
    (await context.findAlphaMaterialFromPromotionPullRequest({
      commitSha: context.sha,
      targetRef: context.targetRef,
      releasePrefix: context.rule.releasePrefix,
      patch: state.selectedReleaseCandidate.patch,
      refs: context.lineRefs,
    })) || sourceAlpha;
  if (state.currentReleaseTransaction?.source_sha) {
    for (const candidate of context.alphaTagsForPatch(
      context.lineRefs,
      context.rule.releasePrefix,
      state.selectedReleaseCandidate.patch,
    )) {
      if (!candidate.sha) continue;
      if (
        await context.releaseCommitIncludesTransactionHead({
          octokit: context.octokit,
          owner: context.owner,
          repo: context.repo,
          releaseSha: state.currentReleaseTransaction.source_sha,
          transactionReleaseSha: candidate.sha,
        })
      ) {
        sourceAlphaMaterial = candidate;
        break;
      }
    }
  }
  const containsPublishedMaterial =
    state.currentRelease &&
    state.currentReleaseTransaction &&
    ["published", "finalizing", "complete"].includes(
      state.currentReleaseTransaction.state || "",
    ) &&
    context.transactionHasPublishedMaterial(state.currentReleaseTransaction) &&
    state.currentRelease.version === state.currentReleaseTransaction.version &&
    state.currentRelease.tag === state.currentReleaseTransaction.exact_tag &&
    state.currentReleaseTransaction.target_ref === context.targetRef &&
    (!context.expectedPublicationVersion ||
      context.expectedPublicationVersion ===
        state.currentReleaseTransaction.version) &&
    (await transactionContainedInRelease(
      context,
      state.currentReleaseTransaction,
    ));
  const floatingAlphaSha = sourceAlpha?.sha
    ? await context.readRefSha(`tags/${context.rule.alphaTag}`)
    : undefined;
  if (
    sourceAlpha?.sha &&
    floatingAlphaSha &&
    floatingAlphaSha !== sourceAlpha.sha
  ) {
    const floatingContainsExact =
      await context.releaseCommitIncludesTransactionHead({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        releaseSha: floatingAlphaSha,
        transactionReleaseSha: sourceAlpha.sha,
      });
    const targetContainsFloating =
      await context.releaseCommitIncludesTransactionHead({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        releaseSha: context.sha,
        transactionReleaseSha: floatingAlphaSha,
      });
    if (floatingContainsExact && targetContainsFloating) {
      sourceAlphaMaterial = {
        ...sourceAlpha,
        tag: context.rule.alphaTag,
        exactTag: sourceAlpha.tag,
        sha: floatingAlphaSha,
      };
    }
  }
  return {
    ...state,
    sourceAlpha,
    sourceAlphaMaterial,
    containsPublishedMaterial,
  };
}

async function collectPromotionVersionMaterial(
  context,
  releaseCommit,
  releaseSha,
  sourceAlphaMaterial,
) {
  if (
    !(releaseCommit.derivedVersionMaterial?.length > 0) ||
    !sourceAlphaMaterial?.sha
  ) {
    return undefined;
  }
  const allowedPaths =
    releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
  const [alphaCommit, releaseCommitInfo, alphaMaterial, releaseMaterial] =
    await Promise.all([
      context.getCommitInfo(
        context.octokit,
        context.owner,
        context.repo,
        sourceAlphaMaterial.sha,
      ),
      context.getCommitInfo(
        context.octokit,
        context.owner,
        context.repo,
        releaseSha,
      ),
      context.collectRemoteVersionMaterial({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        commitSha: sourceAlphaMaterial.sha,
        paths: allowedPaths,
      }),
      context.collectRemoteVersionMaterial({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
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
      ref: context.targetRef,
      commit: releaseSha,
      tree: releaseCommitInfo.treeSha,
      material: releaseMaterial,
    },
    allowedPaths,
    versionFiles: releaseCommit.files,
    manifest: releaseCommit.anchorManifest?.path || "",
    derivedPaths: releaseCommit.derivedVersionMaterial.map((file) => file.path),
    derivedFiles: releaseCommit.derivedVersionMaterial,
  };
}

async function createReleasePromotionCommit(context, state) {
  const releaseVersion = context.stripTagPrefix(
    state.selectedReleaseCandidate.tag,
  );
  const releaseCommit = await context.createVersionStateCommit({
    baseSha: context.sha,
    version: releaseVersion,
    message: `chore(release): release ${state.selectedReleaseCandidate.tag}`,
    preserveExistingLifecycleIdentity: Boolean(
      state.containsPublishedMaterial,
    ),
  });
  const releaseSha = releaseCommit.sha;
  if (context.requireGovernance && !context.dryRun) {
    if (!state.sourceAlpha?.sha) {
      throw new Error(
        `Release promotion requires an existing ${context.rule.releasePrefix}.${state.selectedReleaseCandidate.patch}-alpha.N tag`,
      );
    }
    const alphaCommit = await context.getCommitInfo(
      context.octokit,
      context.owner,
      context.repo,
      state.sourceAlphaMaterial.sha,
    );
    const allowedPaths =
      releaseCommit.releaseTreeAllowedPaths || releaseCommit.files;
    await context.assertReleasePrOrVersionStateParent({
      commitSha: releaseSha,
      targetRef: context.targetRef,
      alphaSha: state.sourceAlphaMaterial.sha,
      alphaTag: state.sourceAlphaMaterial.tag,
      alphaTreeSha: alphaCommit.treeSha,
      allowedPaths,
      allowDirectAllowedChanges:
        releaseCommit.action === "anchored-manual" &&
        releaseCommit.versionStrategy?.strategy === "anchored" &&
        releaseCommit.versionStrategy?.next === "manual" &&
        releaseCommit.files.length > 0 &&
        Boolean(releaseCommit.anchorManifest) &&
        releaseCommit.hasVersionVerification,
      exactReleaseCandidateSource: context.promoteOnlyReleaseCandidate
        ? context.releaseCandidateValidation
        : undefined,
    });
  }
  const promotionVersionMaterial = await collectPromotionVersionMaterial(
    context,
    releaseCommit,
    releaseSha,
    state.sourceAlphaMaterial,
  );
  return {
    ...state,
    releaseVersion,
    releaseCommit,
    releaseSha,
    promotionVersionMaterial,
  };
}

async function finalizeReleasePublication(context, state) {
  await context.executePublishTransaction({
    version: state.releaseCommit.publishVersion || state.releaseVersion,
    exactTag: state.selectedReleaseCandidate.tag,
    channel: context.rule.channel,
    line: context.rule.releasePrefix,
    releaseSha: state.releaseSha,
    releaseCandidateVersion: context.stripTagPrefix(
      state.sourceAlphaMaterial?.exactTag ||
        state.sourceAlphaMaterial?.tag ||
        "",
    ),
    allowVersionStateFinalization: state.releaseCommit.action === "existing",
  });
  if (context.versionState) {
    await context.markFinalizing();
    const targetUpdate = await context.updateBranch(
      context.targetRef,
      state.releaseSha,
      "updated",
      {
        title: `Release ${state.selectedReleaseCandidate.tag}`,
        body: `Create the generated version-state commit for ${state.selectedReleaseCandidate.tag}.`,
        allowPendingPullRequest: true,
      },
    );
    if (targetUpdate.pending) {
      return {
        result: context.withPublishTransaction(
          {
            owner: context.owner,
            repo: context.repo,
            sourceSha: context.sha,
            sha: state.releaseSha,
            targetRef: context.targetRef,
            pendingPullRequest:
              targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
            updates: context.updates,
          },
          { finalizationNeeded: true },
        ),
      };
    }
  }
  await context.markFinalizing();
  const transaction =
    context.getLatestPublishTransaction()?.transaction ||
    state.currentReleaseTransaction;
  await context.ensureTag(
    state.selectedReleaseCandidate.tag,
    state.releaseSha,
    {
      acceptedExistingShas: context.transactionAcceptedExactTagShas(
        transaction,
        state.releaseSha,
      ),
      acceptedExistingMaterialShas: context.transactionAcceptedExactTagShas(
        transaction,
        "",
      ),
    },
  );
  await context.updateTag(context.rule.minorTag, state.releaseSha);
  const ownsMajorFloatingTag = await context.shouldPromoteMajorTag();
  if (ownsMajorFloatingTag) {
    await context.updateTag(context.rule.majorTag, state.releaseSha);
  } else {
    context.updates.push({
      tag: context.rule.majorTag,
      action: "skipped-next-minor-exists",
      sha: state.releaseSha,
    });
  }
  await context.markComplete();
  return { ...state, ownsMajorFloatingTag };
}

async function prepareReleaseNextAlpha(context, state) {
  try {
    if (state.releaseCommit.versionStrategy?.next === "manual") {
      if (state.ownsMajorFloatingTag) {
        await context.updateDefaultBranch(
          `dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`,
        );
      }
      context.updates.push({
        ref: `dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`,
        action: "next-anchor-required",
        versionStrategy: state.releaseCommit.versionStrategy.strategy,
        manifest: state.releaseCommit.anchorManifest?.path,
        sha: state.releaseSha,
      });
      return context.withPublishTransaction({
        owner: context.owner,
        repo: context.repo,
        sourceSha: context.sha,
        sha: state.releaseSha,
        nextAlphaRequired: true,
        targetRef: context.targetRef,
        versionMaterial: state.promotionVersionMaterial,
        updates: context.updates,
      });
    }
    const explicitAlphaTags = context.requestedTags
      ? context.requestedTags.filter((tag) => tag.includes("-alpha."))
      : [];
    if (explicitAlphaTags.length > 1) {
      throw new Error(
        "Release promotion accepts at most one explicit next-alpha tag",
      );
    }
    const selectedNextAlpha = explicitAlphaTags[0]
      ? { tag: explicitAlphaTags[0] }
      : context.selectAlphaTag({
          refs: context.lineRefs,
          releasePrefix: context.rule.releasePrefix,
          sha: state.releaseSha,
          patchAfterRelease: state.selectedReleaseCandidate.patch + 1,
        });
    const nextAlphaVersion = context.stripTagPrefix(selectedNextAlpha.tag);
    let nextAlphaSha = context.versionState
      ? selectedNextAlpha.sha
      : context.sha;
    let nextAlphaVersionStateFiles = [];
    if (context.versionState && selectedNextAlpha.exists && nextAlphaSha) {
      context.updates.push({
        version: nextAlphaVersion,
        action: "existing-version-state",
        sha: nextAlphaSha,
      });
    } else if (context.versionState) {
      const nextAlphaCommit = await context.createVersionStateCommit({
        baseSha: state.releaseSha,
        version: nextAlphaVersion,
        message: `chore(release): prepare ${selectedNextAlpha.tag}`,
      });
      nextAlphaSha = nextAlphaCommit.sha;
      nextAlphaVersionStateFiles = nextAlphaCommit.files || [];
    }
    if (context.versionState) {
      const nextDevRef = `dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`;
      if (state.ownsMajorFloatingTag) {
        await context.updateDefaultBranch(nextDevRef);
      }
      const nextAlphaRef = `alpha/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`;
      const nextAlphaUpdate = await context.updateBranch(
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
        return context.withPublishTransaction({
          owner: context.owner,
          repo: context.repo,
          sourceSha: context.sha,
          sha: state.releaseSha,
          nextAlphaSha,
          targetRef: context.targetRef,
          pendingPullRequest:
            nextAlphaUpdate.pullRequest.html_url ||
            nextAlphaUpdate.pullRequest.url,
          updates: context.updates,
        });
      }
      if (nextAlphaUpdate.mergeSha) nextAlphaSha = nextAlphaUpdate.mergeSha;
      await context.updateBranch(nextDevRef, nextAlphaSha, "updated", {
        title: `Prepare ${selectedNextAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
        allowMergeCommitOnNonFastForward: true,
        allowMergeCommitOnNonFastForwardPaths: nextAlphaVersionStateFiles,
        reconciliationVersion: nextAlphaVersion,
      });
    }
    await context.ensureTag(selectedNextAlpha.tag, nextAlphaSha);
    await context.updateTag(context.rule.alphaTag, nextAlphaSha);
    await context.updateMajorAlphaFloatingTag({ sha: nextAlphaSha });
    return context.withPublishTransaction({
      owner: context.owner,
      repo: context.repo,
      sourceSha: context.sha,
      sha: state.releaseSha,
      nextAlphaSha,
      targetRef: context.targetRef,
      versionMaterial: state.promotionVersionMaterial,
      updates: context.updates,
    });
  } catch (error) {
    context.updates.push({
      ref: `dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`,
      action: "deferred-post-release-bookkeeping",
      reason: error?.message || String(error),
      sha: state.releaseSha,
    });
    return context.withPublishTransaction({
      owner: context.owner,
      repo: context.repo,
      sourceSha: context.sha,
      sha: state.releaseSha,
      nextAlphaRequired: true,
      targetRef: context.targetRef,
      versionMaterial: state.promotionVersionMaterial,
      updates: context.updates,
    });
  }
}

async function promoteReleaseChannel(context) {
  const selected = await selectReleaseState(context);
  const material = await resolveReleaseAlphaMaterial(context, selected);
  const committed = await createReleasePromotionCommit(context, material);
  const finalized = await finalizeReleasePublication(context, committed);
  if (finalized.result) return finalized.result;
  return prepareReleaseNextAlpha(context, finalized);
}

export { promoteReleaseChannel };

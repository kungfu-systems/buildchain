async function planAlphaPublication(context) {
  const ownsMajorAlphaTag = await context.ownsMajorAlphaFloatingTag();
  const sharedAlphaAuthorityMajor = context.getPublishContract(
    context.loadBuildchainConfig(context.cwd),
  )?.sharedAlphaAuthorityMajor;
  const alphaPublishDistTag = context.alphaDistTagForPromotion({
    ownsMajorAlphaTag,
    line: context.rule.releasePrefix,
    publishDistTag: context.publishDistTag,
    sharedAlphaAuthorityMajor,
  });
  const explicitAlphaTags = context.requestedTags
    ? context.requestedTags.filter((tag) => tag.includes("-alpha."))
    : [];
  if (explicitAlphaTags.length > 1) {
    throw new Error(
      "Alpha promotion accepts at most one explicit prerelease tag",
    );
  }
  const currentAlpha = explicitAlphaTags[0]
    ? undefined
    : context.currentAlphaVersionState({
        cwd: context.cwd,
        refs: context.lineRefs,
        releasePrefix: context.rule.releasePrefix,
      });
  const currentAlphaTransaction = currentAlpha
    ? await context.readDurableTransactionForVersion({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        version: currentAlpha.version,
      })
    : undefined;
  const publishTransactionEnabled = Boolean(
    context.publishTransaction ||
    context.publishCommand ||
    context.getLifecycleStage(
      context.loadBuildchainConfig(context.cwd),
      "publish",
    ),
  );
  const resumableAlpha =
    explicitAlphaTags[0] || !publishTransactionEnabled
      ? undefined
      : await context.resumableAlphaTransactionState({
          octokit: context.octokit,
          owner: context.owner,
          repo: context.repo,
          cwd: context.cwd,
          refs: context.lineRefs,
          releasePrefix: context.rule.releasePrefix,
          targetRef: context.targetRef,
          sourceSha: context.sha,
          expectedVersion: context.expectedPublicationVersion,
        });
  const currentAlphaTagSha = currentAlpha
    ? await context.readRefSha(`tags/${currentAlpha.tag}`)
    : undefined;
  const currentAlphaFloatingSha = currentAlpha
    ? await context.readRefSha(`tags/${context.rule.alphaTag}`)
    : undefined;
  const currentAlphaMajorFloatingSha =
    currentAlpha && ownsMajorAlphaTag
      ? await context.readRefSha(`tags/${context.rule.majorAlphaTag}`)
      : undefined;
  const currentAlphaDevSha = currentAlpha
    ? await context.readRefSha(
        `heads/dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`,
      )
    : undefined;
  return {
    ownsMajorAlphaTag,
    alphaPublishDistTag,
    explicitAlphaTags,
    currentAlpha,
    currentAlphaTransaction,
    resumableAlpha,
    currentAlphaTagSha,
    currentAlphaFloatingSha,
    currentAlphaMajorFloatingSha,
    currentAlphaDevSha,
  };
}
function needsContainedAlphaFinalization(context, plan, recovery) {
  return Boolean(
    plan.currentAlpha &&
    recovery.transactionOpen &&
    ["published", "finalizing"].includes(
      plan.currentAlphaTransaction.state || "",
    ) &&
    context.transactionHasPublishedMaterial(plan.currentAlphaTransaction) &&
    recovery.containsTransaction &&
    plan.currentAlpha.version === plan.currentAlphaTransaction.version &&
    plan.currentAlpha.tag === plan.currentAlphaTransaction.exact_tag &&
    plan.currentAlphaTransaction.target_ref === context.targetRef &&
    (!context.expectedPublicationVersion ||
      context.expectedPublicationVersion ===
        plan.currentAlphaTransaction.version) &&
    !plan.currentAlphaTagSha,
  );
}

async function evaluateAlphaRecovery(context, plan) {
  const acceptedExactShas = context.transactionAcceptedExactTagShas(
    plan.currentAlphaTransaction,
    context.sha,
  );
  const settled =
    plan.currentAlpha &&
    plan.currentAlphaDevSha === context.sha &&
    plan.currentAlphaFloatingSha === context.sha &&
    (!plan.ownsMajorAlphaTag ||
      plan.currentAlphaMajorFloatingSha === context.sha) &&
    plan.currentAlphaTagSha &&
    acceptedExactShas.includes(plan.currentAlphaTagSha);
  const hasFinalizationRefs =
    plan.currentAlpha &&
    Boolean(
      plan.currentAlphaTagSha ||
      plan.currentAlphaFloatingSha ||
      plan.currentAlphaDevSha,
    );
  const transactionOpen =
    plan.currentAlphaTransaction &&
    !["complete", "abandoned", "failed_permanently"].includes(
      plan.currentAlphaTransaction.state,
    );
  const containsTransaction =
    transactionOpen &&
    ((await context.releaseCommitIncludesTransactionHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      releaseSha: context.sha,
      transactionReleaseSha: plan.currentAlphaTransaction.release_sha,
    })) ||
      (await context.releaseCommitIncludesTransactionHead({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        releaseSha: context.sha,
        transactionReleaseSha:
          plan.currentAlphaTransaction.release_material_sha,
      })));
  const canReplaceStaleTransaction =
    transactionOpen &&
    !containsTransaction &&
    !context.transactionHasPublishedMaterial(plan.currentAlphaTransaction);
  const canFinalize =
    plan.currentAlpha &&
    (!transactionOpen ||
      containsTransaction ||
      settled ||
      canReplaceStaleTransaction);
  const recovery = { transactionOpen, containsTransaction };
  const needsContainedPublishedFinalization = needsContainedAlphaFinalization(
    context,
    plan,
    recovery,
  );
  return {
    ...plan,
    settled,
    hasFinalizationRefs,
    transactionOpen,
    containsTransaction,
    canFinalize,
    needsContainedPublishedFinalization,
  };
}

async function finalizeContainedAlpha(context, state) {
  if (!state.needsContainedPublishedFinalization) return undefined;
  const transaction = state.currentAlphaTransaction;
  if (context.dryRun) {
    context.updates.push({
      action: "dry-run-publish-transaction",
      version: transaction.version,
      tag: transaction.exact_tag,
      publicTag: context.publicReleaseTagForTransaction(transaction),
      sha: transaction.release_sha,
      finalizationOnly: true,
    });
    context.updates.push({
      action: "contained-published-transaction-finalization",
      tag: transaction.exact_tag,
      sourceSha: transaction.source_sha,
      releaseSha: transaction.release_sha,
      currentChannelSha: context.sha,
      sha: transaction.release_sha,
    });
    return {
      owner: context.owner,
      repo: context.repo,
      sourceSha: context.sha,
      sha: context.sha,
      targetRef: context.targetRef,
      updates: context.updates,
    };
  }
  let finalizationSource;
  try {
    if (context.releasePassport) {
      finalizationSource = await context.materializeTransactionSourceWorkspace({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        cwd: context.cwd,
        sourceSha: transaction.source_sha,
      });
    }
    await context.executePublishTransaction({
      version: transaction.version,
      exactTag: transaction.exact_tag,
      channel: transaction.channel || context.rule.channel,
      line: transaction.line || context.rule.releasePrefix,
      releaseSha: transaction.release_sha,
      sourceShaOverride: transaction.source_sha,
      releaseMaterialShaOverride:
        transaction.release_material_sha || transaction.release_sha,
      publishToolingShaOverride:
        transaction.publish_tooling_sha || transaction.release_sha,
      publishDistTagOverride: state.alphaPublishDistTag,
      durablePublicationMaterial: transaction,
    });
    await context.markFinalizing();
    await context.ensureTag(transaction.exact_tag, transaction.source_sha, {
      acceptedExistingShas: context.transactionAcceptedExactTagShas(
        transaction,
        transaction.source_sha,
      ),
    });
    await context.updateTag(context.rule.alphaTag, transaction.release_sha);
    await context.updateMajorAlphaFloatingTag({ sha: transaction.release_sha });
    await context.markComplete({
      passportCwd: finalizationSource?.workspace || context.cwd,
      passportBuildSummaryPath: "",
      passportPlatformManifestPaths: [],
      passportPromotionRoutingJson: "",
      passportKfd1WitnessJsons: [],
      passportKfd2ClaimJsons: [],
      passportKfd3PrebuildWitnessJsons: [],
      passportKfd3ArtifactWitnessJsons: [],
      passportKfdAdopterManifestJson: "",
      passportKfdSupportMatrixJson: "",
      passportKfdProductGateJsons: [],
      passportInvariantPassportJsons: [],
      passportReleaseCandidateValidation: null,
    });
  } finally {
    if (finalizationSource?.root) {
      context.fs.rmSync(finalizationSource.root, {
        recursive: true,
        force: true,
      });
    }
  }
  context.updates.push({
    action: "finalized-contained-published-transaction",
    tag: transaction.exact_tag,
    sourceSha: transaction.source_sha,
    releaseSha: transaction.release_sha,
    currentChannelSha: context.sha,
    sha: transaction.release_sha,
  });
  return context.withPublishTransaction({
    owner: context.owner,
    repo: context.repo,
    sourceSha: context.sha,
    sha: context.sha,
    targetRef: context.targetRef,
    updates: context.updates,
  });
}

function selectAlphaCandidate(context, state) {
  const advanced = context.advancedPublicationTransaction;
  if (advanced) return { tag: advanced.exact_tag, transaction: advanced };
  if (state.explicitAlphaTags[0]) return { tag: state.explicitAlphaTags[0] };
  if (state.transactionOpen && state.containsTransaction && !state.settled) {
    return state.currentAlpha;
  }
  if (
    state.currentAlpha &&
    state.canFinalize &&
    state.hasFinalizationRefs &&
    !state.currentAlphaTagSha
  ) {
    return state.currentAlpha;
  }
  if (state.resumableAlpha) return state.resumableAlpha;
  if (
    state.transactionOpen &&
    state.currentAlpha &&
    state.containsTransaction &&
    !state.currentAlphaTagSha
  ) {
    return state.currentAlpha;
  }
  return context.selectAlphaTag({
    refs: context.lineRefs,
    releasePrefix: context.rule.releasePrefix,
    sha: context.sha,
  });
}

async function settleExistingAlpha(context, state, selectedAlpha) {
  if (!(await context.isSettledAlphaVersionState(selectedAlpha))) {
    return undefined;
  }
  context.updates.push({
    ref: context.targetRef,
    action: "already-promoted",
    sha: context.sha,
  });
  context.updates.push({
    ref: `dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`,
    action: "already-promoted",
    sha: context.sha,
  });
  context.updates.push({
    tag: selectedAlpha.tag,
    action: "existing",
    sha: context.sha,
  });
  context.updates.push({
    tag: context.rule.alphaTag,
    action: "existing",
    sha: context.sha,
  });
  context.updates.push(
    state.ownsMajorAlphaTag
      ? {
          tag: context.rule.majorAlphaTag,
          action: "existing",
          sha: context.sha,
        }
      : {
          tag: context.rule.majorAlphaTag,
          action: "skipped-newer-minor-alpha-exists",
          sha: context.sha,
        },
  );
  if (context.publishTransaction || context.publishCommand) {
    const settledVersion =
      selectedAlpha.version || context.stripTagPrefix(selectedAlpha.tag);
    await context.executePublishTransaction({
      version: settledVersion,
      exactTag: selectedAlpha.tag,
      channel: context.rule.channel,
      line: context.rule.releasePrefix,
      releaseSha: context.sha,
      publishDistTagOverride: state.alphaPublishDistTag,
      allowVersionStateFinalization: true,
    });
    if (!context.dryRun && context.getLatestPublishTransaction()) {
      await context.markFinalizing();
      await context.markComplete();
    }
  }
  return context.withPublishTransaction({
    owner: context.owner,
    repo: context.repo,
    sourceSha: context.sha,
    sha: context.sha,
    targetRef: context.targetRef,
    updates: context.updates,
  });
}

async function prepareAlphaCommit(context, candidate) {
  const version = context.stripTagPrefix(candidate.tag);
  if (candidate.transaction?.release_sha) {
    return {
      version,
      publishVersion: version,
      commit: { action: "existing-publish-transaction", files: [] },
      sha: candidate.transaction.release_sha,
    };
  }
  const commit = await context.createVersionStateCommit({
    baseSha: context.sha,
    version,
    message: `chore(release): prepare ${candidate.tag}`,
  });
  if (context.requireGovernance && !context.dryRun) {
    await context.assertPromotionPrOrVersionStateParent({
      commitSha: context.sha,
      targetRef: context.targetRef,
      allowedPaths: commit.files,
    });
  }
  return {
    version,
    publishVersion: commit.publishVersion || version,
    commit,
    sha: commit.sha,
  };
}

async function publishAlphaCandidate(context, state, initialCandidate) {
  let selectedAlpha = initialCandidate;
  let alpha = await prepareAlphaCommit(context, selectedAlpha);
  const currentRequiresNewPublication =
    state.currentAlpha &&
    selectedAlpha.tag === state.currentAlpha.tag &&
    state.transactionOpen &&
    context.transactionHasPublishedMaterial(state.currentAlphaTransaction) &&
    !["existing", "existing-publish-transaction"].includes(alpha.commit.action);
  if (currentRequiresNewPublication) {
    context.updates.push({
      tag: selectedAlpha.tag,
      action: "advanced-published-transaction",
      sha: alpha.sha,
    });
    selectedAlpha = context.selectAlphaTag({
      refs: context.lineRefs,
      releasePrefix: context.rule.releasePrefix,
      sha: context.sha,
    });
    alpha = await prepareAlphaCommit(context, selectedAlpha);
  }
  try {
    await context.executePublishTransaction({
      version: alpha.publishVersion || alpha.version,
      exactTag: selectedAlpha.tag,
      channel: context.rule.channel,
      line: context.rule.releasePrefix,
      releaseSha: alpha.sha,
      publishDistTagOverride: state.alphaPublishDistTag,
      allowVersionStateFinalization:
        state.currentAlpha &&
        selectedAlpha.tag === state.currentAlpha.tag &&
        alpha.commit.action === "existing",
    });
  } catch (error) {
    const staleCurrentAlpha =
      state.currentAlpha &&
      selectedAlpha.tag === state.currentAlpha.tag &&
      /release transaction identity mismatch/.test(error.message || "");
    if (!staleCurrentAlpha) throw error;
    context.updates.push({
      tag: selectedAlpha.tag,
      action: "stale-publish-transaction",
      sha: alpha.sha,
    });
    selectedAlpha = context.selectAlphaTag({
      refs: context.lineRefs,
      releasePrefix: context.rule.releasePrefix,
      sha: context.sha,
    });
    alpha = await prepareAlphaCommit(context, selectedAlpha);
    await context.executePublishTransaction({
      version: alpha.publishVersion || alpha.version,
      exactTag: selectedAlpha.tag,
      channel: context.rule.channel,
      line: context.rule.releasePrefix,
      releaseSha: alpha.sha,
      publishDistTagOverride: state.alphaPublishDistTag,
    });
  }
  return { selectedAlpha, alpha };
}

async function finalizeAlphaPublication(context, state, publication) {
  const { selectedAlpha, alpha } = publication;
  if (context.advancedPublicationTransaction) {
    await context.markFinalizing();
    const transaction =
      context.getLatestPublishTransaction()?.transaction ||
      context.advancedPublicationTransaction;
    const exactTagSha = transaction?.source_sha || alpha.sha;
    await context.ensureTag(selectedAlpha.tag, exactTagSha, {
      acceptedExistingShas: context.transactionAcceptedExactTagShas(
        transaction,
        exactTagSha,
      ),
      acceptedExistingMaterialShas: context.transactionAcceptedExactTagShas(
        transaction,
        "",
      ),
    });
    await context.markComplete();
    context.updates.push({
      action: "finalized-advanced-publication",
      tag: selectedAlpha.tag,
      sourceSha: context.sha,
      releaseSha: alpha.sha,
      currentChannelSha: context.advancedChannelSha,
      sha: alpha.sha,
    });
    return context.withPublishTransaction({
      owner: context.owner,
      repo: context.repo,
      sourceSha: context.sha,
      sha: context.advancedChannelSha || context.sha,
      targetRef: context.targetRef,
      updates: context.updates,
    });
  }
  if (context.versionState) {
    await context.markFinalizing();
    const targetUpdate = await context.updateBranch(
      context.targetRef,
      alpha.sha,
      "updated",
      {
        title: `Prepare ${selectedAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedAlpha.tag}.`,
        allowPendingPullRequest: true,
      },
    );
    if (targetUpdate.pending) {
      return context.withPublishTransaction(
        {
          owner: context.owner,
          repo: context.repo,
          sourceSha: context.sha,
          sha: alpha.sha,
          targetRef: context.targetRef,
          pendingPullRequest:
            targetUpdate.pullRequest.html_url || targetUpdate.pullRequest.url,
          updates: context.updates,
        },
        { finalizationNeeded: true },
      );
    }
    const devUpdate = await context.updateBranch(
      `dev/v${context.rule.major}/v${context.rule.major}.${context.rule.minor}`,
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
      return context.withPublishTransaction(
        {
          owner: context.owner,
          repo: context.repo,
          sourceSha: context.sha,
          sha: alpha.sha,
          targetRef: context.targetRef,
          pendingPullRequest:
            devUpdate.pullRequest.html_url || devUpdate.pullRequest.url,
          updates: context.updates,
        },
        { finalizationNeeded: true },
      );
    }
  }
  await context.markFinalizing();
  const transaction =
    context.getLatestPublishTransaction()?.transaction ||
    state.currentAlphaTransaction;
  const exactTagSha = transaction?.source_sha || alpha.sha;
  await context.ensureTag(selectedAlpha.tag, exactTagSha, {
    acceptedExistingShas: context.transactionAcceptedExactTagShas(
      transaction,
      exactTagSha,
    ),
    acceptedExistingMaterialShas: context.transactionAcceptedExactTagShas(
      transaction,
      "",
    ),
  });
  await context.updateTag(context.rule.alphaTag, alpha.sha);
  await context.updateMajorAlphaFloatingTag({ sha: alpha.sha });
  await context.markComplete();
  return context.withPublishTransaction({
    owner: context.owner,
    repo: context.repo,
    sourceSha: context.sha,
    sha: alpha.sha,
    targetRef: context.targetRef,
    updates: context.updates,
  });
}
async function promoteAlphaChannel(context) {
  const plan = await planAlphaPublication(context);
  const state = await evaluateAlphaRecovery(context, plan);
  const contained = await finalizeContainedAlpha(context, state);
  if (contained) return contained;
  const selectedAlpha = selectAlphaCandidate(context, state);
  const settled = await settleExistingAlpha(context, state, selectedAlpha);
  if (settled) return settled;
  const publication = await publishAlphaCandidate(
    context,
    state,
    selectedAlpha,
  );
  return finalizeAlphaPublication(context, state, publication);
}

export { promoteAlphaChannel, selectAlphaCandidate };

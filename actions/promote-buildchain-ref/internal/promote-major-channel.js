async function resolveMajorGate(context) {
  try {
    return await context.getMajorGateSource({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      sha: context.sha,
      targetRef: context.targetRef,
    });
  } catch (directError) {
    const commit = await context.getCommitInfo(
      context.octokit,
      context.owner,
      context.repo,
      context.sha,
    );
    for (const parentSha of commit.parents) {
      try {
        return await context.getMajorGateSource({
          octokit: context.octokit,
          owner: context.owner,
          repo: context.repo,
          sha: parentSha,
          targetRef: context.targetRef,
        });
      } catch {
        // Try the next parent before surfacing the direct lineage failure.
      }
    }
    throw directError;
  }
}

function containedMajorTransaction({
  transaction,
  version,
  exactTag,
  exactTagSha,
  acceptedExactShas,
  containsTransaction,
  majorRule,
  targetRef,
  expectedPublicationVersion,
  hasPublishedMaterial,
}) {
  return (
    transaction &&
    ["published", "finalizing", "complete"].includes(transaction.state || "") &&
    hasPublishedMaterial &&
    transaction.version === version &&
    transaction.exact_tag === exactTag &&
    transaction.target_ref === targetRef &&
    transaction.channel === (majorRule.channel || "major") &&
    transaction.line === majorRule.releasePrefix &&
    (!expectedPublicationVersion ||
      expectedPublicationVersion === transaction.version) &&
    containsTransaction &&
    (!exactTagSha || acceptedExactShas.includes(exactTagSha))
      ? transaction
      : undefined
  );
}

async function planMajorRelease(context) {
  const majorGate = await resolveMajorGate(context);
  const majorRule = {
    ...context.rule,
    ...majorGate,
    majorAlphaTag: `v${majorGate.major}-alpha`,
    tags: [majorGate.majorTag, majorGate.minorTag],
  };
  const refs = await context.listLineRefs(majorRule.releasePrefix);
  const explicitReleaseTags = context.requestedTags
    ? context.requestedTags.filter(
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
  const initialMajorVersion = context.stripTagPrefix(initialMajorTag);
  const initialMajorTransaction = explicitReleaseTags[0]
    ? undefined
    : await context.readDurableTransactionForVersion({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        version: initialMajorVersion,
      });
  const initialMajorExactSha = initialMajorTransaction
    ? await context.readRefSha(`tags/${initialMajorTag}`)
    : undefined;
  const initialMajorContainsTransaction =
    initialMajorTransaction &&
    ((await context.releaseCommitIncludesTransactionHead({
      octokit: context.octokit,
      owner: context.owner,
      repo: context.repo,
      releaseSha: context.sha,
      transactionReleaseSha: initialMajorTransaction.release_sha,
    })) ||
      (await context.releaseCommitIncludesTransactionHead({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        releaseSha: context.sha,
        transactionReleaseSha: initialMajorTransaction.release_material_sha,
      })));
  const acceptedExactShas = context.transactionAcceptedExactTagShas(
    initialMajorTransaction,
    context.sha,
  );
  const containedPublishedMajorTransaction = containedMajorTransaction({
    transaction: initialMajorTransaction,
    version: initialMajorVersion,
    exactTag: initialMajorTag,
    exactTagSha: initialMajorExactSha,
    acceptedExactShas,
    containsTransaction: initialMajorContainsTransaction,
    majorRule,
    targetRef: context.targetRef,
    expectedPublicationVersion: context.expectedPublicationVersion,
    hasPublishedMaterial:
      context.transactionHasPublishedMaterial(initialMajorTransaction),
  });
  if (containedPublishedMajorTransaction && context.dryRun) {
    context.updates.push({
      action: "dry-run-publish-transaction",
      version: containedPublishedMajorTransaction.version,
      tag: containedPublishedMajorTransaction.exact_tag,
      publicTag: context.publicReleaseTagForTransaction(
        containedPublishedMajorTransaction,
      ),
      sha: containedPublishedMajorTransaction.release_sha,
      finalizationOnly: true,
    });
    context.updates.push({
      action: "contained-published-transaction-finalization",
      tag: containedPublishedMajorTransaction.exact_tag,
      sourceSha: containedPublishedMajorTransaction.source_sha,
      releaseSha: containedPublishedMajorTransaction.release_sha,
      currentChannelSha: context.sha,
      sha: containedPublishedMajorTransaction.release_sha,
    });
    return {
      result: {
        owner: context.owner,
        repo: context.repo,
        sourceSha: context.sha,
        sha: context.sha,
        targetRef: context.targetRef,
        updates: context.updates,
      },
    };
  }
  const selectedRelease = containedPublishedMajorTransaction
    ? { tag: containedPublishedMajorTransaction.exact_tag, patch: 0 }
    : explicitReleaseTags[0]
      ? {
          tag: explicitReleaseTags[0],
          patch: Number(explicitReleaseTags[0].split(".").pop()),
        }
      : context.selectReleaseTag({
          refs,
          releasePrefix: majorRule.releasePrefix,
          sha: context.sha,
        });
  if (selectedRelease.patch !== 0) {
    throw new Error(
      `publish-gate/major promotion must create the first patch of the next major line; got ${selectedRelease.tag}`,
    );
  }
  return { majorRule, refs, containedPublishedMajorTransaction, selectedRelease };
}

function majorCompletionOptions(context, plan, finalizationSource) {
  if (!plan.containedPublishedMajorTransaction) {
    return {
      channel: plan.majorRule.channel || "major",
      line: plan.majorRule.releasePrefix,
    };
  }
  return {
    channel: plan.majorRule.channel || "major",
    line: plan.majorRule.releasePrefix,
    passportCwd: finalizationSource?.workspace || context.cwd,
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
  };
}

async function publishMajorRelease(context, plan) {
  const releaseVersion = context.stripTagPrefix(plan.selectedRelease.tag);
  const releaseCommit = plan.containedPublishedMajorTransaction
    ? {
        sha: plan.containedPublishedMajorTransaction.release_sha,
        version: plan.containedPublishedMajorTransaction.version,
        action: "contained-published-transaction",
        publishVersion: plan.containedPublishedMajorTransaction.version,
        files: [],
        versionStrategy: context.getVersionStrategy(
          context.loadBuildchainConfig(context.cwd),
        ),
      }
    : await context.createVersionStateCommit({
        baseSha: context.sha,
        version: releaseVersion,
        message: `chore(release): release ${plan.selectedRelease.tag}`,
      });
  const releaseSha = releaseCommit.sha;
  if (
    context.requireGovernance &&
    !context.dryRun &&
    releaseCommit.action === "existing"
  ) {
    await context.assertPromotionPrOrVersionStateParent({
      commitSha: context.sha,
      targetRef: context.targetRef,
      allowedPaths: releaseCommit.files,
    });
  }
  let finalizationSource;
  try {
    if (plan.containedPublishedMajorTransaction && context.releasePassport) {
      finalizationSource = await context.materializeTransactionSourceWorkspace({
        octokit: context.octokit,
        owner: context.owner,
        repo: context.repo,
        cwd: context.cwd,
        sourceSha: plan.containedPublishedMajorTransaction.source_sha,
      });
    }
    await context.executePublishTransaction({
      version: releaseCommit.publishVersion || releaseVersion,
      exactTag: plan.selectedRelease.tag,
      channel: plan.majorRule.channel || "major",
      line: plan.majorRule.releasePrefix,
      releaseSha,
      sourceShaOverride:
        plan.containedPublishedMajorTransaction?.source_sha || context.sha,
      releaseMaterialShaOverride:
        plan.containedPublishedMajorTransaction?.release_material_sha ||
        plan.containedPublishedMajorTransaction?.release_sha ||
        context.releaseMaterialSha,
      publishToolingShaOverride:
        plan.containedPublishedMajorTransaction?.publish_tooling_sha ||
        plan.containedPublishedMajorTransaction?.release_sha ||
        context.publishToolingSha,
      allowVersionStateFinalization:
        releaseCommit.action === "existing" ||
        Boolean(plan.containedPublishedMajorTransaction),
    });
    if (context.versionState) {
      await context.markFinalizing();
      if (!plan.containedPublishedMajorTransaction) {
        const gateUpdate = await context.updateBranch(
          context.targetRef,
          releaseSha,
          "updated",
          {
            title: `Release ${plan.selectedRelease.tag}`,
            body: `Create the generated version-state commit for ${plan.selectedRelease.tag}.`,
            allowPendingPullRequest: true,
          },
        );
        if (gateUpdate.pending) {
          return {
            result: context.withPublishTransaction(
              {
                owner: context.owner,
                repo: context.repo,
                sourceSha: context.sha,
                sha: releaseSha,
                targetRef: context.targetRef,
                pendingPullRequest:
                  gateUpdate.pullRequest.html_url || gateUpdate.pullRequest.url,
                updates: context.updates,
              },
              { finalizationNeeded: true },
            ),
          };
        }
      }
      const releaseBranchUpdate = await context.updateBranch(
        `release/v${plan.majorRule.major}/v${plan.majorRule.major}.0`,
        releaseSha,
        "updated",
        {
          title: `Release ${plan.selectedRelease.tag}`,
          body: `Create the generated version-state commit for ${plan.selectedRelease.tag}.`,
          allowPendingPullRequest: true,
        },
      );
      if (releaseBranchUpdate.pending) {
        return {
          result: context.withPublishTransaction(
            {
              owner: context.owner,
              repo: context.repo,
              sourceSha: context.sha,
              sha: releaseSha,
              targetRef: context.targetRef,
              pendingPullRequest:
                releaseBranchUpdate.pullRequest.html_url ||
                releaseBranchUpdate.pullRequest.url,
              updates: context.updates,
            },
            { finalizationNeeded: true },
          ),
        };
      }
    }
    await context.markFinalizing();
    const transaction = context.getLatestPublishTransaction()?.transaction;
    const exactTagSha = transaction?.source_sha || releaseSha;
    await context.ensureTag(plan.selectedRelease.tag, exactTagSha, {
      acceptedExistingShas: context.transactionAcceptedExactTagShas(
        transaction || plan.containedPublishedMajorTransaction,
        exactTagSha,
      ),
    });
    await context.updateTag(plan.majorRule.minorTag, releaseSha);
    await context.updateTag(plan.majorRule.majorTag, releaseSha);
    await context.markComplete(
      majorCompletionOptions(context, plan, finalizationSource),
    );
  } finally {
    if (finalizationSource?.root) {
      context.fs.rmSync(finalizationSource.root, {
        recursive: true,
        force: true,
      });
    }
  }
  if (plan.containedPublishedMajorTransaction) {
    context.updates.push({
      action: "finalized-contained-published-transaction",
      tag: plan.containedPublishedMajorTransaction.exact_tag,
      sourceSha: plan.containedPublishedMajorTransaction.source_sha,
      releaseSha: plan.containedPublishedMajorTransaction.release_sha,
      currentChannelSha: context.sha,
      sha: plan.containedPublishedMajorTransaction.release_sha,
    });
  }
  return { releaseCommit, releaseSha };
}

async function prepareMajorNextAlpha(context, plan, published) {
  if (published.releaseCommit.versionStrategy?.next === "manual") {
    context.updates.push({
      ref: `dev/v${plan.majorRule.major}/v${plan.majorRule.major}.0`,
      action: "next-anchor-required",
      versionStrategy: published.releaseCommit.versionStrategy.strategy,
      manifest: published.releaseCommit.anchorManifest?.path,
      sha: published.releaseSha,
    });
    return context.withPublishTransaction({
      owner: context.owner,
      repo: context.repo,
      sourceSha: context.sha,
      sha: published.releaseSha,
      nextAlphaRequired: true,
      targetRef: context.targetRef,
      updates: context.updates,
    });
  }
  const explicitAlphaTags = context.requestedTags
    ? context.requestedTags.filter((tag) => tag.includes("-alpha."))
    : [];
  if (explicitAlphaTags.length > 1) {
    throw new Error(
      "publish-gate/major promotion accepts at most one explicit next-alpha tag",
    );
  }
  const selectedNextAlpha = explicitAlphaTags[0]
    ? { tag: explicitAlphaTags[0] }
    : context.selectAlphaTag({
        refs: plan.refs,
        releasePrefix: plan.majorRule.releasePrefix,
        sha: published.releaseSha,
        patchAfterRelease: 1,
      });
  const nextAlphaVersion = context.stripTagPrefix(selectedNextAlpha.tag);
  let nextAlphaSha = context.versionState
    ? selectedNextAlpha.sha
    : context.sha;
  if (context.versionState && selectedNextAlpha.exists && nextAlphaSha) {
    context.updates.push({
      version: nextAlphaVersion,
      action: "existing-version-state",
      sha: nextAlphaSha,
    });
  } else if (context.versionState) {
    const nextAlphaRef = `alpha/v${plan.majorRule.major}/v${plan.majorRule.major}.0`;
    const nextAlphaBaseSha =
      (await context.readRefSha(`heads/${nextAlphaRef}`)) || published.releaseSha;
    const nextAlphaCommit = await context.createVersionStateCommit({
      baseSha: nextAlphaBaseSha,
      version: nextAlphaVersion,
      message: `chore(release): prepare ${selectedNextAlpha.tag}`,
    });
    nextAlphaSha = nextAlphaCommit.sha;
  }
  if (context.versionState) {
    const nextAlphaUpdate = await context.updateBranch(
      `alpha/v${plan.majorRule.major}/v${plan.majorRule.major}.0`,
      nextAlphaSha,
      "updated",
      {
        title: `Prepare ${selectedNextAlpha.tag}`,
        body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
        allowPendingPullRequest: true,
      },
    );
    if (nextAlphaUpdate.pending) {
      return context.withPublishTransaction(
        {
          owner: context.owner,
          repo: context.repo,
          sourceSha: context.sha,
          sha: published.releaseSha,
          nextAlphaSha,
          targetRef: context.targetRef,
          pendingPullRequest:
            nextAlphaUpdate.pullRequest.html_url ||
            nextAlphaUpdate.pullRequest.url,
          updates: context.updates,
        },
        { finalizationNeeded: true },
      );
    }
    const nextDevRef = `dev/v${plan.majorRule.major}/v${plan.majorRule.major}.0`;
    await context.updateBranch(nextDevRef, nextAlphaSha, "updated", {
      title: `Prepare ${selectedNextAlpha.tag}`,
      body: `Create the generated version-state commit for ${selectedNextAlpha.tag}.`,
    });
    await context.updateDefaultBranch(nextDevRef);
  }
  await context.ensureTag(selectedNextAlpha.tag, nextAlphaSha);
  await context.updateTag(plan.majorRule.alphaTag, nextAlphaSha);
  await context.updateTag(plan.majorRule.majorAlphaTag, nextAlphaSha);
  return context.withPublishTransaction({
    owner: context.owner,
    repo: context.repo,
    sourceSha: context.sha,
    sha: published.releaseSha,
    nextAlphaSha,
    targetRef: context.targetRef,
    updates: context.updates,
  });
}

async function promoteMajorChannel(context) {
  const plan = await planMajorRelease(context);
  if (plan.result) return plan.result;
  const published = await publishMajorRelease(context, plan);
  if (published.result) return published.result;
  return prepareMajorNextAlpha(context, plan, published);
}

export { promoteMajorChannel };

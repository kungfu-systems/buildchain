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

function containedFinalizationPassportCwd(context, finalizationSource) {
  if (context.releaseCandidateValidation?.recoveredCandidate === true) {
    return context.cwd;
  }
  return finalizationSource?.workspace || context.cwd;
}

function containedFinalizationReleaseCandidateValidation(context) {
  const validation = context.releaseCandidateValidation;
  if (
    validation?.recoveredCandidate === true &&
    validation?.treeEquivalent === true
  ) {
    return validation;
  }
  return null;
}

function containedFinalizationKfdAdopterInputs(context, validation) {
  if (!validation) {
    return { manifestJson: "", productGateJsons: [] };
  }
  return {
    manifestJson: context.releasePassportKfdAdopterManifestJson,
    productGateJsons: context.splitPathList(
      context.releasePassportKfdProductGateJsons,
    ),
  };
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

export {
  containedFinalizationKfdAdopterInputs,
  containedFinalizationPassportCwd,
  containedFinalizationReleaseCandidateValidation,
  evaluateAlphaRecovery,
};

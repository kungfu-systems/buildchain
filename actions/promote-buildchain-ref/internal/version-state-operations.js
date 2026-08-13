import { resolveExistingVersionState } from "./existing-version-state.js";

function createVersionStateOperations(context) {
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
    releasePassportKfdAdopterManifestJson,
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
    COMMIT_IDENTITY,
    alignMajorBootstrapReleaseImpact,
    currentConfiguredVersion,
    discoverConfiguredDerivedVersionMaterial,
    discoverVersionStateFiles,
    getGitCommitWithRetry,
    getGitRefOrUndefined,
    getLifecycleStage,
    getVersionStrategy,
    loadConfiguredAnchorManifest,
    runVersionVerification,
    sha256Content,
    signedGeneratedCommitMessage,
    uniquePaths,
    updateVersionStateContents,
    versionVerificationAllowedPathsForPromotion,
    versionVerificationEnv,
  } = context;
  const createVersionStateCommit = async ({
    baseSha,
    version,
    message,
    workspaceCwd = cwd,
    parents = [baseSha],
    preserveExistingLifecycleIdentity = false,
    recoveredCandidate = releaseCandidateValidation?.recoveredCandidate === true,
  }) => {
    if (!versionState) {
      return {
        sha: baseSha,
        version,
        action: "disabled",
        files: [],
      };
    }

    const discovered = discoverVersionStateFiles(workspaceCwd);
    if (discovered.files.length === 0) {
      if (requireVersionState) {
        throw new Error("Strict promotion requires package version state");
      }
      updates.push({
        version,
        action: "skipped-no-version-state",
        packageManager: discovered.packageManager.name,
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "skipped-no-version-state",
        files: [],
        packageManager: discovered.packageManager,
      };
    }

    const discoveredPaths = discovered.files.map((file) => file.path);
    const versionStateAllowedPaths =
      versionVerificationAllowedPathsForPromotion(
        rule.channel,
        discoveredPaths,
      );
    const derivedVersionMaterial = discoverConfiguredDerivedVersionMaterial(
      workspaceCwd,
      discovered.config,
    );
    const derivedPaths = derivedVersionMaterial.map((file) => file.path);
    const versionStrategy = getVersionStrategy(discovered.config);
    const anchorManifest = loadConfiguredAnchorManifest(
      workspaceCwd,
      discovered.config,
    );
    const strategyEnv = versionVerificationEnv(
      versionStrategy,
      anchorManifest,
      {
        generatedAt: preserveExistingLifecycleIdentity
          ? ""
          : promotionGeneratedAt,
        sourceSha: preserveExistingLifecycleIdentity ? "" : sha,
        preserveExistingLifecycleIdentity,
      },
    );
    if (rule.channel === "major") {
      strategyEnv.BUILDCHAIN_MAJOR_VERSION_BOOTSTRAP = "true";
    }
    const manualNext =
      versionStrategy.strategy === "anchored" &&
      versionStrategy.next === "manual";
    const configuredVersion = manualNext
      ? currentConfiguredVersion(discovered.files)
      : undefined;
    const publishVersion = manualNext ? configuredVersion || version : version;
    const hasVersionVerification = Boolean(
      verificationCommand ||
      getLifecycleStage(discovered.config, "verify") ||
      getLifecycleStage(discovered.config, "version-state") ||
      getLifecycleStage(discovered.config, "version_state"),
    );
    const anchoredReleaseTreePaths =
      manualNext && anchorManifest && hasVersionVerification
        ? uniquePaths([
            ...discoveredPaths,
            anchorManifest.path,
            ...derivedPaths,
          ])
        : discoveredPaths;
    let changedFiles = manualNext
      ? []
      : updateVersionStateContents(discovered.files, version);
    if (rule.channel === "major" && changedFiles.length > 0) {
      changedFiles = alignMajorBootstrapReleaseImpact(changedFiles, {
        version,
      });
    }
    if (recoveredCandidate && changedFiles.length) {
      throw new Error(
        `Candidate recovery cannot rewrite version state for ${version}: ${changedFiles.map((file) => file.path).join(", ")}. Create a new candidate explicitly; recovery never rebuilds or rematerializes product state.`,
      );
    }
    const changedPaths = changedFiles.map((file) => file.path);
    console.log(
      `> version state manager: ${discovered.packageManager.name} (${discovered.packageManager.reason})`,
    );
    console.log(
      `> version strategy: ${versionStrategy.strategy}/${versionStrategy.next}`,
    );
    if (anchorManifest) {
      console.log(`> anchor manifest: ${anchorManifest.path}`);
    }
    if (derivedPaths.length > 0) {
      console.log(`> derived version material: ${derivedPaths.join(", ")}`);
    }
    console.log(`> version state files: ${discoveredPaths.join(", ")}`);
    console.log(
      `> version state changes for ${version}: ${changedPaths.length ? changedPaths.join(", ") : "none"}`,
    );
    if (preserveExistingLifecycleIdentity) {
      console.log(
        "> version state lifecycle identity: preserve the contained published transaction inputs",
      );
    }
    const createVerifiedVersionStateCommit = async (verifiedChangedFiles) => {
      const { data: baseCommit } = await getGitCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha: baseSha,
      });
      const tree = [];
      for (const file of verifiedChangedFiles) {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: "utf-8",
        });
        tree.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
      const { data: nextTree } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: baseCommit.tree.sha,
        tree,
      });
      const { data: nextCommit } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message: signedGeneratedCommitMessage(message),
        tree: nextTree.sha,
        parents,
        author: COMMIT_IDENTITY,
        committer: COMMIT_IDENTITY,
      });
      updates.push({
        version,
        action: "created-version-state",
        packageManager: discovered.packageManager.name,
        files: verifiedChangedFiles.map((file) => file.path),
        sha: nextCommit.sha,
      });
      return {
        sha: nextCommit.sha,
        version,
        action: "created",
        publishVersion,
        files: verifiedChangedFiles.map((file) => file.path),
        releaseTreeAllowedPaths: verifiedChangedFiles.map((file) => file.path),
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    };
    if (manualNext) {
      runVersionVerification({
        cwd: workspaceCwd,
        command: verificationCommand,
        loadedConfig: discovered.config,
        version,
        changedFiles: [],
        allowedPaths: anchoredReleaseTreePaths,
        env: strategyEnv,
      });
      const verifiedDerivedVersionMaterial =
        discoverConfiguredDerivedVersionMaterial(
          workspaceCwd,
          discovered.config,
        ).map((file) => ({
          path: file.path,
          bytes: file.content.length,
          sha256: sha256Content(file.content),
        }));
      updates.push({
        version,
        action: "anchored-manual-version-state",
        packageManager: discovered.packageManager.name,
        files: discoveredPaths,
        manifest: anchorManifest?.path,
        derivedVersionMaterial: verifiedDerivedVersionMaterial,
        sha: baseSha,
        publishVersion,
      });
      return {
        sha: baseSha,
        version,
        action: "anchored-manual",
        publishVersion,
        files: discoveredPaths,
        releaseTreeAllowedPaths: anchoredReleaseTreePaths,
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
        derivedVersionMaterial: verifiedDerivedVersionMaterial,
      };
    }
    const existingVersionState = resolveExistingVersionState({
      changedFiles,
      recoveredCandidate,
      version,
      dryRun,
      workspaceCwd,
      verificationCommand,
      discovered,
      discoveredPaths,
      versionStateAllowedPaths,
      strategyEnv,
      baseSha,
      publishVersion,
      hasVersionVerification,
      versionStrategy,
      anchorManifest,
      updates,
      runVersionVerification,
      createVerifiedVersionStateCommit,
    });
    if (existingVersionState) return existingVersionState;

    if (dryRun) {
      updates.push({
        version,
        action: "dry-run-version-state",
        packageManager: discovered.packageManager.name,
        files: changedFiles.map((file) => file.path),
        sha: baseSha,
      });
      return {
        sha: baseSha,
        version,
        action: "dry-run",
        publishVersion,
        files: changedFiles.map((file) => file.path),
        releaseTreeAllowedPaths: versionStateAllowedPaths,
        hasVersionVerification,
        packageManager: discovered.packageManager,
        versionStrategy,
        anchorManifest,
      };
    }

    const verifiedChangedFiles = runVersionVerification({
      cwd: workspaceCwd,
      command: verificationCommand,
      loadedConfig: discovered.config,
      version,
      changedFiles,
      allowedPaths: versionStateAllowedPaths,
      env: strategyEnv,
    });

    return createVerifiedVersionStateCommit(verifiedChangedFiles);
  };

  const shouldPromoteMajorTag = async () => {
    const nextMinorRef = await getGitRefOrUndefined({
      octokit,
      owner,
      repo,
      ref: `tags/v${rule.major}.${rule.minor + 1}`,
    });
    return !nextMinorRef;
  };
  return {
    createVersionStateCommit,
    shouldPromoteMajorTag,
  };
}

export { createVersionStateOperations };

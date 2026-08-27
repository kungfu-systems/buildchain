export function createRefMutationOperations(context, runtime) { const { COMMIT_IDENTITY, createGeneratedVersionStateChecks, ensureManagedChannelBranchProtection, execFileSync, fs, getGitCommitWithRetry, getGitRefOrUndefined, nonFastForwardUpdateRejected, notFound, ownsMajorAlphaChannel, path, protectedBranchDirectUpdateError, protectedBranchUpdateRejected, releaseCommitIncludesTransactionHead, retryGitHubOperation, signedGeneratedCommitMessage, uniqueShas, versionStateBranchName } = runtime;
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
    releasePassportEvidenceJsons,
    releasePassportAttachmentCommand,
    releasePassportBuildchainSelfKfd,
    releasePassportGitHubArtifactAttestationPolicyJsons,
    promoteOnlyReleaseCandidate,
    releaseCandidatePassportPath,
    releaseCandidateBuildSummaryPath,
    releaseCandidateVersion,
    releaseCandidateFamilyEvidenceRequired,
    releaseCandidateFamilyEvidenceRoot,
    releaseCandidateFamilyInitiativeId,
    releaseCandidateFamilyAssignmentId,
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
    getReconciliationOperations,
    getVersionStateOperations,
  } = context;
  const listLineRefs = async (releasePrefix = rule.releasePrefix) => {
    const { data: tagRefs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `tags/${releasePrefix}.`,
    });
    const statePrefix = releasePrefix.replace(/^v/, "").replaceAll(".", "-");
    const { data: stateRefs } = await octokit.rest.git.listMatchingRefs({
      owner,
      repo,
      ref: `heads/buildchain/release-state/${statePrefix}-`,
    });
    return [...tagRefs, ...stateRefs];
  };

  const majorAlphaRefCache = new Map();
  const listMajorAlphaRefs = async (major = rule.major) => {
    if (!majorAlphaRefCache.has(major)) {
      majorAlphaRefCache.set(
        major,
        octokit.rest.git.listMatchingRefs({
          owner,
          repo,
          ref: `tags/v${major}.`,
        }).then(({ data }) => data),
      );
    }
    return majorAlphaRefCache.get(major);
  };

  const ownsMajorAlphaFloatingTag = async ({
    major = rule.major,
    minor = rule.minor } = {}) => ownsMajorAlphaChannel({
    refs: await listMajorAlphaRefs(major),
    major,
    minor,
  });

  const ensureTag = async (tag, tagSha = sha, options = {}) => {
    const acceptedExistingShas = uniqueShas([
      tagSha,
      ...(options.acceptedExistingShas || [])]);
    const acceptedExistingMaterialShas = uniqueShas(
      options.acceptedExistingMaterialShas || []);
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha: tagSha });
      return;
    }
    try {
      const { data: tagRef } = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `tags/${tag}`,
      });
      let acceptedExistingMaterial = false;
      for (const materialSha of acceptedExistingMaterialShas) {
        if (await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: tagRef.object.sha,
          transactionReleaseSha: materialSha,
        })) {
          acceptedExistingMaterial = true;
          break;
        }
      }
      if (!acceptedExistingShas.includes(tagRef.object.sha) && !acceptedExistingMaterial) {
        throw new Error(
          `Tag ${tag} points at ${tagRef.object.sha}, not one of requested SHAs ${acceptedExistingShas.join(", ")}`);
      }
      updates.push({ tag, action: "existing", sha: tagRef.object.sha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await context.tagUpdateOctokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: tagSha,
      });
      updates.push({ tag, action: "created", sha: tagSha });
    }
  };

  const updateTag = async (tag, tagSha = sha) => {
    if (dryRun) {
      updates.push({ tag, action: "dry-run", sha: tagSha });
      return;
    }
    const tagRef = await getGitRefOrUndefined({ octokit, owner, repo, ref: `tags/${tag}` }); if (tagRef?.object?.sha === tagSha) return void updates.push({ tag, action: "existing", sha: tagSha });
    try {
      await context.tagUpdateOctokit.rest.git.updateRef({
        owner,
        repo,
        ref: `tags/${tag}`,
        sha: tagSha,
        force: true,
      });
      updates.push({ tag, action: "updated", sha: tagSha });
    } catch (error) {
      if (!notFound(error)) {
        throw error;
      }
      await context.tagUpdateOctokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: tagSha,
      });
      updates.push({ tag, action: "created", sha: tagSha });
    }
  };

  const updateMajorAlphaFloatingTag = async ({
    major = rule.major,
    minor = rule.minor,
    sha: tagSha = sha } = {}) => {
    const tag = `v${major}-alpha`;
    if (await ownsMajorAlphaFloatingTag({ major, minor })) {
      await updateTag(tag, tagSha);
      return true;
    }
    updates.push({
      tag,
      action: "skipped-newer-minor-alpha-exists",
      sha: tagSha,
    });
    return false;
  };

  const readRefSha = async (ref) => {
    const refData = await getGitRefOrUndefined({
      octokit,
      owner,
      repo,
      ref,
    });
    return refData?.object?.sha;
  };

  const updateBranch = async (branch, branchSha, action = "updated", protectedUpdate) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run", sha: branchSha });
      return { updated: true };
    }
    const ensureChannelProtection = async () => {
      const policyEvidence = await ensureManagedChannelBranchProtection({ octokit, owner, repo, branch, requiredStatusCheck, branchProtectionBypassApps, branchProtectionBypassUsers, branchProtectionBypassTeams,
      });
      if (policyEvidence) updates.push(policyEvidence);
      return policyEvidence;
    };
    const currentSha = await readRefSha(`heads/${branch}`);
    const protectionPolicy = currentSha
      ? await ensureChannelProtection()
      : undefined;
    const generatedStatusChecks = protectionPolicy?.after?.requiredStatusChecks || [requiredStatusCheck];
    if (currentSha === branchSha) {
      updates.push({ ref: branch, action: "existing", sha: branchSha });
      return { updated: true, existing: true };
    }
    const generatedVersionStateBranch = protectedUpdate
      ? versionStateBranchName(branch, branchSha)
      : "";
    const generatedVersionStateSha = generatedVersionStateBranch
      ? await readRefSha(`heads/${generatedVersionStateBranch}`)
      : undefined;
    if (
      currentSha &&
      generatedVersionStateSha === branchSha &&
      typeof octokit.rest.repos?.compareCommitsWithBasehead === "function"
    ) {
      const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${branchSha}...${currentSha}`,
      });
      if (comparison.status === "ahead") {
        updates.push({
          ref: branch,
          action: "existing-contained-version-state",
          sha: currentSha,
          sourceSha: branchSha,
        });
        return {
          updated: true,
          existing: true,
          contained: true,
          currentSha,
        };
      }
    }
    const branchWriteOctokit = protectedUpdate ? refUpdateOctokit || octokit : octokit;
    const openVersionStatePullRequest = async ({ error, pendingSha = branchSha }) => {
      const message = error?.response?.data?.message || error?.message || String(error || "");
      if (
        !protectedUpdate?.allowPendingPullRequest ||
        !protectedUpdate?.title ||
        typeof pullRequestOctokit.rest.pulls?.create !== "function"
      ) {
        throw protectedBranchDirectUpdateError({ branch, branchSha, error });
      }
      const versionStateBranch = versionStateBranchName(branch, pendingSha);
      const versionStateRef = `heads/${versionStateBranch}`;
      const existingVersionStateSha = await readRefSha(versionStateRef);
      if (existingVersionStateSha && existingVersionStateSha !== pendingSha) {
        throw new Error(
          `Buildchain generated version-state branch ${versionStateBranch} points at ${existingVersionStateSha}, not ${pendingSha}`);
      }
      if (!existingVersionStateSha) {
        await branchWriteOctokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/${versionStateRef}`,
          sha: pendingSha,
        });
        updates.push({
          ref: versionStateBranch,
          action: "created-version-state-pr-head",
          sha: pendingSha,
        });
      }
      if (typeof pullRequestOctokit.rest.pulls?.list === "function") {
        const { data: existingPullRequests } = await pullRequestOctokit.rest.pulls.list({
          owner,
          repo,
          state: "open",
          base: branch,
          head: `${owner}:${versionStateBranch}`,
        });
        const existingPullRequest = (existingPullRequests || [])[0];
        if (existingPullRequest) {
          updates.push({
            ref: branch,
            action: "pending-version-state-pr",
            sha: pendingSha,
            pullRequest: existingPullRequest.html_url || existingPullRequest.url,
          });
          return {
            updated: false,
            pending: true,
            currentSha,
            pullRequest: existingPullRequest,
          };
        }
      }
      const { data: pullRequest } = await pullRequestOctokit.rest.pulls.create({
        owner,
        repo,
        title: protectedUpdate.title,
        body:
          `${protectedUpdate.body || protectedUpdate.title}\n\n` +
          `Buildchain generated this PR because protected branch ${branch} rejected direct generated bookkeeping.\n\n` +
          `Rejected update: ${currentSha || "new branch"} -> ${branchSha}\n\n` +
          `GitHub response: ${message}`,
        head: versionStateBranch,
        base: branch,
      });
      updates.push({
        ref: branch,
        action: "pending-version-state-pr",
        sha: pendingSha,
        pullRequest: pullRequest.html_url || pullRequest.url,
      });
      return { updated: false, pending: true, currentSha, pullRequest };
    };
    const createVersionStateMergeCommit = async () => {
      const allowedPaths = protectedUpdate?.allowMergeCommitOnNonFastForwardPaths || [];
      if (!allowedPaths.length) {
        return undefined;
      }
      if (protectedUpdate?.reconciliationVersion && !reconciliationWorkspace) {
        throw new Error(
          `Version-state reconciliation for current ${branch} requires an exact checkout workspace`,
        );
      }
      const { data: generatedCommit } = await getGitCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha: branchSha,
      });
      const generatedParentSha = generatedCommit.parents?.[0]?.sha;
      if (!generatedParentSha) {
        throw new Error(
          `Generated version-state commit ${branchSha} must have a parent before merging into ${branch}`);
      }
      await getReconciliationOperations().assertOnlyAllowedChangesBetween({
        baseSha: generatedParentSha,
        headSha: branchSha,
        allowedPaths,
      });
      if (protectedUpdate?.reconciliationVersion) {
        const workspaceCwd = path.resolve(cwd, reconciliationWorkspace);
        if (!fs.existsSync(workspaceCwd)) {
          throw new Error(`Version-state reconciliation workspace does not exist: ${workspaceCwd}`);
        }
        const workspaceSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: workspaceCwd,
          encoding: "utf8",
        }).trim();
        if (workspaceSha !== currentSha) {
          throw new Error(
            `Version-state reconciliation workspace ${workspaceSha} does not match current ${branch} ${currentSha}`);
        }
        const reconciled = await getVersionStateOperations().createVersionStateCommit({
          baseSha: currentSha,
          version: protectedUpdate.reconciliationVersion,
          message:
            protectedUpdate?.mergeMessage ||
            `${protectedUpdate?.title || "Apply generated version-state"}\n\n` +
              `Buildchain regenerated version state from current ${branch} before reconciling ` +
              `${currentSha} with ${branchSha}.`,
          workspaceCwd,
          parents: [currentSha, branchSha],
        });
        updates.push({
          ref: branch,
          action: "created-version-state-merge",
          sha: reconciled.sha,
          sourceSha: branchSha,
          currentSha,
          files: reconciled.files,
          regenerated: true,
        });
        return reconciled.sha;
      }
      const { data: currentCommit } = await getGitCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha: currentSha,
      });
      const { data: generatedTree } = await retryGitHubOperation(
        `git.getTree ${branchSha} recursive`,
        () => octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: generatedCommit.tree.sha,
          recursive: "1",
        }),
      );
      const generatedEntries = new Map(
        (generatedTree.tree || []).map((entry) => [entry.path, entry]));
      const overlayEntries = allowedPaths.map((allowedPath) => {
        const entry = generatedEntries.get(allowedPath);
        return entry
          ? {
              path: entry.path,
              mode: entry.mode,
              type: entry.type,
              sha: entry.sha,
            }
          : {
              path: allowedPath,
              mode: "100644",
              type: "blob",
              sha: null,
            };
      });
      const { data: mergedTree } = await retryGitHubOperation(
        `git.createTree ${branch} generated version-state overlay`,
        () => octokit.rest.git.createTree({
          owner,
          repo,
          base_tree: currentCommit.tree.sha,
          tree: overlayEntries,
        }),
      );
      const { data: mergeCommit } = await retryGitHubOperation(
        `git.createCommit ${branch} generated version-state merge`,
        () => octokit.rest.git.createCommit({
          owner,
          repo,
          message: signedGeneratedCommitMessage(
            protectedUpdate?.mergeMessage ||
              `${protectedUpdate?.title || "Apply generated version-state"}\n\n` +
                `Buildchain generated this merge commit to fast-forward ${branch} after ` +
                "the channel had diverged only by generated version-state files.",
          ),
          tree: mergedTree.sha,
          parents: [currentSha, branchSha],
          author: COMMIT_IDENTITY,
          committer: COMMIT_IDENTITY,
        }),
      );
      updates.push({
        ref: branch,
        action: "created-version-state-merge",
        sha: mergeCommit.sha,
        sourceSha: branchSha,
        currentSha,
        files: allowedPaths,
      });
      return mergeCommit.sha;
    };
    if (protectedUpdate && currentSha) {
      const createdChecks = await createGeneratedVersionStateChecks({
        octokit: statusCheckOctokit,
        owner,
        repo,
        branch,
        branchSha,
        currentSha,
        requiredStatusCheck,
        requiredStatusChecks: generatedStatusChecks,
      });
      for (const check of createdChecks) {
        updates.push({
          ref: branch,
          action: "generated-status-check",
          check,
          sha: branchSha,
        });
      }
    }
    try {
      if (currentSha) {
        await branchWriteOctokit.rest.git.updateRef({
          owner,
          repo,
          ref: `heads/${branch}`,
          sha: branchSha,
          force: false,
        });
        updates.push({ ref: branch, action, sha: branchSha });
      } else {
        await branchWriteOctokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: branchSha,
        });
        updates.push({ ref: branch, action: "created", sha: branchSha });
      }
      if (!currentSha) {
        await ensureChannelProtection();
      }
      return { updated: true };
    } catch (error) {
      if (
        protectedUpdate?.allowMergeCommitOnNonFastForward &&
        currentSha &&
        nonFastForwardUpdateRejected(error)
      ) {
        const mergeSha = await createVersionStateMergeCommit();
        if (mergeSha) {
          const createdMergeChecks = await createGeneratedVersionStateChecks({
            octokit: statusCheckOctokit,
            owner,
            repo,
            branch,
            branchSha: mergeSha,
            currentSha,
            requiredStatusCheck,
            requiredStatusChecks: generatedStatusChecks,
          });
          for (const check of createdMergeChecks) {
            updates.push({
              ref: branch,
              action: "generated-status-check",
              check,
              sha: mergeSha,
            });
          }
          try {
            await branchWriteOctokit.rest.git.updateRef({
              owner,
              repo,
              ref: `heads/${branch}`,
              sha: mergeSha,
              force: false,
            });
          } catch (mergeUpdateError) {
            if (
              protectedUpdate?.allowPendingPullRequest &&
              (protectedBranchUpdateRejected(mergeUpdateError) ||
                nonFastForwardUpdateRejected(mergeUpdateError))
            ) {
              return openVersionStatePullRequest({
                error: mergeUpdateError,
                pendingSha: mergeSha,
              });
            }
            throw mergeUpdateError;
          }
          updates.push({ ref: branch, action, sha: mergeSha });
          return { updated: true, mergeSha };
        }
      }
      if (protectedUpdate?.allowNonFastForwardSkip && nonFastForwardUpdateRejected(error)) {
        updates.push({
          ref: branch,
          action: "skipped-non-fast-forward",
          sha: branchSha,
          currentSha,
        });
        return { updated: false, skipped: true, currentSha };
      }
      if (
        protectedUpdate &&
        (protectedBranchUpdateRejected(error) || nonFastForwardUpdateRejected(error))
      ) {
        return openVersionStatePullRequest({ error });
      }
      if (!notFound(error)) {
        throw error;
      }
      await branchWriteOctokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: branchSha,
      });
      updates.push({ ref: branch, action: "created", sha: branchSha });
      await ensureChannelProtection();
      return { updated: true };
    }
  };

  const updateDefaultBranch = async (branch) => {
    if (dryRun) {
      updates.push({ ref: branch, action: "dry-run-default-branch" });
      return;
    }
    if (typeof octokit.rest.repos?.get === "function") {
      const { data: repository } = await octokit.rest.repos.get({
        owner,
        repo,
      });
      if (repository.default_branch === branch) {
        updates.push({ ref: branch, action: "existing-default-branch" });
        return;
      }
    }
    if (typeof octokit.rest.repos?.update !== "function") {
      updates.push({ ref: branch, action: "skipped-default-branch-update-unavailable",
      });
      return;
    }
    await octokit.rest.repos.update({
      owner,
      repo,
      default_branch: branch,
    });
    updates.push({ ref: branch, action: "updated-default-branch" });
  };
  return {
    listLineRefs,
    listMajorAlphaRefs,
    ownsMajorAlphaFloatingTag,
    ensureTag,
    updateTag,
    updateMajorAlphaFloatingTag,
    readRefSha,
    updateBranch,
    updateDefaultBranch,
  };
}
export function createReconciliationOperations(context, runtime) { const { RELEASE_LINE_RECOVERY_PATHS, alphaTagsForPatch, assertChannelPromotionPr, getCommitInfo, getGitCommitWithRetry, isAllowedReleaseLineRecoveryPath, listPullRequestsAssociatedWithCommitWithRetry, parseReleaseLineRecoveryRef, parseVersionStateBranchName, releaseCommitIncludesTransactionHead, retryGitHubOperation } = runtime;
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
  } = context;
  const assertOnlyAllowedChangesBetween = async ({ baseSha, headSha, allowedPaths }) => {
    const changedPaths = await listChangedPathsBetweenTrees({
      baseSha,
      headSha,
    });
    const unexpected = changedPaths.filter((file) => !allowedPaths.includes(file));
    if (unexpected.length > 0) {
      throw new Error(
        `Version-state PR changed files outside declared version state: ${unexpected.join(", ")}`);
    }
  };
  const listChangedPathsBetweenTrees = async ({ baseSha, headSha }) => {
    const [baseCommitResult, headCommitResult] = await Promise.all([
      getGitCommitWithRetry({ octokit, owner, repo, commitSha: baseSha }),
      getGitCommitWithRetry({ octokit, owner, repo, commitSha: headSha }),
    ]);
    const [baseTreeResult, headTreeResult] = await Promise.all([
      retryGitHubOperation(
        `git.getTree ${baseSha} recursive`,
        () => octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: baseCommitResult.data.tree.sha,
          recursive: "1",
        }),
      ),
      retryGitHubOperation(
        `git.getTree ${headSha} recursive`,
        () => octokit.rest.git.getTree({
          owner,
          repo,
          tree_sha: headCommitResult.data.tree.sha,
          recursive: "1",
        }),
      ),
    ]);
    const toTreeMap = (tree) => {
      const entries = new Map();
      for (const entry of tree || []) {
        if (!entry?.path || entry.type === "tree") {
          continue;
        }
        entries.set(
          entry.path,
          `${entry.type || ""}:${entry.mode || ""}:${entry.sha || ""}`);
      }
      return entries;
    };
    const baseEntries = toTreeMap(baseTreeResult.data.tree);
    const headEntries = toTreeMap(headTreeResult.data.tree);
    const paths = new Set([...baseEntries.keys(), ...headEntries.keys()]);
    return [...paths]
      .filter((file) => baseEntries.get(file) !== headEntries.get(file))
      .sort();
  };

  const assertOnlyAllowedReleaseRecoveryChangesBetween = async ({
    baseSha,
    headSha,
    allowedPaths = [] }) => {
    const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const changedPaths = (comparison.files || []).map((file) => file.filename);
    const unexpected = changedPaths.filter(
      (file) => !isAllowedReleaseLineRecoveryPath(file, allowedPaths));
    if (unexpected.length > 0) {
      const recoveryScope = [
        ...RELEASE_LINE_RECOVERY_PATHS,
        ...allowedPaths].join(", ");
      throw new Error(
        `Release-line recovery PR changed files outside buildchain recovery scope: ${unexpected.join(", ")}. ` +
          `Open a follow-up exact line-scoped recovery PR that contains this candidate and changes only: ${recoveryScope}`,
      );
    }
  };

  const findMatchingReleaseRecoveryPullRequest = async ({ commitSha, targetRef }) => {
    const { data: pullRequests } =
      await listPullRequestsAssociatedWithCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha,
      });
    return pullRequests.find((pullRequest) => {
      const baseRef = pullRequest.base?.ref;
      const headRef = pullRequest.head?.ref;
      const headRepo = pullRequest.head?.repo?.full_name;
      const recovery = parseReleaseLineRecoveryRef(headRef);
      return pullRequest.merged_at &&
        baseRef === targetRef &&
        recovery?.targetRef === targetRef &&
        headRepo === `${owner}/${repo}`;
    });
  };

  const findMatchingTargetPullRequest = async ({ commitSha, targetRef }) => {
    const { data: pullRequests } =
      await listPullRequestsAssociatedWithCommitWithRetry({
        octokit,
        owner,
        repo,
        commitSha,
      });
    return pullRequests.find((pullRequest) => {
      const baseRef = pullRequest.base?.ref;
      const headRepo = pullRequest.head?.repo?.full_name;
      return pullRequest.merged_at &&
        baseRef === targetRef &&
        headRepo === `${owner}/${repo}`;
    });
  };

  const findAlphaMaterialFromPromotionPullRequest = async ({ commitSha, targetRef, releasePrefix, patch, refs }) => {
    if (typeof octokit.rest.repos?.listPullRequestsAssociatedWithCommit !== "function") {
      return undefined;
    }
    const pullRequest = await findMatchingTargetPullRequest({
      commitSha,
      targetRef,
    });
    const pullRequestHeadSha = pullRequest?.head?.sha;
    if (!pullRequestHeadSha) {
      return undefined;
    }
    for (const candidate of alphaTagsForPatch(refs, releasePrefix, patch)) {
      if (!candidate.sha) {
        continue;
      }
      if (
        await releaseCommitIncludesTransactionHead({
          octokit,
          owner,
          repo,
          releaseSha: pullRequestHeadSha,
          transactionReleaseSha: candidate.sha,
        })
      ) {
        return {
          ...candidate,
          source: "promotion-pr-head",
          promotionPullRequestHeadSha: pullRequestHeadSha,
        };
      }
    }
    return undefined;
  };

  const assertPromotionPrOrVersionStateParent = async ({ commitSha, targetRef, allowedPaths }) => {
    try {
      await assertChannelPromotionPr({
        octokit,
        owner,
        repo,
        sha: commitSha,
        targetRef,
      });
      return;
    } catch (directError) {
      if (!allowedPaths?.length) {
        throw directError;
      }
      const { data: pullRequests } =
        await listPullRequestsAssociatedWithCommitWithRetry({
          octokit,
          owner,
          repo,
          commitSha,
        });
      const matchingVersionStatePullRequest = pullRequests.find((pullRequest) => {
        const baseRef = pullRequest.base?.ref;
        const headRef = pullRequest.head?.ref;
        const headRepo = pullRequest.head?.repo?.full_name;
        return pullRequest.merged_at &&
          baseRef === targetRef &&
          parseVersionStateBranchName(headRef) === targetRef &&
          headRepo === `${owner}/${repo}`;
      });
      const commit = await getCommitInfo(octokit, owner, repo, commitSha);
      if (matchingVersionStatePullRequest) {
        for (const parentSha of commit.parents) {
          try {
            await assertOnlyAllowedChangesBetween({
              baseSha: parentSha,
              headSha: commitSha,
              allowedPaths,
            });
            return;
          } catch {
            // Try the next parent before surfacing the original lineage failure.
          }
        }
        throw directError;
      }
      for (const parentSha of commit.parents) {
        try {
          await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
          await assertOnlyAllowedChangesBetween({
            baseSha: parentSha,
            headSha: commitSha,
            allowedPaths,
          });
          return;
        } catch {
          // Try the next parent before surfacing the original lineage failure.
        }
      }
      throw directError;
    }
  };

  const assertReleasePrOrVersionStateParent = async ({
    commitSha,
    targetRef,
    alphaSha,
    alphaTag,
    alphaTreeSha,
    allowedPaths,
    allowDirectAllowedChanges = false,
    exactReleaseCandidateSource }) => {
    const commit = await getCommitInfo(octokit, owner, repo, commitSha);
    if (
      exactReleaseCandidateSource?.treeEquivalent === true &&
      exactReleaseCandidateSource.promotionChannelSha === commitSha &&
      exactReleaseCandidateSource.promotionChannelTreeSha === commit.treeSha
    ) {
      let promotionPullRequest;
      try {
        promotionPullRequest = await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
      } catch (error) {
        promotionPullRequest = await findMatchingTargetPullRequest({
          commitSha,
          targetRef,
        });
        if (!promotionPullRequest) {
          throw error;
        }
      }
      updates.push({
        action: "accepted-exact-release-candidate-source",
        sha: commitSha,
        treeSha: commit.treeSha,
        builtSourceSha: exactReleaseCandidateSource.builtSourceSha,
        builtSourceTreeSha: exactReleaseCandidateSource.builtSourceTreeSha,
        alphaTag,
        alphaSha,
        targetRef,
        pullRequest: promotionPullRequest?.html_url || promotionPullRequest?.url,
      });
      return;
    }
    if (commit.treeSha === alphaTreeSha) {
      try {
        const promotionPullRequest = await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
        if (
          parseReleaseLineRecoveryRef(promotionPullRequest.head?.ref)?.targetRef ===
          targetRef
        ) {
          updates.push({
            action: "accepted-release-recovery-tree-equivalent-source",
            sha: commitSha,
            alphaTag,
            alphaSha,
            targetRef,
          });
        }
      } catch (error) {
        const matchingReleaseRecoveryPullRequest =
          await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef,
        });
        if (!matchingReleaseRecoveryPullRequest) {
          throw error;
        }
        updates.push({
          action: "accepted-release-recovery-tree-equivalent-source",
          sha: commitSha,
          alphaTag,
          alphaSha,
          targetRef,
        });
      }
      return;
    }
    if (allowDirectAllowedChanges && allowedPaths?.length) {
      let validPromotionPr = false;
      try {
        await assertChannelPromotionPr({
          octokit,
          owner,
          repo,
          sha: commitSha,
          targetRef,
        });
        validPromotionPr = true;
        await assertOnlyAllowedChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      } catch (error) {
        if (validPromotionPr) {
          throw error;
        }
      }
      const matchingTargetPullRequest = await findMatchingTargetPullRequest({
        commitSha,
        targetRef,
      });
      if (matchingTargetPullRequest) {
        await assertOnlyAllowedChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
    }
    const matchingCurrentReleaseRecoveryPullRequest =
      await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
    if (matchingCurrentReleaseRecoveryPullRequest) {
      const recoveryBaseSha =
        matchingCurrentReleaseRecoveryPullRequest.base?.sha;
      const recoveryHeadSha =
        matchingCurrentReleaseRecoveryPullRequest.head?.sha;
      if (recoveryBaseSha && recoveryHeadSha) {
        const exactCandidateSha =
          exactReleaseCandidateSource?.promotionChannelSha;
        if (
          recoveryBaseSha !== alphaSha &&
          recoveryBaseSha !== exactCandidateSha
        ) {
          throw new Error(
            `Release-line recovery PR base ${recoveryBaseSha} must equal ${alphaTag} ${alphaSha} or the exact release candidate ${exactCandidateSha || "(missing)"}`);
        }
        const recoveryHead = await getCommitInfo(
          octokit,
          owner,
          repo,
          recoveryHeadSha);
        if (recoveryHead.treeSha !== commit.treeSha) {
          throw new Error(
            `Release-line recovery PR head tree ${recoveryHead.treeSha} must equal promotion tree ${commit.treeSha}`);
        }
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: recoveryBaseSha,
          headSha: recoveryHeadSha,
          allowedPaths,
        });
      } else {
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: commitSha,
          allowedPaths,
        });
      }
      updates.push({
        action: "accepted-exact-release-recovery-source",
        sha: commitSha,
        recoveryBaseSha,
        recoveryHeadSha,
        alphaTag,
        alphaSha,
        targetRef,
      });
      return;
    }
    for (const parentSha of commit.parents) {
      const parent = await getCommitInfo(octokit, owner, repo, parentSha);
      if (parent.treeSha === alphaTreeSha) {
        try {
          const promotionPullRequest = await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
          if (
            parseReleaseLineRecoveryRef(promotionPullRequest.head?.ref)?.targetRef ===
            targetRef
          ) {
            updates.push({
              action: "accepted-release-recovery-tree-equivalent-source",
              sha: parentSha,
              alphaTag,
              alphaSha,
              targetRef,
            });
          }
        } catch (error) {
          const matchingReleaseRecoveryPullRequest =
            await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef,
          });
          if (!matchingReleaseRecoveryPullRequest) {
            throw error;
          }
          updates.push({
            action: "accepted-release-recovery-tree-equivalent-source",
            sha: parentSha,
            alphaTag,
            alphaSha,
            targetRef,
          });
        }
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
      const matchingReleaseRecoveryPullRequest =
        await findMatchingReleaseRecoveryPullRequest({ commitSha: parentSha, targetRef,
      });
      if (matchingReleaseRecoveryPullRequest) {
        const recoveryBaseSha = matchingReleaseRecoveryPullRequest.base?.sha;
        const recoveryHeadSha = matchingReleaseRecoveryPullRequest.head?.sha;
        const exactCandidateSha =
          exactReleaseCandidateSource?.promotionChannelSha;
        const exactCandidateTreeSha =
          exactReleaseCandidateSource?.promotionChannelTreeSha;
        if (
          recoveryBaseSha &&
          recoveryHeadSha &&
          exactReleaseCandidateSource?.treeEquivalent === true &&
          parentSha === exactCandidateSha &&
          parent.treeSha === exactCandidateTreeSha
        ) {
          const recoveryHead = await getCommitInfo(
            octokit,
            owner,
            repo,
            recoveryHeadSha);
          if (recoveryHead.treeSha !== parent.treeSha) {
            throw new Error(
              `Release-line recovery PR head tree ${recoveryHead.treeSha} must equal exact release candidate tree ${parent.treeSha}`);
          }
          await assertOnlyAllowedReleaseRecoveryChangesBetween({
            baseSha: recoveryBaseSha,
            headSha: recoveryHeadSha,
            allowedPaths,
          });
          await assertOnlyAllowedChangesBetween({
            baseSha: parentSha,
            headSha: commitSha,
            allowedPaths,
          });
          updates.push({
            action: "accepted-exact-release-recovery-parent",
            sha: parentSha,
            treeSha: parent.treeSha,
            recoveryBaseSha,
            recoveryHeadSha,
            builtSourceSha: exactReleaseCandidateSource.builtSourceSha,
            builtSourceTreeSha: exactReleaseCandidateSource.builtSourceTreeSha,
            alphaTag,
            alphaSha,
            targetRef,
          });
          return;
        }
        await assertOnlyAllowedReleaseRecoveryChangesBetween({
          baseSha: alphaSha,
          headSha: parentSha,
          allowedPaths,
        });
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        return;
      }
      const exactCandidateSha =
        exactReleaseCandidateSource?.promotionChannelSha;
      const exactCandidateTreeSha =
        exactReleaseCandidateSource?.promotionChannelTreeSha;
      if (
        exactReleaseCandidateSource?.treeEquivalent === true &&
        parentSha === exactCandidateSha &&
        parent.treeSha === exactCandidateTreeSha
      ) {
        let promotionPullRequest;
        try {
          promotionPullRequest = await assertChannelPromotionPr({
            octokit,
            owner,
            repo,
            sha: parentSha,
            targetRef,
          });
        } catch (error) {
          promotionPullRequest = await findMatchingTargetPullRequest({
            commitSha: parentSha,
            targetRef,
          });
          if (!promotionPullRequest) {
            throw error;
          }
        }
        await assertOnlyAllowedChangesBetween({
          baseSha: parentSha,
          headSha: commitSha,
          allowedPaths,
        });
        updates.push({
          action: "accepted-exact-release-candidate-parent",
          sha: parentSha,
          treeSha: parent.treeSha,
          builtSourceSha: exactReleaseCandidateSource.builtSourceSha,
          builtSourceTreeSha: exactReleaseCandidateSource.builtSourceTreeSha,
          alphaTag,
          alphaSha,
          targetRef,
          pullRequest:
            promotionPullRequest?.html_url || promotionPullRequest?.url,
        });
        return;
      }
    }
    const matchingReleaseRecoveryPullRequest =
      await findMatchingReleaseRecoveryPullRequest({ commitSha, targetRef });
    if (matchingReleaseRecoveryPullRequest) {
      await assertOnlyAllowedReleaseRecoveryChangesBetween({
        baseSha: alphaSha,
        headSha: commitSha,
        allowedPaths,
      });
      return;
    }
    throw new Error(
      `Release source ${commitSha} must have the same tree as ${alphaTag}, except declared version-state files`);
  };

  const isSettledAlphaVersionState = async (selectedAlpha) => {
    if (!selectedAlpha?.exists || selectedAlpha.sha !== sha) {
      return false;
    }
    const devRef = `heads/dev/v${rule.major}/v${rule.major}.${rule.minor}`;
    const ownsMajorAlphaTag = await ownsMajorAlphaFloatingTag();
    const [devSha, exactAlphaTagSha, floatingAlphaTagSha, majorFloatingAlphaTagSha] = await Promise.all([
      readRefSha(devRef),
      readRefSha(`tags/${selectedAlpha.tag}`),
      readRefSha(`tags/${rule.alphaTag}`),
      ownsMajorAlphaTag ? readRefSha(`tags/${rule.majorAlphaTag}`) : undefined,
    ]);
    return devSha === sha &&
      exactAlphaTagSha === sha &&
      floatingAlphaTagSha === sha &&
      (!ownsMajorAlphaTag || majorFloatingAlphaTagSha === sha);
  };
  return {
    assertOnlyAllowedChangesBetween,
    listChangedPathsBetweenTrees,
    assertOnlyAllowedReleaseRecoveryChangesBetween,
    findMatchingReleaseRecoveryPullRequest,
    findMatchingTargetPullRequest,
    findAlphaMaterialFromPromotionPullRequest,
    assertPromotionPrOrVersionStateParent,
    assertReleasePrOrVersionStateParent,
    isSettledAlphaVersionState,
  };
}

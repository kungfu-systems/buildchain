import { evaluateBuildchainReleaseReconciliation } from "../../publication/publication-control-plane-audit.js";
export function observePublicationSourceAuthorization(
  {
    protection,
    branch,
    rulesets,
    rulesetBranchPolicy,
    sourceSha,
    repository,
    branchState,
    publicationVersion,
    allowReleaseReconciliation,
    requiredStatusCheck,
  },
  { githubPublicJson },
) {
  let branchPolicy;
  if (protection) {
    branchPolicy = {
      ref: branch,
      policyMode: "branch-protection",
      strict: protection.required_status_checks?.strict === true,
      requiredApprovals:
        protection.required_pull_request_reviews
          ?.required_approving_review_count || 0,
      requireConversationResolution:
        protection.required_conversation_resolution?.enabled === true,
      enforceAdmins: protection.enforce_admins?.enabled === true,
      observedRulesetCount: rulesets.length,
    };
  } else if (
    rulesetBranchPolicy.rulesetCount > 0 &&
    rulesetBranchPolicy.strict
  ) {
    branchPolicy = rulesetBranchPolicy;
  } else {
    const {
      authorizationSha,
      branchHeadSha,
      sourceContainedInBranch,
      releaseReconciliation,
      mergedPullRequest,
    } = observeSourceLineage(
      {
        sourceSha,
        repository,
        branchState,
        branch,
        publicationVersion,
        allowReleaseReconciliation,
      },
      githubPublicJson,
    );
    const { pullRequestHeadSha, independentApprovals } = observeSourceReviews(
      { repository, mergedPullRequest },
      githubPublicJson,
    );
    const {
      requiredStatusChecks,
      resolvedRequiredStatusCheck,
      requiredStatusCheckMatchCount,
      checkRuns,
      requiredCheckSource,
    } = observeRequiredSourceCheck(
      { repository, branchState, requiredStatusCheck, pullRequestHeadSha },
      githubPublicJson,
    );
    branchPolicy = {
      ref: branch,
      policyMode: "provider-enforced-transaction",
      protected: branchState.protected === true,
      enforcementLevel:
        branchState.protection?.required_status_checks?.enforcement_level || "",
      requiredStatusChecks,
      declaredRequiredStatusCheck: requiredStatusCheck,
      requiredStatusCheck: resolvedRequiredStatusCheck,
      requiredStatusCheckMatchCount,
      requiredCheckPassed: (checkRuns.check_runs || []).some(
        (entry) =>
          entry.name === resolvedRequiredStatusCheck &&
          entry.conclusion === "success" &&
          (!requiredCheckSource?.app_id ||
            entry.app?.id === requiredCheckSource.app_id),
      ),
      requiredCheckAppId: requiredCheckSource?.app_id || 0,
      requiredCheckSha: pullRequestHeadSha,
      sourceSha,
      authorizationSha,
      headSha: branchHeadSha,
      sourceContainedInBranch,
      releaseReconciliation,
      mergedPullRequest: Boolean(mergedPullRequest),
      pullRequestNumber: mergedPullRequest?.number || 0,
      pullRequestHeadSha,
      baseRef: mergedPullRequest?.base?.ref || "",
      headRepository: mergedPullRequest?.head?.repo?.full_name || "",
      approvalCount: independentApprovals.length,
      independentApproval: independentApprovals.length > 0,
      configurationRead: false,
      evidenceSource: "public-provider-transaction",
      observedRulesetCount: rulesetBranchPolicy.rulesetCount,
      configuredPolicyMode:
        rulesetBranchPolicy.rulesetCount > 0 ? "ruleset" : "unreadable",
    };
  }
  return branchPolicy;
}

function observeSourceLineage(
  {
    sourceSha,
    repository,
    branchState,
    branch,
    publicationVersion,
    allowReleaseReconciliation,
  },
  githubPublicJson,
) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      "--source-sha is required when detailed branch policy is not readable",
    );
  }
  const sourceCommit = githubPublicJson(
    `repos/${repository}/commits/${sourceSha}`,
    "source commit",
  );
  const sourceParents = Array.isArray(sourceCommit.parents)
    ? sourceCommit.parents.map((entry) =>
        String(entry?.sha || "").toLowerCase(),
      )
    : [];
  const sourceChangedPaths = Array.isArray(sourceCommit.files)
    ? sourceCommit.files.map((entry) => String(entry?.filename || ""))
    : [];
  const sourceMessage = String(sourceCommit.commit?.message || "").split(
    "\n",
    1,
  )[0];
  let authorizationSha = sourceSha;
  let releaseReconciliation = {
    qualifying: false,
    parentSha: "",
    version: publicationVersion,
    message: sourceMessage,
    changedPaths: sourceChangedPaths,
  };
  const branchHeadSha = String(branchState.commit?.sha || "").toLowerCase();
  const sourceComparison =
    sourceSha === branchHeadSha
      ? null
      : githubPublicJson(
          `repos/${repository}/compare/${sourceSha}...${branchHeadSha}`,
          "source protected-branch lineage",
        );
  const sourceContainedInBranch =
    sourceSha === branchHeadSha ||
    (sourceComparison?.status === "ahead" &&
      String(sourceComparison?.merge_base_commit?.sha || "").toLowerCase() ===
        sourceSha);
  let pullRequests = githubPublicJson(
    `repos/${repository}/commits/${authorizationSha}/pulls`,
    "source pull-request lineage",
  );
  let mergedPullRequest = (
    Array.isArray(pullRequests) ? pullRequests : []
  ).find(
    (entry) =>
      entry?.merged_at &&
      (String(entry.merge_commit_sha || "").toLowerCase() ===
        authorizationSha ||
        String(entry.head?.sha || "").toLowerCase() === authorizationSha) &&
      entry.base?.ref === branch &&
      entry.head?.repo?.full_name === repository,
  );
  if (!mergedPullRequest && allowReleaseReconciliation) {
    const packageFile = githubPublicJson(
      `repos/${repository}/contents/package.json?ref=${encodeURIComponent(sourceSha)}`,
      "release reconciliation package metadata",
    );
    const packageJson = JSON.parse(
      Buffer.from(String(packageFile.content || ""), "base64").toString("utf8"),
    );
    const parentSha = sourceParents.length === 1 ? sourceParents[0] : "";
    releaseReconciliation = evaluateBuildchainReleaseReconciliation({
      repository,
      publicationVersion,
      packageVersion: packageJson.version,
      message: sourceMessage,
      parentSha,
      changedPaths: sourceChangedPaths,
    });
    if (releaseReconciliation.qualifying) {
      authorizationSha = parentSha;
      pullRequests = githubPublicJson(
        `repos/${repository}/commits/${authorizationSha}/pulls`,
        "release parent pull-request lineage",
      );
      mergedPullRequest = (
        Array.isArray(pullRequests) ? pullRequests : []
      ).find(
        (entry) =>
          entry?.merged_at &&
          entry.merge_commit_sha === authorizationSha &&
          entry.base?.ref === branch &&
          entry.head?.repo?.full_name === repository,
      );
    }
  }
  return {
    authorizationSha,
    branchHeadSha,
    sourceContainedInBranch,
    releaseReconciliation,
    mergedPullRequest,
  };
}
function observeSourceReviews(
  { repository, mergedPullRequest },
  githubPublicJson,
) {
  const reviews = mergedPullRequest
    ? githubPublicJson(
        `repos/${repository}/pulls/${mergedPullRequest.number}/reviews?per_page=100`,
        "source pull-request reviews",
      )
    : [];
  const latestReviews = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = String(review?.user?.login || "");
    if (login) latestReviews.set(login, review);
  }
  const pullRequestHeadSha = String(
    mergedPullRequest?.head?.sha || "",
  ).toLowerCase();
  const independentApprovals = [...latestReviews.values()].filter(
    (review) =>
      review.state === "APPROVED" &&
      review.user?.login !== mergedPullRequest?.user?.login &&
      String(review.commit_id || "").toLowerCase() === pullRequestHeadSha,
  );
  return { pullRequestHeadSha, independentApprovals };
}
function observeRequiredSourceCheck(
  { repository, branchState, requiredStatusCheck, pullRequestHeadSha },
  githubPublicJson,
) {
  const requiredStatusCheckPolicy =
    branchState.protection?.required_status_checks || {};
  const requiredStatusChecks = [
    ...new Set(
      [
        ...(requiredStatusCheckPolicy.contexts || []),
        ...(requiredStatusCheckPolicy.checks || []).map(
          (entry) => entry.context,
        ),
      ].filter(Boolean),
    ),
  ];
  const exactRequiredStatusCheck = requiredStatusChecks.includes(
    requiredStatusCheck,
  )
    ? requiredStatusCheck
    : "";
  const prefixedRequiredStatusChecks = requiredStatusChecks.filter((context) =>
    context.startsWith(`${requiredStatusCheck} / `),
  );
  const resolvedRequiredStatusCheck =
    exactRequiredStatusCheck ||
    (prefixedRequiredStatusChecks.length === 1
      ? prefixedRequiredStatusChecks[0]
      : requiredStatusCheck);
  const requiredStatusCheckMatchCount = exactRequiredStatusCheck
    ? 1
    : prefixedRequiredStatusChecks.length;
  const checkRuns = /^[0-9a-f]{40}$/.test(pullRequestHeadSha)
    ? githubPublicJson(
        `repos/${repository}/commits/${pullRequestHeadSha}/check-runs?check_name=${encodeURIComponent(resolvedRequiredStatusCheck)}&filter=latest&per_page=100`,
        "merged pull-request required check runs",
      )
    : { check_runs: [] };
  const requiredCheckSource = (requiredStatusCheckPolicy.checks || []).find(
    (entry) => entry.context === resolvedRequiredStatusCheck,
  );
  return {
    requiredStatusChecks,
    resolvedRequiredStatusCheck,
    requiredStatusCheckMatchCount,
    checkRuns,
    requiredCheckSource,
  };
}

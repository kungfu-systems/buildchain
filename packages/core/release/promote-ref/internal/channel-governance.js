import {
  getGitCommitWithRetry,
  listPullRequestsAssociatedWithCommitWithRetry,
  notFound,
} from "./github-adapter.js";
import {
  expectedHeadRefForTarget,
  parsePublishGateChannelRef,
  parseReleaseLineRecoveryRef,
  getPromotionRule,
  parseReleaseLineRef,
  MAJOR_GATE_REF,
} from "./promotion-policy.js";
import { parseVersionStateBranchName } from "./generated-branch.js";
export async function getCommitInfo(octokit, owner, repo, sha) {
  const { data } = await getGitCommitWithRetry({
    octokit,
    owner,
    repo,
    commitSha: sha,
  });
  return {
    treeSha: data.tree?.sha,
    parents: (data.parents || []).map((parent) => parent.sha),
  };
}
export async function assertChannelPromotionPr({
  octokit,
  owner,
  repo,
  sha,
  targetRef,
}) {
  const expectedHeadRef = expectedHeadRefForTarget(targetRef);
  const { data: pullRequests } =
    await listPullRequestsAssociatedWithCommitWithRetry({
      octokit,
      owner,
      repo,
      commitSha: sha,
    });
  const matchingPullRequest = pullRequests.find((pullRequest) => {
    const baseRef = pullRequest.base?.ref;
    const headRef = pullRequest.head?.ref;
    const headRepo = pullRequest.head?.repo?.full_name;
    const matchingVersionStateTarget = parseVersionStateBranchName(headRef);
    const matchingPublishGateTarget =
      parsePublishGateChannelRef(headRef)?.targetRef;
    const matchingReleaseRecoveryTarget =
      parseReleaseLineRecoveryRef(headRef)?.targetRef;
    if (getPromotionRule(targetRef).channel === "major") {
      return (
        pullRequest.merged_at &&
        baseRef === targetRef &&
        (parseReleaseLineRef(headRef) ||
          matchingVersionStateTarget === targetRef) &&
        headRepo === `${owner}/${repo}`
      );
    }
    return (
      pullRequest.merged_at &&
      baseRef === targetRef &&
      (headRef === expectedHeadRef ||
        matchingVersionStateTarget === targetRef ||
        matchingPublishGateTarget === targetRef ||
        matchingReleaseRecoveryTarget === targetRef) &&
      headRepo === `${owner}/${repo}`
    );
  });
  if (!matchingPullRequest) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR ${expectedHeadRef} -> ${targetRef}, publish-gate/${getPromotionRule(targetRef).channel}/... -> ${targetRef}, buildchain/version-state/* -> ${targetRef}, or an exact line-scoped channel recovery PR`,
    );
  }
  return matchingPullRequest;
}
export async function getMajorGateSource({
  octokit,
  owner,
  repo,
  sha,
  targetRef = MAJOR_GATE_REF,
}) {
  const pullRequest = await assertChannelPromotionPr({
    octokit,
    owner,
    repo,
    sha,
    targetRef,
  });
  const source = parseReleaseLineRef(pullRequest.head?.ref);
  if (!source) {
    throw new Error(
      `Promotion source ${sha} must come from a merged same-repository PR release/vN/vN.M -> ${targetRef}`,
    );
  }
  return {
    source,
    pullRequest,
    major: source.major + 1,
    minor: 0,
    releasePrefix: `v${source.major + 1}.0`,
    majorTag: `v${source.major + 1}`,
    minorTag: `v${source.major + 1}.0`,
    alphaTag: `v${source.major + 1}.0-alpha`,
  };
}
export function protectedStatusCheckNames(protection = {}) {
  const checks = protection.required_status_checks;
  return [
    ...new Set(
      [
        ...(checks?.contexts || []),
        ...((checks?.checks || []).map(
          (check) => check.context || check.app_id,
        ) || []),
      ].map(String),
    ),
  ];
}
export function resolveProtectedStatusCheckContext({
  protection = {},
  requiredStatusCheck = "check",
} = {}) {
  const declared = String(requiredStatusCheck || "").trim();
  const checkNames = protectedStatusCheckNames(protection);
  if (checkNames.includes(declared)) return declared;
  const emittedCandidates = [
    ...new Set(
      checkNames.filter(
        (name) =>
          name === `${declared} / ${declared}` ||
          name.startsWith(`${declared} / `),
      ),
    ),
  ];
  return emittedCandidates.length === 1 ? emittedCandidates[0] : declared;
}
export async function assertProviderEnforcedChannelTransaction({
  octokit,
  owner,
  repo,
  targetRef,
  sourceSha,
  expectedChannelSha = sourceSha,
  requiredStatusCheck,
}) {
  const { data: branch } = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch: targetRef,
  });
  const protection = branch.protection || {};
  const resolvedStatusCheck = resolveProtectedStatusCheckContext({
    protection,
    requiredStatusCheck,
  });
  const requiredCheck = (protection.required_status_checks?.checks || []).find(
    (entry) => entry.context === resolvedStatusCheck,
  );
  const pullRequest = await assertChannelPromotionPr({
    octokit,
    owner,
    repo,
    sha: sourceSha,
    targetRef,
  });
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: pullRequest.number,
    per_page: 100,
  });
  const latestReviews = new Map();
  for (const review of reviews || []) {
    const login = String(review?.user?.login || "");
    if (login) latestReviews.set(login, review);
  }
  const independentApproval = [...latestReviews.values()].some(
    (review) =>
      review.state === "APPROVED" &&
      review.user?.login !== pullRequest.user?.login,
  );
  const pullRequestHeadSha = String(pullRequest.head?.sha || "").trim();
  const validPullRequestHeadSha = /^[0-9a-f]{40}$/i.test(pullRequestHeadSha);
  const { data: checkRuns } = validPullRequestHeadSha
    ? await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: pullRequestHeadSha,
        check_name: resolvedStatusCheck,
        filter: "latest",
        per_page: 100,
      })
    : { data: { check_runs: [] } };
  const requiredCheckPassed = (checkRuns.check_runs || []).some(
    (entry) =>
      entry.name === resolvedStatusCheck &&
      entry.conclusion === "success" &&
      (!requiredCheck?.app_id || entry.app?.id === requiredCheck.app_id),
  );
  const missing = [];
  if (branch.protected !== true) missing.push("must be provider-protected");
  if (branch.commit?.sha !== expectedChannelSha)
    missing.push("must still point at the exact admitted channel head");
  if (protection.required_status_checks?.enforcement_level !== "everyone") {
    missing.push("must enforce required status checks for everyone");
  }
  if (!protectedStatusCheckNames(protection).includes(resolvedStatusCheck)) {
    missing.push(
      `must require a ${requiredStatusCheck} status check using the exact context`,
    );
  }
  if (!validPullRequestHeadSha) {
    missing.push("merged source PR must expose an immutable head SHA");
  }
  if (!requiredCheckPassed)
    missing.push(
      `required status check ${resolvedStatusCheck} must pass from its configured app`,
    );
  if (!independentApproval)
    missing.push(
      "must have an independent approving review on the merged source PR",
    );
  if (missing.length > 0) {
    throw new Error(
      `Protected channel ${targetRef} provider transaction is not qualifying: ${missing.join("; ")}`,
    );
  }
  return resolvedStatusCheck;
}
export async function assertProtectedChannel({
  octokit,
  owner,
  repo,
  targetRef,
  sourceSha,
  expectedChannelSha = sourceSha,
  requiredStatusCheck = "check",
}) {
  let protection;
  try {
    ({ data: protection } = await octokit.rest.repos.getBranchProtection({
      owner,
      repo,
      branch: targetRef,
    }));
  } catch (error) {
    if (error.status === 403 || notFound(error)) {
      return assertProviderEnforcedChannelTransaction({
        octokit,
        owner,
        repo,
        targetRef,
        sourceSha,
        expectedChannelSha,
        requiredStatusCheck,
      });
    }
    throw error;
  }
  const missing = [];
  if (protection.enforce_admins?.enabled !== true) {
    missing.push("must enforce branch protection for administrators");
  }
  if (protection.allow_force_pushes?.enabled !== false) {
    missing.push("must disallow force pushes");
  }
  if (protection.allow_deletions?.enabled !== false) {
    missing.push("must disallow branch deletion");
  }
  if (protection.required_conversation_resolution?.enabled !== true) {
    missing.push("must require conversation resolution");
  }
  const reviews = protection.required_pull_request_reviews;
  if (!reviews || Number(reviews.required_approving_review_count || 0) < 1) {
    missing.push("must require at least one approving review");
  }
  const checks = protection.required_status_checks;
  if (!checks) missing.push("must require status checks");
  const checkNames = protectedStatusCheckNames(protection);
  const resolvedStatusCheck = resolveProtectedStatusCheckContext({
    protection,
    requiredStatusCheck,
  });
  if (!checkNames.includes(resolvedStatusCheck)) {
    missing.push(
      `must require a ${requiredStatusCheck} status check using the exact context`,
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `Protected channel ${targetRef} is missing required protection settings: ${missing.join("; ")}`,
    );
  }
  return resolvedStatusCheck;
}

import {
  normalizeBranch,
  assertSha,
  selectMergedChannelPullRequest,
} from "./selection.js";
import { githubJson } from "./transport.js";
export async function resolveChannelCandidate({
  repoInfo,
  sha,
  normalizedTarget,
  majorGateTarget,
  apiUrl,
  token,
  fetchImpl,
}) {
  const pulls = await githubJson({
    apiUrl,
    token,
    fetchImpl,
    path: `/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${sha}/pulls`,
  });
  const channelPullRequest = selectMergedChannelPullRequest({
    pullRequests: Array.isArray(pulls) ? pulls : [],
    targetRef: normalizedTarget,
    targetSha: sha,
    repository: repoInfo.fullName,
  });
  if (!channelPullRequest) {
    throw new Error(
      `no exact merged channel PR rooted in ${repoInfo.fullName} found for ${sha} into ${normalizedTarget}`,
    );
  }
  let pullRequest = channelPullRequest;
  if (majorGateTarget) {
    const releaseRef = normalizeBranch(channelPullRequest.head?.ref || "");
    if (!/^release\/v\d+\/v\d+\.\d+$/.test(releaseRef)) {
      throw new Error(
        `major gate ${normalizedTarget} must be merged from a release/vN/vN.M head, got ${releaseRef || "<empty>"}`,
      );
    }
    const releaseSha = assertSha(
      channelPullRequest.head?.sha,
      "major gate release head SHA",
    );
    const releasePulls = await githubJson({
      apiUrl,
      token,
      fetchImpl,
      path: `/repos/${repoInfo.owner}/${repoInfo.repo}/commits/${releaseSha}/pulls`,
    });
    pullRequest = selectMergedChannelPullRequest({
      pullRequests: Array.isArray(releasePulls) ? releasePulls : [],
      targetRef: releaseRef,
      repository: repoInfo.fullName,
    });
    if (!pullRequest) {
      throw new Error(
        `no same-repository merged release-candidate PR found for major gate release head ${releaseSha} into ${releaseRef}`,
      );
    }
    const releaseMergeSha = assertSha(
      pullRequest.merge_commit_sha || pullRequest.mergeCommit?.oid,
      "release-candidate PR merge SHA",
    );
    if (releaseMergeSha !== releaseSha) {
      throw new Error(
        `major gate release head ${releaseSha} does not equal release-candidate PR #${pullRequest.number} merge ${releaseMergeSha}`,
      );
    }
  }
  return { channelPullRequest, pullRequest };
}

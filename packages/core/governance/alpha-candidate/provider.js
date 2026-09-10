import { githubJsonClient } from "../../providers/github/json-client.js";
import {
  text,
  repository,
  autoMergeMethod,
  optionalExactSha,
  ABSENT_STATE_ROOT,
} from "./values.js";
import { resolveManagedPromotionBaseline } from "../../release/channel-promotion-baseline.js";
import { readGitHubNextDevelopmentVersionReservation } from "../../release/next-development-candidate-reservation.js";
import {
  managedCandidateFromPullRequest,
  persistedStateRoot,
  parseCandidateStateMarker,
} from "./state.js";
function encodeRef(value) {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubChannelCandidateClient({
  repository: repositoryInput,
  token,
  fetchImpl = globalThis.fetch,
  sleepImpl = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const [owner, repo] = repository(repositoryInput).split("/");
  const api = githubJsonClient({
    token,
    fetchImpl,
    userAgent: "buildchain-dev-alpha-candidate-patrol",
    attempts: 3,
    sleepImpl,
  });
  return {
    async resolveBranch(ref) {
      const payload = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
      );
      return text(payload.object?.sha);
    },
    async resolveCommitTreeSha(commitSha) {
      const payload = await api(
        `/repos/${owner}/${repo}/git/commits/${encodeURIComponent(commitSha)}`,
      );
      if (text(payload.sha) !== commitSha) {
        throw new Error(
          `candidate commit readback returned ${payload.sha || "<empty>"}, not ${commitSha}`,
        );
      }
      return optionalExactSha(payload.tree?.sha, "candidateTreeSha");
    },
    async compare(baseSha, headSha) {
      return api(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`);
    },
    resolveManagedPromotionBaseline: (targetSha, targetBranch) =>
      resolveManagedPromotionBaseline({
        api: (requestPath) => api(`/repos/${owner}/${repo}${requestPath}`),
        targetSha,
        targetBranch,
        parseCandidate: managedCandidateFromPullRequest,
      }),
    async readNextDevelopmentVersionReservation({
      reservationSha,
      candidateSha,
      targetVersion,
    }) {
      return readGitHubNextDevelopmentVersionReservation({
        api,
        owner,
        repo,
        reservationSha,
        candidateSha,
        targetVersion,
      });
    },
    async listCompletedWorkflowRuns(workflowPathValue, sourceBranch) {
      const runs = [];
      for (let page = 1; page <= 10; page += 1) {
        const payload = await api(
          `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowPathValue)}/runs?branch=${encodeURIComponent(sourceBranch)}&status=completed&per_page=100&page=${page}`,
        );
        const rows = payload.workflow_runs || [];
        runs.push(...rows);
        if (rows.length < 100) return runs;
      }
      throw new Error(
        `${workflowPathValue} completed workflow history exceeds 1000 runs`,
      );
    },
    async listBranchHistory(sourceBranch, targetSha) {
      const commits = [];
      for (let page = 1; page <= 10; page += 1) {
        const rows = await api(
          `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(sourceBranch)}&per_page=100&page=${page}`,
        );
        for (const commit of rows) {
          const commitSha = text(commit.sha);
          if (commitSha === targetSha) return commits;
          commits.push({
            sha: commitSha,
            message: text(commit.commit?.message),
            parents: (commit.parents || []).map((parent) => text(parent.sha)),
          });
        }
        if (rows.length < 100) return commits;
      }
      return commits;
    },
    async listOpenPullRequests(base) {
      const pullRequests = [];
      for (let page = 1; page <= 10; page += 1) {
        const rows = await api(
          `/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100&page=${page}`,
        );
        pullRequests.push(...rows);
        if (rows.length < 100) return pullRequests;
      }
      throw new Error(
        `open pull request history for ${base} exceeds 1000 rows`,
      );
    },
    async ensureImmutableBranch(ref, sourceSha) {
      const current = await api(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeRef(ref)}`,
        { allow404: true },
      );
      if (current && current.object?.sha !== sourceSha) {
        throw new Error(
          `source-lock branch ${ref} points to ${current.object?.sha}, not ${sourceSha}`,
        );
      }
      if (current) return current;
      return api(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${ref}`, sha: sourceSha },
      });
    },
    async ensurePullRequest({ head, base, title, body }) {
      const known = await api(
        `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=20`,
      );
      if (known.length > 1) {
        throw new Error(
          `multiple known candidate pull requests bind ${head}: ${known
            .map((row) => `#${row.number}`)
            .join(", ")}`,
        );
      }
      if (known[0]) return { ...known[0], reused: true };
      return api(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { head, base, title, body },
      });
    },
    async enableAutoMerge(pullRequest, mergeMethod) {
      if (!text(pullRequest.node_id)) {
        throw new Error("candidate pull request has no GraphQL node id");
      }
      const query = `mutation($id:ID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$mergeMethod}){pullRequest{url}}}`;
      return api("/graphql", {
        method: "POST",
        body: {
          query,
          variables: {
            id: pullRequest.node_id,
            mergeMethod: autoMergeMethod(mergeMethod).toUpperCase(),
          },
        },
      });
    },
    async updatePullRequestBody(
      number,
      body,
      expectedPriorStateRoot = ABSENT_STATE_ROOT,
    ) {
      const current = await api(`/repos/${owner}/${repo}/pulls/${number}`);
      const observedPriorStateRoot = persistedStateRoot({
        state: parseCandidateStateMarker(current.body),
      });
      if (observedPriorStateRoot !== expectedPriorStateRoot) {
        throw new Error(
          `candidate controller compare-and-swap failed: expected prior state root ${expectedPriorStateRoot}, observed ${observedPriorStateRoot}`,
        );
      }
      return api(`/repos/${owner}/${repo}/pulls/${number}`, {
        method: "PATCH",
        body: { body },
      });
    },
  };
}

import {
  normalized,
  assertRepository,
  assertManagedBranch,
  assertSha,
  planReleaseGovernanceReconciliation,
} from "./release-check-policy.js";
async function githubRequest({ apiUrl, token, method = "GET", route, body }) {
  const response = await fetch(
    `${apiUrl.replace(/\/$/, "")}/${route.replace(/^\//, "")}`,
    {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub API ${method} ${route} failed with ${response.status}: ${data?.message || text}`,
    );
  }
  return data;
}

function assertCandidatePullRequest({
  pullRequests = [],
  branch,
  candidateSha,
}) {
  const match = pullRequests.find(
    (pullRequest) =>
      pullRequest?.base?.ref === branch &&
      normalized(pullRequest?.head?.sha).toLowerCase() === candidateSha,
  );
  if (!match) {
    throw new Error(
      `candidate ${candidateSha} is not the head of a pull request targeting ${branch}`,
    );
  }
  return { number: match.number, url: match.html_url || "" };
}

export async function reconcileReleaseGovernance({
  repository,
  branch,
  candidateSha,
  apply = false,
  apiUrl = "https://api.github.com",
  token,
} = {}) {
  if (!token) throw new Error("GitHub governance token is required");
  if (typeof apply !== "boolean")
    throw new Error("Governance apply must be boolean");
  const normalizedRepository = assertRepository(repository);
  const normalizedBranch = assertManagedBranch(branch);
  const normalizedSha = assertSha(candidateSha);
  const encodedBranch = encodeURIComponent(normalizedBranch);
  const encodedSha = encodeURIComponent(normalizedSha);
  const [protection, checksResponse, pullRequests] = await Promise.all([
    githubRequest({
      apiUrl,
      token,
      route: `repos/${normalizedRepository}/branches/${encodedBranch}/protection`,
    }),
    githubRequest({
      apiUrl,
      token,
      route: `repos/${normalizedRepository}/commits/${encodedSha}/check-runs?filter=latest&per_page=100`,
    }),
    githubRequest({
      apiUrl,
      token,
      route: `repos/${normalizedRepository}/commits/${encodedSha}/pulls?per_page=100`,
    }),
  ]);
  const pullRequest = assertCandidatePullRequest({
    pullRequests,
    branch: normalizedBranch,
    candidateSha: normalizedSha,
  });
  const plan = planReleaseGovernanceReconciliation({
    repository: normalizedRepository,
    branch: normalizedBranch,
    candidateSha: normalizedSha,
    protection,
    checkRuns: checksResponse.check_runs || [],
  });

  if (apply && plan.changed) {
    await githubRequest({
      apiUrl,
      token,
      method: "PATCH",
      route: `repos/${normalizedRepository}/branches/${encodedBranch}/protection/required_status_checks`,
      body: {
        strict: plan.requiredStatusChecks.strict,
        contexts: plan.requiredStatusChecks.after
          .filter((entry) => entry.app_id === null)
          .map((entry) => entry.context),
        checks: plan.requiredStatusChecks.after
          .filter((entry) => entry.app_id !== null)
          .map((entry) => ({
            context: entry.context,
            app_id: entry.app_id,
          })),
      },
    });
  }
  return {
    ...plan,
    pullRequest,
    applied: apply && plan.changed,
    status: plan.changed ? (apply ? "reconciled" : "drift") : "aligned",
  };
}

import { createProductionReleasePrHandoff } from "./release-pr-handoff.js";
function requiredString(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value = "") {
  return String(value || "").trim();
}

async function githubJson({ apiUrl, token, method = "GET", path, body }) {
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    const detail = text ? `: ${text.slice(0, 500)}` : "";
    const error = new Error(
      `GitHub API ${method} ${path} failed: HTTP ${response.status}${detail}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? {} : response.json();
}

async function ensureLabel({ apiUrl, token, owner, repo, label }) {
  if (!label) return;
  try {
    await githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
    await githubJson({
      apiUrl,
      token,
      method: "POST",
      path: `/repos/${owner}/${repo}/labels`,
      body: {
        name: label,
        color: "0e8a16",
        description: "Buildchain production release approval PR",
      },
    });
  }
}

async function addLabel({ apiUrl, token, owner, repo, pullNumber, label }) {
  if (!label) return;
  await ensureLabel({ apiUrl, token, owner, repo, label });
  await githubJson({
    apiUrl,
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/issues/${pullNumber}/labels`,
    body: { labels: [label] },
  });
}

async function createOrUpdateBranch({
  apiUrl,
  token,
  owner,
  repo,
  branchName,
  sourceSha,
  message,
}) {
  const baseCommit = await githubJson({
    apiUrl,
    token,
    path: `/repos/${owner}/${repo}/git/commits/${sourceSha}`,
  });
  const createdCommit = await githubJson({
    apiUrl,
    token,
    method: "POST",
    path: `/repos/${owner}/${repo}/git/commits`,
    body: {
      message,
      tree: baseCommit.tree.sha,
      parents: [sourceSha],
    },
  });
  const ref = `heads/${branchName}`;
  try {
    await githubJson({
      apiUrl,
      token,
      method: "POST",
      path: `/repos/${owner}/${repo}/git/refs`,
      body: {
        ref: `refs/${ref}`,
        sha: createdCommit.sha,
      },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    await githubJson({
      apiUrl,
      token,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/git/refs/${encodeURIComponent(ref).replace(/%2F/g, "/")}`,
      body: {
        sha: createdCommit.sha,
        force: true,
      },
    });
  }
  return createdCommit.sha;
}

function findMergedProductionReleasePr({
  pullRequests = [],
  repository,
  productionReleaseLabel = "buildchain-release",
  productionReleaseHeadPrefix = "release/",
  base = "main",
} = {}) {
  const fullName = requiredString(repository, "repository");
  const label = requiredString(
    productionReleaseLabel,
    "productionReleaseLabel",
  );
  const headPrefix = optionalString(productionReleaseHeadPrefix);
  const candidates = (Array.isArray(pullRequests) ? pullRequests : []).filter(
    (pull) => {
      const labels = Array.isArray(pull?.labels)
        ? pull.labels.map((entry) => entry?.name || entry)
        : [];
      const headRef = optionalString(pull?.head?.ref);
      return (
        Boolean(pull?.merged_at) &&
        pull?.base?.ref === base &&
        pull?.head?.repo?.full_name === fullName &&
        labels.includes(label) &&
        (!headPrefix || headRef.startsWith(headPrefix))
      );
    },
  );
  if (candidates.length > 1) {
    throw new Error(
      `multiple merged production release PRs matched the source commit: ${candidates.map((pull) => `#${pull.number}`).join(", ")}`,
    );
  }
  return candidates[0];
}

export async function openProductionReleasePr({
  apiUrl = "https://api.github.com",
  token,
  repository,
  sourceSha,
  stagingResult,
  productionReleaseLabel = "buildchain-release",
  productionReleaseHeadPrefix = "release/",
  productionReleaseChannel = "production",
  runId = "",
  serverUrl = "https://github.com",
  releasePassportArtifact = "buildchain-web-surface-staging-release-passport",
} = {}) {
  const handoff = createProductionReleasePrHandoff({
    repository,
    sourceSha,
    stagingResult,
    productionReleaseLabel,
    productionReleaseHeadPrefix,
    productionReleaseChannel,
    runId,
    serverUrl,
    releasePassportArtifact,
  });
  const { owner, repo, branchName, title, body, head } = handoff;
  const normalizedToken = requiredString(token, "token");
  const associated = await githubJson({
    apiUrl,
    token: normalizedToken,
    path: `/repos/${owner}/${repo}/commits/${encodeURIComponent(handoff.sourceSha)}/pulls?per_page=100`,
  });
  let mergedReleasePull = findMergedProductionReleasePr({
    pullRequests: associated,
    repository,
    productionReleaseLabel,
    productionReleaseHeadPrefix,
    base: handoff.base,
  });
  if (!mergedReleasePull) {
    const closedByDeterministicHead = await githubJson({
      apiUrl,
      token: normalizedToken,
      path: `/repos/${owner}/${repo}/pulls?state=closed&base=${encodeURIComponent(handoff.base)}&head=${encodeURIComponent(head)}&per_page=100`,
    });
    mergedReleasePull = findMergedProductionReleasePr({
      pullRequests: closedByDeterministicHead,
      repository,
      productionReleaseLabel,
      productionReleaseHeadPrefix,
      base: handoff.base,
    });
  }
  if (mergedReleasePull) {
    return {
      action: "suppressed-merged-release-pr",
      status: "suppressed-merged-release-pr",
      ...handoff,
      branchName,
      pullNumber: mergedReleasePull.number,
      pullUrl: mergedReleasePull.html_url || mergedReleasePull.url || "",
      suppressionReason:
        "source-commit-already-has-qualifying-merged-release-pr",
    };
  }
  const existing = await githubJson({
    apiUrl,
    token: normalizedToken,
    path: `/repos/${owner}/${repo}/pulls?state=open&base=main&head=${encodeURIComponent(head)}`,
  });
  if (Array.isArray(existing) && existing.length > 0) {
    const pull = existing[0];
    await githubJson({
      apiUrl,
      token: normalizedToken,
      method: "PATCH",
      path: `/repos/${owner}/${repo}/pulls/${pull.number}`,
      body: { title, body },
    });
    await addLabel({
      apiUrl,
      token: normalizedToken,
      owner,
      repo,
      pullNumber: pull.number,
      label: handoff.label,
    });
    return {
      action: "updated",
      status: "updated",
      ...handoff,
      branchName,
      pullNumber: pull.number,
      pullUrl: pull.html_url,
    };
  }

  const commitSha = await createOrUpdateBranch({
    apiUrl,
    token: normalizedToken,
    owner,
    repo,
    branchName,
    sourceSha: handoff.sourceSha,
    message: `buildchain release intent: ${productionReleaseChannel} ${handoff.sourceSha.slice(0, 12)}`,
  });
  const pull = await githubJson({
    apiUrl,
    token: normalizedToken,
    method: "POST",
    path: `/repos/${owner}/${repo}/pulls`,
    body: {
      title,
      head: branchName,
      base: "main",
      body,
      maintainer_can_modify: true,
    },
  });
  await addLabel({
    apiUrl,
    token: normalizedToken,
    owner,
    repo,
    pullNumber: pull.number,
    label: handoff.label,
  });
  return {
    action: "created",
    status: "created",
    ...handoff,
    branchName,
    commitSha,
    pullNumber: pull.number,
    pullUrl: pull.html_url,
  };
}

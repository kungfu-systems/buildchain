export function releaseCandidateDownloadEnabled(value = "true") {
  return (
    String(value || "true")
      .trim()
      .toLowerCase() !== "false"
  );
}
export function splitRepository(repository) {
  const match = String(repository || "")
    .trim()
    .match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(
      `repository must be owner/repo, got ${repository || "<empty>"}`,
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`,
  };
}

export function normalizeBranch(value = "") {
  return String(value || "")
    .replace(/^refs\/heads\//, "")
    .trim();
}

export function assertSha(value, label = "sha") {
  const sha = String(value || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`${label} must be a 40-character Git SHA`);
  }
  return sha;
}

export const releaseCandidateRuntimeSha = (passport) =>
  assertSha(
    passport?.buildchain?.sha,
    "release candidate Passport Buildchain runtime SHA",
  ).toLowerCase();
export const resolveFreshPublicationVersion = ({
  sealedBundle,
  candidateVersion = "",
} = {}) =>
  String(sealedBundle?.manifest?.npm?.version || candidateVersion || "").trim();
export const optionalText = (value) => String(value || "");
export function selectMergedChannelPullRequest({
  pullRequests = [],
  targetRef,
  targetSha = "",
  repository,
}) {
  const normalizedTarget = normalizeBranch(targetRef);
  const candidates = pullRequests.filter((pr) => {
    const baseRepo =
      pr.base?.repo?.full_name || pr.baseRepository?.nameWithOwner;
    const merged = Boolean(pr.merged_at || pr.mergedAt || pr.merged === true);
    const rooted =
      !repository || (baseRepo || pr.head?.repo?.full_name) === repository;
    return (
      merged &&
      rooted &&
      (!targetSha ||
        (pr.merge_commit_sha || pr.mergeCommit?.oid) === targetSha) &&
      normalizeBranch(pr.base?.ref || pr.baseRefName || "") === normalizedTarget
    );
  });
  candidates.sort((left, right) => {
    const leftTime = Date.parse(
      left.merged_at || left.updated_at || left.closed_at || "",
    );
    const rightTime = Date.parse(
      right.merged_at || right.updated_at || right.closed_at || "",
    );
    return (rightTime || 0) - (leftTime || 0);
  });
  return candidates[0];
}

export function selectReleaseCandidateRuns({
  runs = [],
  pullRequest,
  workflowName = "",
}) {
  const prNumber = Number(pullRequest?.number || 0);
  const prHeadSha = String(
    pullRequest?.head?.sha || pullRequest?.headRefOid || "",
  ).trim();
  const prHeadBranch = normalizeBranch(
    pullRequest?.head?.ref || pullRequest?.headRefName || "",
  );
  const prHeadRepository =
    pullRequest?.head?.repo?.full_name ||
    pullRequest?.headRepository?.nameWithOwner ||
    "";
  const candidates = runs.filter((run) => {
    const runPrs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    const runHeadBranch = normalizeBranch(run.head_branch || "");
    const runHeadSha = String(run.head_sha || "").trim();
    const runHeadRepository =
      run.head_repository?.full_name || run.headRepository?.nameWithOwner || "";
    const matchesPrNumber = runPrs.some(
      (pr) => Number(pr.number || 0) === prNumber,
    );
    const matchesHeadSha = prHeadSha && runHeadSha === prHeadSha;
    const matchesHeadBranch =
      prHeadBranch &&
      runHeadBranch === prHeadBranch &&
      (!prHeadRepository ||
        !runHeadRepository ||
        runHeadRepository === prHeadRepository);
    const matchesPr =
      matchesPrNumber ||
      matchesHeadSha ||
      (!prNumber && !prHeadSha && matchesHeadBranch);
    const matchesWorkflow =
      !workflowName ||
      run.name === workflowName ||
      run.workflow_name === workflowName;
    return (
      matchesPr &&
      matchesWorkflow &&
      run.event === "pull_request" &&
      run.status === "completed" &&
      run.conclusion === "success"
    );
  });
  candidates.sort(
    (left, right) =>
      Date.parse(right.updated_at || right.created_at || "") -
      Date.parse(left.updated_at || left.created_at || ""),
  );
  return candidates;
}

export function selectReleaseCandidateRun({
  runs = [],
  pullRequest,
  workflowName = "",
}) {
  return selectReleaseCandidateRuns({ runs, pullRequest, workflowName })[0];
}

export function selectReleaseCandidateArtifacts({
  artifacts = [],
  artifactName = "",
}) {
  const expectedPrefix = String(artifactName || "").trim();
  const active = artifacts.filter((artifact) => !artifact.expired);
  const passports = active
    .map((artifact) => {
      const match = String(artifact.name || "").match(
        /^(.+)-release-candidate-([0-9a-f]{40})$/i,
      );
      return match
        ? { artifact, prefix: match[1], sourceSha: match[2] }
        : undefined;
    })
    .filter(Boolean)
    .filter(
      (candidate) => !expectedPrefix || candidate.prefix === expectedPrefix,
    );
  if (passports.length !== 1) {
    const scope = expectedPrefix ? ` for artifact-name ${expectedPrefix}` : "";
    throw new Error(
      `expected exactly one release-candidate passport artifact${scope}, found ${passports.length}`,
    );
  }
  const { artifact: passport, prefix, sourceSha: sha } = passports[0];
  const summaries = active.filter(
    (artifact) => artifact.name === `${prefix}-summary-${sha}`,
  );
  if (summaries.length !== 1) {
    throw new Error(
      `expected exactly one build summary artifact named ${prefix}-summary-${sha}, found ${summaries.length}`,
    );
  }
  return { passport, summary: summaries[0], prefix, sourceSha: sha };
}

import path from "node:path";

export function resolveAnchorRecoveryRequest({ passport, buildSummary, transactionId = "" } = {}) {
  if (Number(passport?.pullRequest?.number || 0)) return undefined;
  if (passport?.target?.channel !== "anchor" || passport?.target?.ref !== "publish-gate/anchor") {
    throw new Error("Release Candidate Passport has no PR identity");
  }
  let releaseManifest;
  try {
    releaseManifest = JSON.parse(buildSummary?.publishSource?.releaseManifest || "");
  } catch {
    throw new Error("anchored candidate release manifest is invalid");
  }
  const request = releaseManifest?.anchorRequest;
  if (
    releaseManifest?.sourceRef !== "publish-gate/anchor" ||
    releaseManifest?.sourceSha !== passport.source?.headSha ||
    request?.schema !== 1 ||
    request?.contract !== "kungfu-buildchain-explicit-publish-anchor-request/v1" ||
    !request.assignmentId ||
    !/^native:[0-9a-f-]+$/u.test(String(request.attemptId || "")) ||
    request.transactionId !== transactionId ||
    request.source?.sha !== passport.source?.headSha ||
    request.source?.tree !== passport.source?.treeHash ||
    !/^\d+$/u.test(String(request.supersededCandidate?.workflowRunId || "")) ||
    !/^[0-9a-f]{40}$/u.test(String(request.supersededCandidate?.sha || "")) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(request.supersededCandidate?.root || "")) ||
    request.runtime?.sha !== passport.buildchain?.sha
  ) {
    throw new Error("anchored candidate request does not bind the sealed recovery identity");
  }
  return request;
}

function normalizeRun(run, repository) {
  return {
    id: String(run.id), repository,
    headRepository: run.head_repository?.full_name || "",
    status: run.status, conclusion: run.conclusion,
    event: run.event, path: run.path, name: run.name,
    headSha: run.head_sha || "", headBranch: run.head_branch || "",
    pullRequestNumbers: (run.pull_requests || []).map((entry) => Number(entry.number)),
  };
}

export function normalizeCandidateRun(run, repository) {
  return normalizeRun(run, repository);
}

export function normalizeAnchorProvenance(anchorProvenance, repository) {
  if (!anchorProvenance) return undefined;
  return {
    request: anchorProvenance.request,
    run: normalizeRun(anchorProvenance.run, repository),
    workflow: {
      path: anchorProvenance.workflow.path,
      name: anchorProvenance.workflow.name,
      state: anchorProvenance.workflow.state,
    },
    passport: anchorProvenance.passport,
    buildSummary: anchorProvenance.buildSummary,
  };
}

export async function recoverCandidateProvenance({
  passport, buildSummary, transactionId, repoInfo, artifactName,
  expectedWorkflowFile, expectedWorkflowName, channel, apiUrl, token,
  fetchImpl, archiveDir, bundleRoot, githubJson, selectReleaseCandidateArtifacts,
  downloadArtifact, readOnlyJson,
}) {
  const request = resolveAnchorRecoveryRequest({ passport, buildSummary, transactionId });
  if (!request) {
    return { anchorProvenance: undefined, provenancePassport: passport };
  }
  const runId = String(request.supersededCandidate.workflowRunId);
  const run = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}` });
  const workflow = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${run.workflow_id}` });
  const artifactResponse = await githubJson({ apiUrl, token, fetchImpl, path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${runId}/artifacts?per_page=100` });
  const artifacts = Array.isArray(artifactResponse.artifacts) ? artifactResponse.artifacts : [];
  if (Number(artifactResponse.total_count || artifacts.length) !== artifacts.length) throw new Error("superseded candidate run has more than 100 artifacts; complete pagination is required before recovery");
  const selected = selectReleaseCandidateArtifacts({ artifacts, artifactName });
  const provenanceRoot = path.join(bundleRoot, "anchored-provenance");
  const passportDownload = await downloadArtifact({ artifact: selected.passport, repoInfo, apiUrl, token, archiveDir, bundleRoot: provenanceRoot, fetchImpl });
  const summaryDownload = await downloadArtifact({ artifact: selected.summary, repoInfo, apiUrl, token, archiveDir, bundleRoot: provenanceRoot, fetchImpl });
  const recoveredPassport = readOnlyJson(passportDownload.files.filter((file) => path.basename(file.path) === "release-candidate-passport.json"), "superseded release-candidate-passport.json");
  const recoveredBuildSummary = readOnlyJson(summaryDownload.files.filter((file) => path.basename(file.path) === "build-summary.json"), "superseded build-summary.json");
  if (
    String(run.id) !== runId ||
    recoveredPassport.workflow?.runId !== runId ||
    recoveredPassport.workflow?.name !== expectedWorkflowName ||
    String(workflow.path || run.path || "").split("@")[0].replace(/^\.github\/workflows\//u, "") !== expectedWorkflowFile.replace(/^\.github\/workflows\//u, "") ||
    recoveredPassport.target?.channel !== channel ||
    recoveredPassport.source?.headSha !== request.supersededCandidate.sha ||
    recoveredPassport.source?.treeHash !== request.source.tree ||
    `sha256:${recoveredPassport.candidateHash}` !== request.supersededCandidate.root
  ) throw new Error("superseded candidate provenance does not match the anchored request");
  const anchorProvenance = { request, run, workflow, passport: recoveredPassport, buildSummary: recoveredBuildSummary };
  return { anchorProvenance, provenancePassport: recoveredPassport };
}

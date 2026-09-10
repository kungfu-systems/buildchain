import {
  selectReleaseCandidateRuns,
  selectReleaseCandidateArtifacts,
} from "./selection.js";
import { githubJson } from "./transport.js";
export async function waitForCandidateArtifacts({
  repoInfo,
  pullRequest,
  workflowFile,
  workflowName,
  artifactName,
  waitSeconds,
  pollIntervalMs,
  sleepImpl,
  apiUrl,
  token,
  fetchImpl,
}) {
  const timeoutMs = Number(waitSeconds) * 1000;
  const intervalMs = Number(pollIntervalMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      `release-candidate waitSeconds must be a non-negative number, got ${waitSeconds}`,
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(
      `release-candidate pollIntervalMs must be a non-negative number, got ${pollIntervalMs}`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  let run;
  let artifactResponse;
  let selected;
  let selectionErrors = [];
  let candidateRuns = [];
  while (!selected) {
    const runs = await githubJson({
      apiUrl,
      token,
      fetchImpl,
      path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?event=pull_request&status=success&per_page=100`,
    });
    candidateRuns = selectReleaseCandidateRuns({
      runs: Array.isArray(runs.workflow_runs) ? runs.workflow_runs : [],
      pullRequest,
      workflowName,
    });
    selectionErrors = [];
    for (const candidateRun of candidateRuns) {
      const candidateArtifactResponse = await githubJson({
        apiUrl,
        token,
        fetchImpl,
        path: `/repos/${repoInfo.owner}/${repoInfo.repo}/actions/runs/${candidateRun.id}/artifacts?per_page=100`,
      });
      try {
        selected = selectReleaseCandidateArtifacts({
          artifacts: Array.isArray(candidateArtifactResponse.artifacts)
            ? candidateArtifactResponse.artifacts
            : [],
          artifactName,
        });
        run = candidateRun;
        artifactResponse = candidateArtifactResponse;
        break;
      } catch (error) {
        selectionErrors.push(`run ${candidateRun.id}: ${error.message}`);
      }
    }
    if (selected) break;
    if (Date.now() >= deadline) {
      if (!candidateRuns.length) {
        throw new Error(
          `no successful ${workflowName} pull_request run found for channel PR #${pullRequest.number} within ${waitSeconds}s`,
        );
      }
      throw new Error(
        `no successful ${workflowName} pull_request run for channel PR #${pullRequest.number} contained release-candidate artifacts within ${waitSeconds}s: ${selectionErrors.join("; ")}`,
      );
    }
    console.log(
      `> waiting for successful ${workflowName} release-candidate evidence for channel PR #${pullRequest.number}`,
    );
    await sleepImpl(intervalMs);
  }
  return { run, artifactResponse, selected };
}

import { readPublicBuildArtifact } from "../../providers/github/qualification-artifacts.js";
import {
  resolveStableCandidateQualificationCandidate,
  validatePublicBuildRun,
} from "./public-build.js";

async function readCanary({
  api,
  fetchArchive,
  repository,
  candidateSha,
  canary,
  statuses,
}) {
  const status = statuses.find((entry) => entry.context === canary.context);
  const evidence = {
    id: canary.id,
    candidateSha,
    status: "missing",
    attestor: status?.creator?.login || "",
  };
  if (!status || status.state !== "success") return evidence;
  const target =
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)\/?$/u.exec(
      status.target_url || "",
    );
  if (!target || target[1] !== repository || canary.repository !== repository)
    return { ...evidence, status: "mismatched" };
  const prefix = `/repos/${repository}/actions`;
  const run = await api(`${prefix}/runs/${target[2]}`);
  const workflow = await api(`${prefix}/workflows/${run.workflow_id}`);
  validatePublicBuildRun(run, workflow, repository);
  if (
    ![workflow.name, workflow.path?.split("/").pop()].includes(canary.workflow)
  )
    throw new Error("public build canary workflow differs from policy");
  const summary = await readPublicBuildArtifact({
    api,
    fetchArchive,
    repository,
    run,
  });
  const runtimeSha = resolveStableCandidateQualificationCandidate({
    repositoryName: repository,
    sourceRun: run,
    buildSummary: summary,
  });
  if (runtimeSha !== candidateSha)
    throw new Error("public build canary does not qualify the exact candidate");
  return {
    ...evidence,
    status: "success",
    completedAt: run.updated_at,
    evidenceUrl: status.target_url,
    repository,
    workflow: workflow.name,
    workflowId: workflow.id,
    runtimeRef: runtimeSha,
    runtimeRefSource: "public-build-summary",
  };
}

export async function resolvePublicBuildCanaryEvidence({
  api,
  fetchArchive,
  repository,
  candidateSha,
  policy,
}) {
  const canaries = policy.requiredCanaries.filter(
    (entry) => entry.source === "public-build",
  );
  if (!canaries.length) return [];
  const statuses = await api(
    `/repos/${repository}/commits/${candidateSha}/statuses?per_page=100`,
  );
  return Promise.all(
    canaries.map((canary) =>
      readCanary({
        api,
        fetchArchive,
        repository,
        candidateSha,
        canary,
        statuses,
      }),
    ),
  );
}

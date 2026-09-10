import { validateTailResealGitHubEvidence } from "../tail-reseal-github.js";
import { verifyFloatingConsumerPolicyReceipt } from "../../consumer/floating-consumer-policy.js";
export function verifyTailPolicyBindings({
  request,
  receipt,
  runtimeSha,
  sourceSha,
}) {
  if (request.runtime.sha !== runtimeSha)
    throw new Error("Tail runtime differs from job.workflow_sha");
  if (request.source.sha !== sourceSha)
    throw new Error("Tail source differs from the fresh workflow source");
  const result = verifyFloatingConsumerPolicyReceipt({
    receipt,
    receiptRoot: request.runtime.consumerPolicyReceiptRoot,
    repository: request.repository,
    sourceSha: request.source.sha,
    resolvedRuntimeSha: request.runtime.sha,
  });
  if (!result.ok)
    throw new Error(
      `Consumer policy receipt invalid: ${(result.failures || []).map(({ code }) => code).join(", ")}`,
    );
}
export async function admitTailResealFromGitHub(request, github) {
  const coords = (repository) => {
    const [owner, repo] = repository.split("/");
    return { owner, repo };
  };
  const source = coords(request.repository),
    signing = coords(request.signing.authorityRepository);
  const [
    sourceCommit,
    sourceRun,
    sourceJobs,
    sourceArtifacts,
    signingRun,
    signingArtifacts,
  ] = await Promise.all([
    github.rest.git
      .getCommit({ ...source, commit_sha: request.source.sha })
      .then((result) => result.data),
    github.rest.actions
      .getWorkflowRun({ ...source, run_id: request.source.runId })
      .then((result) => result.data),
    github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...source,
      run_id: request.source.runId,
      filter: "latest",
      per_page: 100,
    }),
    github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      ...source,
      run_id: request.source.runId,
      per_page: 100,
    }),
    github.rest.actions
      .getWorkflowRun({ ...signing, run_id: request.signing.authorityRunId })
      .then((result) => result.data),
    github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      ...signing,
      run_id: request.signing.authorityRunId,
      per_page: 100,
    }),
  ]);
  return validateTailResealGitHubEvidence({
    request,
    sourceCommit,
    sourceRun,
    sourceJobs,
    sourceArtifacts,
    signingRun,
    signingArtifacts,
  });
}

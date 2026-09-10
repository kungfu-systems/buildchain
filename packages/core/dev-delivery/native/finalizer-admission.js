import path from "node:path";
import { GitHubTwoPhaseClient } from "../../providers/dev-delivery/candidate.js";
import { readJson, writeJson } from "./files.js";
import { verifyDeliveryHeartbeat } from "./heartbeat.js";
import { verifyNativeProviderBoundary } from "./provider-boundary.js";
export async function admitProviderFinalizer(
  {
    workspace,
    repository,
    branch,
    pullRequestNumber,
    sourceHead,
    runtimeSha,
    runtimeSelectionRoot,
    run,
    runner,
    token,
    apiUrl,
  },
  dependencies = {},
) {
  const client =
    dependencies.client ||
    new GitHubTwoPhaseClient({ repository, token, apiUrl });
  const endpoint = `/repos/${repository}`;
  const [jobs, pullRequestReadback, baseRefReadback] = await Promise.all([
    client.request(
      `${endpoint}/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`,
    ),
    client.request(`${endpoint}/pulls/${pullRequestNumber}`),
    client.request(
      `${endpoint}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    ),
  ]);
  writeJson(path.join(workspace, ".buildchain/provider-jobs.json"), jobs);
  writeJson(
    path.join(workspace, ".buildchain/provider-pull-request.json"),
    pullRequestReadback,
  );
  writeJson(
    path.join(workspace, ".buildchain/provider-base-ref.json"),
    baseRefReadback,
  );
  const heartbeat = await (
    dependencies.verifyHeartbeat || verifyDeliveryHeartbeat
  )({
    repository,
    branch,
    token,
    apiUrl,
    admission: readJson(
      path.join(workspace, ".buildchain/dev-delivery/warrant.json"),
      "Warrant admission",
    ),
    receipt: readJson(
      path.join(workspace, ".buildchain/provider-heartbeat-receipt.json"),
      "heartbeat receipt",
    ),
    jobsReadback: jobs,
    workflowRunId: run.id,
    workflowRunAttempt: run.attempt,
    admissionJobName: "Reserve exact delivery candidate",
    heartbeatJobName: "Credentialed independent Warrant heartbeat",
    finalizerJobName: "Credentialed provider finalizer",
  });
  writeJson(
    path.join(workspace, ".buildchain/provider-heartbeat-verification.json"),
    heartbeat,
  );
  const result = verifyNativeProviderBoundary({
    directory: path.join(workspace, ".buildchain/native-transfer"),
    runtimeSha,
    runtimeSelectionRoot,
    pullRequestNumber,
    sourceHead,
    run,
    runner,
    jobs,
    pullRequestReadback,
    baseRefReadback,
    output: path.join(
      workspace,
      ".buildchain/provider-finalizer-boundary.json",
    ),
  });
  return {
    "transfer-root": result.transferRoot,
    "boundary-root": result.boundaryRoot,
    "native-outcome": result.nativeJob.conclusion,
    "native-job-id": result.nativeJob.id,
    "seal-job-id": result.sealJob.id,
  };
}

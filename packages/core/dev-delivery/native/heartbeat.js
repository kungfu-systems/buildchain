import {
  runDevDeliveryProviderHeartbeat,
  verifyDevDeliveryProviderHeartbeat,
} from "../dev-delivery-provider-heartbeat.js";
import { runDevDeliveryCommand } from "../warrant/service.js";
async function githubJson(apiUrl, token, requestPath, method = "GET") {
  if (!token) throw new Error("provider heartbeat requires GitHub credentials");
  const response = await fetch(
    `${String(apiUrl).replace(/\/$/u, "")}${requestPath}`,
    {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  const bytes = await response.text();
  const body = bytes ? JSON.parse(bytes) : {};
  if (!response.ok) {
    throw new Error(
      `GitHub provider ${requestPath} failed with ${response.status}: ${body.message || "unknown error"}`,
    );
  }
  return body;
}

function repositoryParts(value) {
  const match = String(value || "").match(/^([^/\s]+)\/([^/\s]+)$/u);
  if (!match) throw new Error("repository must be owner/repo");
  return { owner: match[1], repo: match[2] };
}

export async function coordinateExactProviderAttemptAfterHeartbeatLoss(
  { repository, workflowRunId, workflowRunAttempt },
  { readRun },
) {
  const run = await readRun(workflowRunId);
  if (
    Number(run.id) !== workflowRunId ||
    Number(run.run_attempt) !== workflowRunAttempt ||
    run.repository?.full_name !== repository ||
    run.status !== "in_progress"
  ) {
    throw new Error(
      "heartbeat loss cannot coordinate a different provider attempt",
    );
  }
  return {
    action: "exact-attempt-heartbeat-loss-observed",
    workflowRunId,
    workflowRunAttempt,
    cancellation: "withheld-run-scoped-api",
    nextAction:
      "Wait for terminal readback of this exact attempt; never cancel the run-scoped coordinate.",
  };
}

export async function heartbeatDeliveryAttempt(options) {
  const { owner, repo } = repositoryParts(options.repository);
  return runDevDeliveryProviderHeartbeat(
    {
      admission: options.admission,
      workflowRunId: options.workflowRunId,
      workflowRunAttempt: options.workflowRunAttempt,
      leaseSeconds: options.leaseSeconds,
      heartbeatSeconds: options.heartbeatSeconds,
    },
    {
      heartbeat: async ({
        expectedOldStateRoot,
        fencingToken,
        leaseGeneration,
        leaseSeconds,
      }) => {
        await options.beforeHeartbeat?.();
        return runDevDeliveryCommand({
          command: "heartbeat",
          repository: options.repository,
          branch: options.branch,
          expectedOldStateRoot,
          fencingToken,
          leaseGeneration,
          leaseSeconds,
          execute: true,
          token: options.token,
          apiUrl: options.apiUrl,
        });
      },
      readJobs: () =>
        githubJson(
          options.apiUrl,
          options.token,
          `/repos/${owner}/${repo}/actions/runs/${options.workflowRunId}/attempts/${options.workflowRunAttempt}/jobs?per_page=100`,
        ),
      onHeartbeatLoss:
        options.onHeartbeatLoss ||
        (async ({ workflowRunId, workflowRunAttempt }) => {
          await coordinateExactProviderAttemptAfterHeartbeatLoss(
            {
              repository: options.repository,
              workflowRunId,
              workflowRunAttempt,
            },
            {
              readRun: (runId) =>
                githubJson(
                  options.apiUrl,
                  options.token,
                  `/repos/${owner}/${repo}/actions/runs/${runId}`,
                ),
            },
          );
        }),
    },
  );
}

export async function verifyDeliveryHeartbeat(options) {
  const observed = await runDevDeliveryCommand({
    command: "observe",
    repository: options.repository,
    branch: options.branch,
    token: options.token,
    apiUrl: options.apiUrl,
  });
  return verifyDevDeliveryProviderHeartbeat(options.receipt, {
    admission: options.admission,
    jobsReadback: options.jobsReadback,
    liveObservation: observed.observation,
    workflowRunId: options.workflowRunId,
    workflowRunAttempt: options.workflowRunAttempt,
    admissionJobName: options.admissionJobName,
    heartbeatJobName: options.heartbeatJobName,
    finalizerJobName: options.finalizerJobName,
    observedAt: options.now,
  });
}

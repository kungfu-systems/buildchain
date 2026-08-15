import {
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { normalizeDevDeliveryProviderAttempt } from "./dev-delivery-provider-attempt.js";
import { sealLandingTerminalReadback } from "./dev-delivery-landing-terminal-evidence.js";

export {
  DEV_DELIVERY_LANDING_TERMINAL_READBACK_SCHEMA,
  verifyExpiredLandingSettlementReadback,
} from "./dev-delivery-landing-terminal-evidence.js";

function repositoryParts(value) {
  const match = text(value).match(/^([^/\s]+)\/([^/\s]+)$/u);
  if (!match) throw new Error("provider repository must be owner/repo");
  return { owner: match[1], repo: match[2], fullName: value };
}

async function githubRequest({
  apiUrl,
  token,
  path,
  method = "GET",
  fetchImpl = globalThis.fetch,
}) {
  if (!token) throw new Error("GitHub provider readback requires a token");
  if (typeof fetchImpl !== "function")
    throw new Error("GitHub provider readback requires fetch");
  const response = await fetchImpl(
    `${String(apiUrl).replace(/\/$/u, "")}${path}`,
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
  let body = null;
  if (bytes) {
    try {
      body = JSON.parse(bytes);
    } catch {
      throw new Error(
        `GitHub provider ${method} ${path} returned non-JSON evidence`,
      );
    }
  }
  if (!response.ok) {
    const error = new Error(
      `GitHub provider ${method} ${path} failed with ${response.status}: ${body?.message || "unknown error"}`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

async function githubJson(options) {
  const body = await githubRequest(options);
  if (!body || typeof body !== "object") {
    throw new Error(
      `GitHub provider readback ${options.path} returned no JSON`,
    );
  }
  return body;
}

async function readProviderSnapshot({
  apiUrl,
  token,
  owner,
  repo,
  runId,
  runAttempt,
  jobId,
  pullRequestNumber,
  workflowId,
  fetchImpl,
}) {
  const [run, job, pullRequest, workflow] = await Promise.all([
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${runAttempt}`,
      fetchImpl,
    }),
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/actions/jobs/${jobId}`,
      fetchImpl,
    }),
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/pulls/${pullRequestNumber}`,
      fetchImpl,
    }),
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/actions/workflows/${workflowId}`,
      fetchImpl,
    }),
  ]);
  return { run, job, pullRequest, workflow };
}

const LANDING_AUTHORITY_JOB_NAME = "Landing authority";

function currentProviderJob(jobsInput) {
  const entries = Array.isArray(jobsInput) ? jobsInput : jobsInput?.jobs;
  if (!Array.isArray(entries)) {
    throw new Error("GitHub provider current-attempt jobs readback is missing");
  }
  const matches = entries.filter(
    (entry) =>
      entry.status === "in_progress" &&
      (entry.name === LANDING_AUTHORITY_JOB_NAME ||
        String(entry.name || "").endsWith(` / ${LANDING_AUTHORITY_JOB_NAME}`)),
  );
  if (matches.length !== 1) {
    throw new Error(
      "GitHub provider current job cannot be independently identified",
    );
  }
  return matches[0];
}

export function deriveDevDeliveryLandingProviderAttempt({
  state,
  candidate,
  mergeGroupHead,
  providerRunId,
  providerRunAttempt,
  run,
  jobs,
  workflow,
  pullRequest,
} = {}) {
  const { fullName } = repositoryParts(state?.repository);
  const runId = positiveInteger(providerRunId, "GitHub provider run id");
  const runAttempt = positiveInteger(
    providerRunAttempt,
    "GitHub provider run attempt",
  );
  const exactMergeGroupHead = exactSha(
    mergeGroupHead,
    "provider merge-group head",
  );
  const workflowSha = exactSha(run?.head_sha, "GitHub provider workflow SHA");
  const runHeadBranch = text(run?.head_branch);
  if (
    Number(run?.id) !== runId ||
    Number(run?.run_attempt) !== runAttempt ||
    run?.repository?.full_name !== fullName ||
    run?.event !== "merge_group" ||
    run?.head_sha !== exactMergeGroupHead ||
    !runHeadBranch.startsWith(`gh-readonly-queue/${state.protectedBase}/`)
  ) {
    throw new Error("GitHub provider current execution context mismatch");
  }
  if (Number(workflow?.id) !== Number(run.workflow_id) || !workflow?.path) {
    throw new Error("GitHub provider current workflow context mismatch");
  }
  if (
    Number(pullRequest?.number) !== candidate.pullRequestNumber ||
    pullRequest?.head?.sha !== candidate.sourceHead ||
    pullRequest?.base?.ref !== state.protectedBase ||
    pullRequest?.base?.repo?.full_name !== fullName
  ) {
    throw new Error("GitHub provider pull request readback binding mismatch");
  }
  const providerJob = currentProviderJob(jobs);
  const workflowRef = `${fullName}/${workflow.path}@refs/heads/${runHeadBranch}`;
  return normalizeDevDeliveryProviderAttempt({
    schema: "kungfu.buildchain.github-landing-provider-attempt/v1",
    repository: fullName,
    workflowId: Number(workflow.id),
    workflowPath: workflow.path,
    workflowRef,
    workflowSha,
    event: run.event,
    runId,
    runAttempt,
    jobId: Number(providerJob.id),
    jobName: providerJob.name,
    jobRole: "landing-authority",
    runnerId: Number(providerJob.runner_id),
    runnerName: providerJob.runner_name,
    runnerGroupId: Number(providerJob.runner_group_id),
    runnerGroupName: providerJob.runner_group_name,
    runnerLabels: providerJob.labels,
    sourceHead: candidate.sourceHead,
    mergeGroupHead: exactMergeGroupHead,
    protectedBase: state.protectedBase,
  });
}

export async function readGitHubLandingProviderAttempt({
  state,
  candidate,
  mergeGroupHead,
  providerRunId,
  providerRunAttempt,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = globalThis.fetch,
} = {}) {
  const { owner, repo } = repositoryParts(state.repository);
  const runId = positiveInteger(providerRunId, "GitHub provider run id");
  const runAttempt = positiveInteger(
    providerRunAttempt,
    "GitHub provider run attempt",
  );
  const run = await githubJson({
    apiUrl,
    token,
    path: `/repos/${owner}/${repo}/actions/runs/${runId}`,
    fetchImpl,
  });
  const [jobs, workflow, pullRequest] = await Promise.all([
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
      fetchImpl,
    }),
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/actions/workflows/${run.workflow_id}`,
      fetchImpl,
    }),
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/pulls/${candidate.pullRequestNumber}`,
      fetchImpl,
    }),
  ]);
  return deriveDevDeliveryLandingProviderAttempt({
    state,
    candidate,
    mergeGroupHead,
    providerRunId: runId,
    providerRunAttempt: runAttempt,
    run,
    jobs,
    workflow,
    pullRequest,
  });
}

function providerAttemptIsTerminal({ run, job }) {
  return run.status === "completed" && job.status === "completed";
}

function providerRunMatches(run, attempt, fullName) {
  return (
    Number(run.id) === attempt.runId &&
    run.repository?.full_name === fullName &&
    Number(run.workflow_id) === attempt.workflowId &&
    Number(run.run_attempt) === attempt.runAttempt &&
    run.event === attempt.event &&
    run.head_sha === attempt.mergeGroupHead
  );
}

function providerJobMatches(job, attempt) {
  return (
    Number(job.id) === attempt.jobId &&
    job.name === attempt.jobName &&
    Number(job.runner_id) === attempt.runnerId &&
    job.runner_name === attempt.runnerName &&
    Number(job.runner_group_id) === attempt.runnerGroupId &&
    job.runner_group_name === attempt.runnerGroupName &&
    JSON.stringify([...(job.labels || [])].sort()) ===
      JSON.stringify(attempt.runnerLabels) &&
    String(job.run_url || "").endsWith(`/actions/runs/${attempt.runId}`)
  );
}

async function readProtectedBaseLanding({
  apiUrl,
  token,
  owner,
  repo,
  protectedBase,
  mergeGroupHead,
  fetchImpl = globalThis.fetch,
}) {
  const [comparison, protectedRef] = await Promise.all([
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/compare/${mergeGroupHead}...${encodeURIComponent(protectedBase)}`,
      fetchImpl,
    }),
    githubJson({
      apiUrl,
      token,
      path: `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(protectedBase)}`,
      fetchImpl,
    }),
  ]);
  const protectedBaseHead = exactSha(
    protectedRef.object?.sha,
    "GitHub protected base head",
  );
  const mergeBase = exactSha(
    comparison.merge_base_commit?.sha,
    "GitHub protected base merge-base",
  );
  const status = text(comparison.status);
  if (!new Set(["ahead", "behind", "diverged", "identical"]).has(status)) {
    throw new Error("GitHub protected base comparison status is unsupported");
  }
  return {
    protectedBaseHead,
    providerRunHeadInProtectedBase:
      mergeBase === mergeGroupHead &&
      new Set(["ahead", "identical"]).has(status),
  };
}

function providerPullRequestMatches(
  pullRequest,
  candidate,
  attempt,
  fullName,
  requireCurrentSourceHead,
) {
  return (
    Number(pullRequest.number) === candidate.pullRequestNumber &&
    (!requireCurrentSourceHead ||
      pullRequest.head?.sha === candidate.sourceHead) &&
    pullRequest.base?.ref === attempt.protectedBase &&
    pullRequest.base?.repo?.full_name === fullName
  );
}

function assertProviderAttemptIdentity({
  snapshot,
  fullName,
  candidate,
  warrant,
  observedAt,
  requireCurrentSourceHead = true,
}) {
  const { run, job, pullRequest, workflow } = snapshot;
  const attempt = normalizeDevDeliveryProviderAttempt(warrant.providerAttempt, {
    repository: fullName,
    sourceHead: candidate.sourceHead,
    protectedBase: warrant.providerAttempt.protectedBase,
    mergeGroupHead: warrant.mergeGroupHead,
  });
  if (!providerRunMatches(run, attempt, fullName)) {
    throw new Error("GitHub provider run readback binding mismatch");
  }
  if (
    Number(workflow.id) !== attempt.workflowId ||
    workflow.path !== attempt.workflowPath
  ) {
    throw new Error("GitHub provider workflow readback binding mismatch");
  }
  if (!providerJobMatches(job, attempt)) {
    throw new Error("GitHub provider job readback binding mismatch");
  }
  if (
    !providerPullRequestMatches(
      pullRequest,
      candidate,
      attempt,
      fullName,
      requireCurrentSourceHead,
    )
  ) {
    throw new Error("GitHub provider pull request readback binding mismatch");
  }
  const startedAt = timestamp(job.started_at, "provider job start");
  if (
    Date.parse(startedAt) < Date.parse(warrant.issuedAt) ||
    Date.parse(startedAt) > Date.parse(observedAt)
  ) {
    throw new Error(
      "GitHub provider job readback is stale for this Landing fence",
    );
  }
}

export async function readGitHubLandingActiveProviderAttempt({
  state,
  candidate,
  warrant,
  providerAttempt,
  token,
  apiUrl = "https://api.github.com",
  now = new Date().toISOString(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const observedAt = timestamp(now, "provider heartbeat observation time");
  const persistedAttempt = normalizeDevDeliveryProviderAttempt(
    warrant?.providerAttempt,
    {
      repository: state?.repository,
      sourceHead: candidate?.sourceHead,
      mergeGroupHead: warrant?.mergeGroupHead,
      protectedBase: state?.protectedBase,
    },
  );
  const requestedAttempt = normalizeDevDeliveryProviderAttempt(
    providerAttempt,
    {
      repository: state?.repository,
      sourceHead: candidate?.sourceHead,
      mergeGroupHead: warrant?.mergeGroupHead,
      protectedBase: state?.protectedBase,
    },
  );
  if (JSON.stringify(requestedAttempt) !== JSON.stringify(persistedAttempt)) {
    throw new Error(
      "Landing heartbeat provider attempt does not match persisted admission",
    );
  }
  const { owner, repo, fullName } = repositoryParts(state.repository);
  const snapshot = await readProviderSnapshot({
    apiUrl,
    token,
    owner,
    repo,
    runId: persistedAttempt.runId,
    runAttempt: persistedAttempt.runAttempt,
    jobId: persistedAttempt.jobId,
    pullRequestNumber: candidate.pullRequestNumber,
    workflowId: persistedAttempt.workflowId,
    fetchImpl,
  });
  assertProviderAttemptIdentity({
    snapshot,
    fullName,
    candidate,
    warrant,
    observedAt,
  });
  if (
    snapshot.run.status !== "in_progress" ||
    snapshot.job.status !== "in_progress" ||
    snapshot.run.conclusion ||
    snapshot.job.conclusion
  ) {
    throw new Error(
      "Landing heartbeat requires the exact admitted provider run and job to remain active",
    );
  }
  return persistedAttempt;
}

function outcomeFromProvider(
  run,
  job,
  pullRequest,
  { providerRunHeadInProtectedBase },
) {
  if (pullRequest.merged_at) {
    return providerRunHeadInProtectedBase ? "merged" : "dequeued";
  }
  if (pullRequest.state === "closed") return "cancelled";
  if (job.conclusion === "cancelled") return "cancelled";
  if (
    [
      "failure",
      "timed_out",
      "action_required",
      "startup_failure",
      "stale",
    ].includes(job.conclusion)
  ) {
    return "terminal-failure";
  }
  if (job.conclusion === "skipped") return "dequeued";
  throw new Error(
    "GitHub provider terminal state does not prove a durable Landing outcome",
  );
}

export async function readGitHubLandingTerminalState({
  state,
  candidate,
  warrant,
  token,
  apiUrl = "https://api.github.com",
  now = new Date().toISOString(),
}) {
  const observedAt = timestamp(now, "provider observation time");
  const providerAttempt = normalizeDevDeliveryProviderAttempt(
    warrant.providerAttempt,
    {
      repository: state.repository,
      sourceHead: candidate.sourceHead,
      mergeGroupHead: warrant.mergeGroupHead,
      protectedBase: state.protectedBase,
    },
  );
  const runId = providerAttempt.runId;
  const jobId = providerAttempt.jobId;
  const { owner, repo, fullName } = repositoryParts(state.repository);
  let snapshot = await readProviderSnapshot({
    apiUrl,
    token,
    owner,
    repo,
    runId,
    runAttempt: providerAttempt.runAttempt,
    jobId,
    pullRequestNumber: candidate.pullRequestNumber,
    workflowId: providerAttempt.workflowId,
  });
  assertProviderAttemptIdentity({
    snapshot,
    fullName,
    candidate,
    warrant,
    observedAt,
    requireCurrentSourceHead: false,
  });
  if (!providerAttemptIsTerminal(snapshot)) {
    throw new Error(
      "the exact admitted provider attempt is still active; terminal cleanup refuses run-level cancellation",
    );
  }
  const { run, job, pullRequest } = snapshot;
  if (!run.conclusion || !job.conclusion) {
    throw new Error("GitHub provider terminal conclusion is missing");
  }
  const completedAt = timestamp(job.completed_at, "provider job completion");
  if (
    Date.parse(completedAt) < Date.parse(warrant.issuedAt) ||
    Date.parse(completedAt) > Date.parse(observedAt)
  ) {
    throw new Error(
      "GitHub provider job readback is stale for this Landing fence",
    );
  }
  const protectedBaseLanding = await readProtectedBaseLanding({
    apiUrl,
    token,
    owner,
    repo,
    protectedBase: state.protectedBase,
    mergeGroupHead: providerAttempt.mergeGroupHead,
  });
  const outcome = outcomeFromProvider(
    run,
    job,
    pullRequest,
    protectedBaseLanding,
  );
  return sealLandingTerminalReadback({
    repository: state.repository,
    protectedBase: state.protectedBase,
    stateRoot: state.stateRoot,
    candidateId: candidate.candidateId,
    pullRequestNumber: candidate.pullRequestNumber,
    sourceHead: candidate.sourceHead,
    landingWarrantToken: warrant.token,
    landingWarrantGeneration: warrant.generation,
    providerRunId: runId,
    providerRunAttempt: run.run_attempt,
    providerRunState: run.status,
    providerRunConclusion: run.conclusion,
    providerRunHead: run.head_sha,
    providerJobId: jobId,
    providerJobState: job.status,
    providerJobConclusion: job.conclusion,
    providerJobStartedAt: job.started_at,
    providerJobCompletedAt: completedAt,
    providerAttempt,
    admissionRoot: warrant.mergeGroupAdmissionRoot,
    pullRequestState: pullRequest.state,
    pullRequestMerged: Boolean(pullRequest.merged_at),
    ...protectedBaseLanding,
    outcome,
    reason: `GitHub run ${runId} job ${jobId} concluded ${job.conclusion}`,
    observedAt,
  });
}

import fs from "node:fs";
import path from "node:path";

import {
  devDeliveryClone as clone,
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryExactSha as exactSha,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryProtectedBase as protectedBase,
  devDeliveryRepository as repository,
  devDeliveryText as normalizedText,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { assertDevDeliveryGitHubHostedRunner } from "./dev-delivery-provider-attempt.js";

export const PROVIDER_FINALIZER_BOUNDARY_SCHEMA =
  "kungfu.buildchain.provider-finalizer-boundary/v1";
export const PROVIDER_FAILURE_SETTLEMENT_SCHEMA =
  "kungfu.buildchain.provider-failure-settlement/v1";

export {
  createNativeExecutionTransfer,
  NATIVE_EXECUTION_TRANSFER_SCHEMA,
  stageNativeExecutionTransfer,
  verifyNativeExecutionTransfer,
} from "./dev-delivery-execution-transfer.js";

const PROVIDER_CREDENTIAL_NAME =
  /(?:^(?:ACTIONS_ID_TOKEN_REQUEST_TOKEN|AWS_SESSION_TOKEN|AWS_WEB_IDENTITY_TOKEN_FILE|AZURE_FEDERATED_TOKEN_FILE|GH_TOKEN|GITHUB_TOKEN|GOOGLE_GHA_CREDS_PATH|KUNGFU_GITHUB_TOKEN|NPM_TOKEN|SSH_AUTH_SOCK)$|(?:^|_)(?:(?:api|access|auth|publish|release|provider|promotion|governance|approval|mutation|write)_?(?:key|token)|authorization|credentials?|password|secret|private_key|client_secret|signing_key)(?:_|$))/iu;
const HOSTED_RUNNER_BOUNDARY = "github-actions-runner-worker/v1";
const GITHUB_HOSTED_LINUX_WORKER =
  /^\/home\/runner\/runners\/(\d+\.\d+\.\d+)\/bin\/Runner\.Worker$/u;
function text(value, label) {
  const normalized = normalizedText(value);
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function isCredentialVariableName(name) {
  return PROVIDER_CREDENTIAL_NAME.test(String(name || "").trim());
}

function readProcFile(procRoot, pid, name, readFileSync) {
  const file = path.posix.join(procRoot, String(pid), name);
  return ancestryRead(readFileSync, file, "utf8");
}

function ancestryRead(reader, file, ...args) {
  try {
    return reader(file, ...args);
  } catch (error) {
    throw new Error(
      `credential ancestry is unreadable at ${file}: ${error.code || error.message}`,
    );
  }
}

function processCredentialNames(procRoot, pid, readFileSync) {
  return readProcFile(procRoot, pid, "environ", readFileSync)
    .split("\0")
    .filter((entry) => {
      const separator = entry.indexOf("=");
      return (
        separator > 0 &&
        Boolean(entry.slice(separator + 1)) &&
        isCredentialVariableName(entry.slice(0, separator))
      );
    })
    .map((entry) => entry.slice(0, entry.indexOf("=")));
}

function processParentPid(procRoot, pid, readFileSync) {
  const status = readProcFile(procRoot, pid, "status", readFileSync);
  const match = status.match(/^PPid:\s+(\d+)$/mu);
  if (!match)
    throw new Error(`credential ancestry has no PPid for process ${pid}`);
  return Number(match[1]);
}

function assertHostedLinuxController(environment) {
  const expected = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    BUILDCHAIN_CREDENTIAL_ANCESTRY_BOUNDARY: HOSTED_RUNNER_BOUNDARY,
  };
  const exact = Object.entries(expected).every(
    ([name, value]) => environment[name] === value,
  );
  if (!exact || !/^GitHub Actions(?: \d+)?$/u.test(environment.RUNNER_NAME)) {
    throw new Error(
      "credential ancestry requires the explicit GitHub-hosted Linux runner boundary",
    );
  }
}

function hostedBoundary(procRoot, pid, command, readlinkSync) {
  if (
    command.length !== 4 ||
    !GITHUB_HOSTED_LINUX_WORKER.test(command[0] || "") ||
    command[1] !== "spawnclient" ||
    !/^\d+$/u.test(command[2] || "") ||
    !/^\d+$/u.test(command[3] || "")
  ) {
    return null;
  }
  const link = path.posix.join(procRoot, String(pid), "exe");
  const executable = ancestryRead(readlinkSync, link);
  if (
    !GITHUB_HOSTED_LINUX_WORKER.test(executable) ||
    command[0] !== executable
  ) {
    throw new Error("credential ancestry found an untrusted Runner.Worker");
  }
  return { pid, kind: HOSTED_RUNNER_BOUNDARY, executable };
}

export function inspectCredentiallessProcessAncestry({
  pid = process.pid,
  platform = process.platform,
  procRoot = "/proc",
  readFileSync = fs.readFileSync,
  readlinkSync = fs.readlinkSync,
  environment = process.env,
} = {}) {
  if (platform !== "linux")
    throw new Error("credential ancestry requires Linux /proc evidence");
  assertHostedLinuxController(environment);
  const exposed = [];
  const traversed = [];
  const visited = new Set();
  let current = positiveInteger(pid, "process pid");
  while (true) {
    if (visited.has(current))
      throw new Error(`credential ancestry cycle at process ${current}`);
    visited.add(current);
    traversed.push(current);
    const names = processCredentialNames(procRoot, current, readFileSync);
    if (names.length > 0)
      exposed.push({ pid: current, names: [...new Set(names)].sort() });
    const command = readProcFile(procRoot, current, "cmdline", readFileSync)
      .split("\0")
      .filter(Boolean);
    const boundary = hostedBoundary(procRoot, current, command, readlinkSync);
    if (boundary)
      return { ok: exposed.length === 0, boundary, exposed, traversed };
    const parent = processParentPid(procRoot, current, readFileSync);
    if (!Number.isInteger(parent) || parent <= 1)
      throw new Error("credential ancestry escaped before trusted boundary");
    current = parent;
  }
}

export function assertCredentiallessProcessAncestry(options = {}) {
  const inspection = inspectCredentiallessProcessAncestry(options);
  if (!inspection.ok) {
    throw new Error(
      `write-capable credential-like variable found in process ancestry: ${inspection.exposed
        .map(({ pid, names }) => `${pid}:${names.join(",")}`)
        .join(" ")}`,
    );
  }
  return inspection;
}

export function devDeliveryProviderJobByName(jobs, expectedName) {
  const exactName = text(expectedName, "provider job name");
  const suffix = ` / ${exactName}`;
  const matches = jobs.filter((job) => {
    const actualName = String(job.name || "");
    return (
      actualName === exactName ||
      (actualName.endsWith(suffix) && actualName.length > suffix.length)
    );
  });
  if (matches.length !== 1) {
    throw new Error(`expected exactly one provider job named ${exactName}`);
  }
  return matches[0];
}

function assertHostedJob(job, runAttempt, label) {
  if (Number(job.run_attempt) !== runAttempt)
    throw new Error(`${label} run attempt mismatch`);
  if (!job.runner_name) throw new Error(`${label} runner name is missing`);
  assertDevDeliveryGitHubHostedRunner({
    runnerGroupName: job.runner_group_name,
    runnerLabels: job.labels,
  });
}

export function createNativeExecutionSealBinding({
  nativeContext,
  sealJob,
  sealRunnerName,
  sealRunnerEnvironment,
  sealRunnerOs,
  sealRunnerArch,
  observedAt,
} = {}) {
  if (sealRunnerEnvironment !== "github-hosted") {
    throw new Error(
      "native execution seal requires a GitHub-hosted fresh runner",
    );
  }
  const native = clone(nativeContext || {});
  const nativeRunId = positiveInteger(native.workflowRunId, "workflow run id");
  const nativeRunAttempt = positiveInteger(
    native.workflowRunAttempt,
    "workflow run attempt",
  );
  const nativeCompletedAt = timestamp(
    native.evidenceCompletedAt,
    "native evidence completion time",
  );
  const sealedAt = timestamp(observedAt, "seal observation time");
  if (
    text(native.job) === text(sealJob) ||
    text(native.runnerName) === text(sealRunnerName)
  ) {
    throw new Error("native and seal job or runner identities match");
  }
  if (
    native.schema !== "kungfu.buildchain.native-job-context/v1" ||
    native.runnerEnvironment !== "github-hosted" ||
    !["succeeded", "failed"].includes(native.outcome)
  ) {
    throw new Error("native job context is not a hosted terminal outcome");
  }
  if (Date.parse(nativeCompletedAt) >= Date.parse(sealedAt)) {
    throw new Error("native evidence completion and seal ordering is invalid");
  }
  return {
    producer: {
      workflowRunId: nativeRunId,
      workflowRunAttempt: nativeRunAttempt,
      job: text(native.job),
      runnerEnvironment: native.runnerEnvironment,
      runnerName: text(native.runnerName),
      runnerOs: text(native.runnerOs),
      runnerArch: text(native.runnerArch),
    },
    sealer: {
      job: text(sealJob),
      runnerEnvironment: sealRunnerEnvironment,
      runnerName: sealRunnerName,
      runnerOs: text(sealRunnerOs, "seal runner OS"),
      runnerArch: text(sealRunnerArch, "seal runner architecture"),
    },
    nativeOutcome: native.outcome,
    nativeCompletedAt,
    sealedAt,
  };
}

function failureSettlementBinding(executionTransfer, nativeJobId, sealJobId) {
  if (!executionTransfer.failure || !executionTransfer.failureSettlement) {
    throw new Error(
      "failed execution transfer lacks verified failure evidence",
    );
  }
  return {
    schema: PROVIDER_FAILURE_SETTLEMENT_SCHEMA,
    outcome: "terminal-failure",
    evidenceRoot: executionTransfer.failure.evidenceRoot,
    reason: executionTransfer.failure.reason,
    warrantStateRoot: executionTransfer.warrant.stateRoot,
    candidateId: executionTransfer.warrant.candidateId,
    fencingToken: executionTransfer.warrant.fencingToken,
    leaseGeneration: executionTransfer.warrant.generation,
    pullRequestNumber: executionTransfer.warrant.pullRequestNumber,
    sourceHead: executionTransfer.warrant.sourceHead,
    transferRoot: executionTransfer.transferRoot,
    nativeJobId,
    sealJobId,
    nativeJobConclusion: "failure",
  };
}

function failureBoundaryFields(executionTransfer, nativeJobId, sealJobId) {
  return executionTransfer.outcome === "failed"
    ? {
        failureSettlement: failureSettlementBinding(
          executionTransfer,
          nativeJobId,
          sealJobId,
        ),
      }
    : {};
}

export function createProviderFinalizerBoundary({
  jobs,
  executionTransfer,
  workflowRunId,
  workflowRunAttempt,
  nativeJobName,
  sealJobName,
  finalizerJobName,
  finalizerRunnerName,
  finalizerRunnerEnvironment,
  pullRequestReadback,
  baseRefReadback,
  observedAt,
} = {}) {
  if (finalizerRunnerEnvironment !== "github-hosted") {
    throw new Error("provider finalizer requires a GitHub-hosted fresh runner");
  }
  const runId = positiveInteger(workflowRunId, "workflow run id");
  const runAttempt = positiveInteger(
    workflowRunAttempt,
    "workflow run attempt",
  );
  const entries = Array.isArray(jobs) ? jobs : jobs?.jobs;
  if (!Array.isArray(entries))
    throw new Error("provider jobs readback is required");
  if (
    executionTransfer.producer.workflowRunId !== runId ||
    executionTransfer.producer.workflowRunAttempt !== runAttempt
  ) {
    throw new Error("native execution transfer workflow identity mismatch");
  }
  const nativeJob = devDeliveryProviderJobByName(entries, nativeJobName);
  const sealJob = devDeliveryProviderJobByName(entries, sealJobName);
  const finalizerJob = devDeliveryProviderJobByName(entries, finalizerJobName);
  const nativeJobId = positiveInteger(nativeJob.id, "native provider job id");
  const finalizerJobId = positiveInteger(
    finalizerJob.id,
    "finalizer provider job id",
  );
  const sealJobId = positiveInteger(sealJob.id, "seal provider job id");
  const jobIds = [nativeJobId, sealJobId, finalizerJobId];
  const runnerNames = [
    nativeJob.runner_name,
    sealJob.runner_name,
    finalizerJob.runner_name,
  ];
  if (new Set(jobIds).size !== 3 || new Set(runnerNames).size !== 3) {
    throw new Error(
      "native, seal, and finalizer identities are not pairwise distinct",
    );
  }
  if (nativeJob.runner_name !== executionTransfer.producer.runnerName) {
    throw new Error("native runner live readback does not match transfer");
  }
  if (
    executionTransfer.producer.job !== "native-execution" ||
    executionTransfer.sealer.job !== "seal-native-execution" ||
    sealJob.runner_name !== executionTransfer.sealer.runnerName
  ) {
    throw new Error("native or seal live job identity does not match transfer");
  }
  if (finalizerJob.runner_name !== finalizerRunnerName) {
    throw new Error("finalizer runner live readback does not match context");
  }
  assertHostedJob(nativeJob, runAttempt, "native");
  assertHostedJob(sealJob, runAttempt, "seal");
  assertHostedJob(finalizerJob, runAttempt, "finalizer");
  const expectedConclusion =
    executionTransfer.outcome === "succeeded" ? "success" : "failure";
  if (
    nativeJob.status !== "completed" ||
    nativeJob.conclusion !== expectedConclusion
  ) {
    throw new Error(
      "native provider job is not terminal with the transferred outcome",
    );
  }
  if (sealJob.status !== "completed" || sealJob.conclusion !== "success") {
    throw new Error("provider seal job is not successfully completed");
  }
  if (finalizerJob.status !== "in_progress") {
    throw new Error("provider finalizer job is not the live in-progress job");
  }
  const transferredAt = timestamp(
    executionTransfer.completedAt,
    "native transfer completion time",
  );
  const nativeStartedAt = timestamp(
    nativeJob.started_at,
    "native provider job start time",
  );
  const nativeCompletedAt = timestamp(
    nativeJob.completed_at,
    "native provider job completion time",
  );
  const sealStartedAt = timestamp(sealJob.started_at, "seal job start time");
  const sealCompletedAt = timestamp(
    sealJob.completed_at,
    "seal job completion time",
  );
  const finalizerStartedAt = timestamp(
    finalizerJob.started_at,
    "finalizer provider job start time",
  );
  const boundaryObservedAt = timestamp(observedAt, "boundary observation time");
  if (
    Date.parse(nativeStartedAt) >= Date.parse(nativeCompletedAt) ||
    Date.parse(transferredAt) > Date.parse(nativeCompletedAt) ||
    Date.parse(nativeCompletedAt) >= Date.parse(sealStartedAt) ||
    Date.parse(sealStartedAt) >= Date.parse(sealCompletedAt) ||
    Date.parse(executionTransfer.sealedAt) > Date.parse(sealCompletedAt) ||
    Date.parse(sealCompletedAt) >= Date.parse(finalizerStartedAt) ||
    Date.parse(boundaryObservedAt) < Date.parse(finalizerStartedAt)
  ) {
    throw new Error(
      "provider finalizer did not start after ordered native and seal completion",
    );
  }
  const expectedRepository = repository(executionTransfer.warrant.repository);
  const expectedProtectedBase = protectedBase(
    executionTransfer.warrant.protectedBase,
  );
  const expectedPullRequest = positiveInteger(
    executionTransfer.warrant.pullRequestNumber,
    "Warrant pull request number",
  );
  if (
    Number(pullRequestReadback?.number) !== expectedPullRequest ||
    pullRequestReadback?.state !== "open" ||
    pullRequestReadback?.head?.sha !== executionTransfer.warrant.sourceHead
  ) {
    throw new Error("live pull request readback is stale or mismatched");
  }
  if (pullRequestReadback?.base?.ref !== expectedProtectedBase) {
    throw new Error("live pull request protected base is stale or mismatched");
  }
  if (pullRequestReadback?.base?.repo?.full_name !== expectedRepository) {
    throw new Error("live pull request repository is stale or mismatched");
  }
  if (
    baseRefReadback?.ref !== `refs/heads/${expectedProtectedBase}` ||
    baseRefReadback?.object?.type !== "commit"
  ) {
    throw new Error("live protected base ref readback is stale or mismatched");
  }
  const protectedBaseSha = exactSha(
    baseRefReadback.object.sha,
    "live protected base SHA",
  );
  const body = {
    schema: PROVIDER_FINALIZER_BOUNDARY_SCHEMA,
    workflowRunId: runId,
    workflowRunAttempt: runAttempt,
    nativeJob: {
      id: nativeJobId,
      name: nativeJob.name,
      runnerName: nativeJob.runner_name,
      startedAt: nativeStartedAt,
      completedAt: nativeCompletedAt,
      conclusion: nativeJob.conclusion,
    },
    sealJob: {
      id: sealJobId,
      name: sealJob.name,
      runnerName: sealJob.runner_name,
      startedAt: sealStartedAt,
      completedAt: sealCompletedAt,
      conclusion: sealJob.conclusion,
    },
    finalizerJob: {
      id: finalizerJobId,
      name: finalizerJob.name,
      runnerName: finalizerJob.runner_name,
      startedAt: finalizerStartedAt,
      status: finalizerJob.status,
    },
    providerSource: {
      repository: expectedRepository,
      pullRequestNumber: expectedPullRequest,
      sourceHead: executionTransfer.warrant.sourceHead,
      protectedBase: expectedProtectedBase,
      protectedBaseSha,
      pullRequestState: "open",
    },
    transferRoot: exactRoot(executionTransfer.transferRoot, "transfer root"),
    separation: "pairwise-distinct-github-hosted-native-seal-finalizer",
    observedAt: boundaryObservedAt,
    ...failureBoundaryFields(executionTransfer, nativeJobId, sealJobId),
  };
  return { ...body, boundaryRoot: devDeliveryContentRoot(body) };
}

export function verifyProviderFailureSettlementBinding(
  boundaryInput,
  executionTransfer,
  expected = {},
) {
  const boundary = clone(boundaryInput || {});
  const boundaryRoot = exactRoot(
    boundary.boundaryRoot,
    "provider finalizer boundary root",
  );
  delete boundary.boundaryRoot;
  if (boundary.schema !== PROVIDER_FINALIZER_BOUNDARY_SCHEMA) {
    throw new Error("provider finalizer boundary schema is unsupported");
  }
  if (devDeliveryContentRoot(boundary) !== boundaryRoot) {
    throw new Error("provider finalizer boundary root drift");
  }
  if (executionTransfer.outcome !== "failed") {
    throw new Error("provider failure settlement requires a failed transfer");
  }
  if (boundary.transferRoot !== executionTransfer.transferRoot) {
    throw new Error("provider failure settlement transfer root mismatch");
  }
  const settlement = failureSettlementBinding(
    executionTransfer,
    positiveInteger(boundary.nativeJob?.id, "native provider job id"),
    positiveInteger(boundary.sealJob?.id, "seal provider job id"),
  );
  if (
    JSON.stringify(boundary.failureSettlement) !== JSON.stringify(settlement)
  ) {
    throw new Error("provider failure settlement boundary binding mismatch");
  }
  if (
    boundary.nativeJob?.conclusion !== "failure" ||
    boundary.providerSource?.pullRequestNumber !==
      settlement.pullRequestNumber ||
    boundary.providerSource?.sourceHead !== settlement.sourceHead ||
    boundary.providerSource?.protectedBase !==
      executionTransfer.warrant.protectedBase
  ) {
    throw new Error("provider failure settlement live-state binding mismatch");
  }
  const observed = {
    boundaryRoot,
    finalizerBoundaryRoot: boundaryRoot,
    transferRoot: settlement.transferRoot,
    evidenceRoot: settlement.evidenceRoot,
    nativeJobId: settlement.nativeJobId,
    sealJobId: settlement.sealJobId,
    warrantStateRoot: settlement.warrantStateRoot,
    candidateId: settlement.candidateId,
    fencingToken: settlement.fencingToken,
    leaseGeneration: settlement.leaseGeneration,
    pullRequestNumber: settlement.pullRequestNumber,
    sourceHead: settlement.sourceHead,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && observed[field] !== value) {
      throw new Error(`provider failure settlement ${field} mismatch`);
    }
  }
  return {
    ...settlement,
    finalizerBoundaryRoot: boundaryRoot,
  };
}

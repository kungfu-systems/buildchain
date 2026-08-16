import {
  devDeliveryContentRoot,
  devDeliveryExactRoot as exactRoot,
  devDeliveryPositiveInteger as positiveInteger,
  devDeliveryRepository as repository,
  devDeliveryText as text,
  devDeliveryTimestamp as timestamp,
} from "./dev-delivery-common.js";
import { assertDevDeliveryGitHubHostedRunner } from "./dev-delivery-provider-attempt.js";
import { devDeliveryProviderJobByName } from "./dev-delivery-process-boundary.js";

export const DEV_DELIVERY_PROVIDER_HEARTBEAT_SCHEMA =
  "kungfu.buildchain.provider-heartbeat-receipt/v1";

function selectedWarrant(result = {}) {
  return result.warrant || result.observation?.activeWarrant || null;
}

function exactWarrant(input = {}) {
  const warrant = selectedWarrant(input);
  if (!warrant)
    throw new Error("provider heartbeat requires an active Warrant");
  return {
    repository: repository(input.observation?.repository || input.repository),
    protectedBase: text(
      input.observation?.protectedBase || input.protectedBase,
    ),
    candidateId: exactRoot(warrant.candidateId, "heartbeat candidateId"),
    fencingToken: exactRoot(warrant.fencingToken, "heartbeat fencingToken"),
    generation: positiveInteger(warrant.generation, "heartbeat generation"),
    stateRoot: exactRoot(
      input.observation?.stateRoot || input.after?.stateRoot,
      "heartbeat initial stateRoot",
    ),
    heartbeatAt: timestamp(
      warrant.heartbeatAt || warrant.issuedAt,
      "heartbeat initial heartbeatAt",
    ),
    expiresAt: timestamp(warrant.expiresAt, "heartbeat initial expiresAt"),
  };
}

function job(entries, name, options) {
  const entry = devDeliveryProviderJobByName(entries, name, options);
  if (!entry) return null;
  const providerJob = {
    id: positiveInteger(entry.id, `${name} job id`),
    name,
    status: text(entry.status),
    conclusion: entry.conclusion === null ? null : text(entry.conclusion),
    runnerName: text(entry.runner_name),
    runnerGroupName: text(entry.runner_group_name),
    labels: [...new Set((entry.labels || []).map(text).filter(Boolean))].sort(),
    startedAt: entry.started_at
      ? timestamp(entry.started_at, `${name} startedAt`)
      : null,
    completedAt: entry.completed_at
      ? timestamp(entry.completed_at, `${name} completedAt`)
      : null,
  };
  if (providerJob.runnerName || providerJob.runnerGroupName) {
    assertDevDeliveryGitHubHostedRunner({
      runnerGroupName: providerJob.runnerGroupName,
      runnerLabels: providerJob.labels,
    });
  }
  return providerJob;
}

function providerJobs(input, expected, { allowMissingSeal = false } = {}) {
  const entries = Array.isArray(input) ? input : input?.jobs;
  if (!Array.isArray(entries)) {
    throw new Error("provider heartbeat jobs readback must contain jobs");
  }
  const native = job(entries, expected.nativeJobName);
  const seal = job(entries, expected.sealJobName, {
    allowMissing: allowMissingSeal,
  });
  if (!seal) return null;
  if (native.id === seal.id) {
    throw new Error("provider heartbeat native and seal jobs must be distinct");
  }
  return { native, seal };
}

function runnerDomain(providerJob) {
  return JSON.stringify(providerJob.labels);
}

function providerBoundaryJobs(input, expected) {
  const entries = Array.isArray(input) ? input : input?.jobs;
  if (!Array.isArray(entries)) {
    throw new Error("provider heartbeat jobs readback must contain jobs");
  }
  const jobs = {
    admission: job(entries, expected.admissionJobName),
    native: job(entries, expected.nativeJobName),
    seal: job(entries, expected.sealJobName),
    heartbeat: job(entries, expected.heartbeatJobName),
    finalizer: job(entries, expected.finalizerJobName),
  };
  if (new Set(Object.values(jobs).map(({ id }) => id)).size !== 5) {
    throw new Error("provider heartbeat boundary job ids must be distinct");
  }
  if (
    !terminal(jobs.admission) ||
    !terminal(jobs.native) ||
    !terminal(jobs.seal) ||
    !terminal(jobs.heartbeat) ||
    !new Set(["in_progress", "completed"]).has(jobs.finalizer.status) ||
    !jobs.finalizer.startedAt
  ) {
    throw new Error("provider heartbeat boundary jobs are not current");
  }
  const heartbeatDomain = runnerDomain(jobs.heartbeat);
  for (const [role, providerJob] of Object.entries(jobs)) {
    if (role === "heartbeat") continue;
    if (
      providerJob.runnerName === jobs.heartbeat.runnerName ||
      runnerDomain(providerJob) === heartbeatDomain
    ) {
      throw new Error(
        `provider heartbeat runner domain is not independent from ${role}`,
      );
    }
  }
  return jobs;
}

function terminal(jobInput) {
  return (
    jobInput.status === "completed" &&
    Boolean(jobInput.conclusion) &&
    Boolean(jobInput.completedAt)
  );
}

function heartbeatEntry(result, previousStateRoot) {
  const warrant = selectedWarrant(result);
  const receipt = result.receipt;
  if (
    receipt?.action !== "heartbeat" ||
    result.before?.stateRoot !== previousStateRoot ||
    receipt.expectedOldStateRoot !== previousStateRoot ||
    result.after?.stateRoot !== receipt.nextStateRoot ||
    result.observation?.stateRoot !== receipt.nextStateRoot ||
    warrant?.fencingToken !== receipt.fencingToken ||
    warrant?.generation !== receipt.leaseGeneration
  ) {
    throw new Error(
      "durable provider heartbeat transition is not root-continuous",
    );
  }
  if (devDeliveryContentRoot(receipt) !== result.receiptRoot) {
    throw new Error("durable provider heartbeat receipt root drift");
  }
  return {
    expectedOldStateRoot: receipt.expectedOldStateRoot,
    nextStateRoot: receipt.nextStateRoot,
    receipt,
    receiptRoot: result.receiptRoot,
    heartbeatAt: timestamp(warrant.heartbeatAt, "durable heartbeatAt"),
    expiresAt: timestamp(warrant.expiresAt, "durable heartbeat expiresAt"),
  };
}

export async function runDevDeliveryProviderHeartbeat(
  {
    admission,
    workflowRunId,
    workflowRunAttempt,
    nativeJobName = "Credentialless native execution",
    sealJobName = "Credentialless native evidence seal",
    leaseSeconds = 3600,
    heartbeatSeconds = 30,
  } = {},
  {
    heartbeat,
    readJobs,
    onHeartbeatLoss = async () => {},
    wait = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => new Date().toISOString(),
  } = {},
) {
  if (typeof heartbeat !== "function" || typeof readJobs !== "function") {
    throw new Error("provider heartbeat requires heartbeat and jobs adapters");
  }
  const initial = exactWarrant(admission);
  const duration = positiveInteger(leaseSeconds, "heartbeat leaseSeconds");
  const cadence = positiveInteger(
    heartbeatSeconds,
    "heartbeat heartbeatSeconds",
  );
  if (cadence >= duration) {
    throw new Error("provider heartbeat cadence must be less than its lease");
  }
  const startedAt = timestamp(now(), "provider heartbeat startedAt");
  let previousStateRoot = initial.stateRoot;
  const heartbeats = [];
  let jobs;
  try {
    while (true) {
      const result = await heartbeat({
        expectedOldStateRoot: previousStateRoot,
        fencingToken: initial.fencingToken,
        leaseGeneration: initial.generation,
        leaseSeconds: duration,
      });
      const entry = heartbeatEntry(result, previousStateRoot);
      heartbeats.push(entry);
      previousStateRoot = entry.nextStateRoot;
      jobs = providerJobs(
        await readJobs(),
        { nativeJobName, sealJobName },
        { allowMissingSeal: true },
      );
      if (!jobs) {
        await wait(cadence * 1000);
        continue;
      }
      if (terminal(jobs.native) && terminal(jobs.seal)) break;
      await wait(cadence * 1000);
    }
  } catch (error) {
    await onHeartbeatLoss({
      error,
      repository: initial.repository,
      workflowRunId: positiveInteger(
        workflowRunId,
        "heartbeat workflow run id",
      ),
      workflowRunAttempt: positiveInteger(
        workflowRunAttempt,
        "heartbeat workflow run attempt",
      ),
      fencingToken: initial.fencingToken,
      leaseGeneration: initial.generation,
      latestStateRoot: previousStateRoot,
    });
    throw error;
  }
  const completedAt = timestamp(now(), "provider heartbeat completedAt");
  const body = {
    schema: DEV_DELIVERY_PROVIDER_HEARTBEAT_SCHEMA,
    repository: initial.repository,
    protectedBase: initial.protectedBase,
    candidateId: initial.candidateId,
    fencingToken: initial.fencingToken,
    leaseGeneration: initial.generation,
    workflowRunId: positiveInteger(workflowRunId, "heartbeat workflow run id"),
    workflowRunAttempt: positiveInteger(
      workflowRunAttempt,
      "heartbeat workflow run attempt",
    ),
    initialStateRoot: initial.stateRoot,
    latestStateRoot: previousStateRoot,
    initialHeartbeatAt: initial.heartbeatAt,
    latestHeartbeatAt: heartbeats.at(-1).heartbeatAt,
    latestExpiresAt: heartbeats.at(-1).expiresAt,
    leaseSeconds: duration,
    heartbeatSeconds: cadence,
    heartbeatCount: heartbeats.length,
    heartbeats,
    nativeJob: jobs.native,
    sealJob: jobs.seal,
    startedAt,
    completedAt,
  };
  return { ...body, receiptRoot: devDeliveryContentRoot(body) };
}

function verifyHeartbeatContinuity(receipt, initial) {
  let previousRoot = initial.stateRoot;
  let previousTime = Date.parse(receipt.initialHeartbeatAt);
  for (const entry of receipt.heartbeats) {
    if (
      entry.expectedOldStateRoot !== previousRoot ||
      devDeliveryContentRoot(entry.receipt) !== entry.receiptRoot ||
      entry.receipt.expectedOldStateRoot !== entry.expectedOldStateRoot ||
      entry.receipt.nextStateRoot !== entry.nextStateRoot ||
      entry.receipt.fencingToken !== initial.fencingToken ||
      entry.receipt.leaseGeneration !== initial.generation
    ) {
      throw new Error("provider heartbeat root continuity mismatch");
    }
    const beatTime = Date.parse(timestamp(entry.heartbeatAt, "heartbeatAt"));
    if (
      beatTime < previousTime ||
      beatTime - previousTime >= receipt.leaseSeconds * 1000 ||
      Date.parse(entry.expiresAt) <= beatTime
    ) {
      throw new Error("provider heartbeat time continuity is stale");
    }
    previousRoot = entry.nextStateRoot;
    previousTime = beatTime;
  }
  return previousRoot;
}

export function verifyDevDeliveryProviderHeartbeat(
  input,
  {
    admission,
    jobsReadback,
    liveObservation,
    workflowRunId,
    workflowRunAttempt,
    nativeJobName = "Credentialless native execution",
    sealJobName = "Credentialless native evidence seal",
    admissionJobName = "Reserve exact delivery candidate",
    heartbeatJobName = "Credentialed independent Warrant heartbeat",
    finalizerJobName = "Credentialed provider finalizer",
    observedAt = new Date().toISOString(),
  } = {},
) {
  const receipt = structuredClone(input || {});
  const receiptRoot = exactRoot(receipt.receiptRoot, "heartbeat receiptRoot");
  delete receipt.receiptRoot;
  if (
    receipt.schema !== DEV_DELIVERY_PROVIDER_HEARTBEAT_SCHEMA ||
    devDeliveryContentRoot(receipt) !== receiptRoot
  ) {
    throw new Error("provider heartbeat receipt root drift");
  }
  const initial = exactWarrant(admission);
  for (const [actual, expected, label] of [
    [receipt.repository, initial.repository, "repository"],
    [receipt.protectedBase, initial.protectedBase, "protected base"],
    [receipt.candidateId, initial.candidateId, "candidate"],
    [receipt.fencingToken, initial.fencingToken, "fence"],
    [receipt.leaseGeneration, initial.generation, "generation"],
    [receipt.initialStateRoot, initial.stateRoot, "initial state root"],
    [receipt.workflowRunId, Number(workflowRunId), "workflow run"],
    [receipt.workflowRunAttempt, Number(workflowRunAttempt), "run attempt"],
  ]) {
    if (actual !== expected) {
      throw new Error(`provider heartbeat ${label} mismatch`);
    }
  }
  if (
    !Array.isArray(receipt.heartbeats) ||
    receipt.heartbeats.length !== receipt.heartbeatCount ||
    receipt.heartbeats.length < 1
  ) {
    throw new Error("provider heartbeat continuity is missing");
  }
  const previousRoot = verifyHeartbeatContinuity(receipt, initial);
  if (
    previousRoot !== receipt.latestStateRoot ||
    liveObservation?.stateRoot !== receipt.latestStateRoot ||
    liveObservation?.activeWarrant?.fencingToken !== initial.fencingToken ||
    liveObservation?.activeWarrant?.generation !== initial.generation ||
    Date.parse(receipt.latestExpiresAt) <= Date.parse(observedAt)
  ) {
    throw new Error(
      "provider heartbeat latest durable state mismatch or stale",
    );
  }
  const jobs = providerJobs(jobsReadback, { nativeJobName, sealJobName });
  if (
    !terminal(jobs.native) ||
    !terminal(jobs.seal) ||
    JSON.stringify(jobs) !==
      JSON.stringify({ native: receipt.nativeJob, seal: receipt.sealJob })
  ) {
    throw new Error("provider heartbeat terminal jobs readback mismatch");
  }
  const boundaryJobs = providerBoundaryJobs(jobsReadback, {
    admissionJobName,
    nativeJobName,
    sealJobName,
    heartbeatJobName,
    finalizerJobName,
  });
  return {
    ok: true,
    receiptRoot,
    latestStateRoot: receipt.latestStateRoot,
    boundaryJobs,
  };
}

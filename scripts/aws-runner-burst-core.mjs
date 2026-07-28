import crypto from "node:crypto";

export const AWS_RUNNER_BURST_CONTRACT =
  "kungfu-buildchain-aws-runner-burst/v1";

export const LINUX_CODEBUILD_POC = Object.freeze({
  phase: "linux-codebuild-poc-under-usd-50",
  region: "us-east-1",
  project: "kungfu-buildchain-linux-burst-poc",
  computeType: "BUILD_GENERAL1_LARGE",
  pricePerMinuteUsd: 0.02,
  timeoutMinutes: 120,
  maxConcurrentBuilds: 2,
  maxAcceptedBuilds: 17,
  budgetLimitUsd: 49,
  minimumAcceptedJobs: 10,
  minimumObservedConcurrency: 2,
  maximumP95QueueStartSeconds: 300,
});

function exactSha(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be an exact 40-character Git SHA`);
  }
  return normalized;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return parsed;
}

function percentile(values, quantile) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(ordered.length - 1, Math.ceil(quantile * ordered.length) - 1),
  );
  return ordered[index];
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function linuxCodeBuildPlan(overrides = {}) {
  const config = { ...LINUX_CODEBUILD_POC, ...overrides };
  const money = (value) => Math.round(value * 100) / 100;
  const maximumCommittedComputeUsd = money(
    config.pricePerMinuteUsd *
      config.timeoutMinutes *
      config.maxAcceptedBuilds,
  );
  const maximumRaceStopUsd = money(
    config.pricePerMinuteUsd *
      config.timeoutMinutes *
      config.maxConcurrentBuilds,
  );
  const maximumBoundedSpendUsd = money(
    maximumCommittedComputeUsd + maximumRaceStopUsd,
  );
  if (maximumBoundedSpendUsd >= config.budgetLimitUsd) {
    throw new Error(
      `bounded CodeBuild spend ${maximumBoundedSpendUsd.toFixed(2)} must remain below budget ${config.budgetLimitUsd.toFixed(2)}`,
    );
  }
  const plan = {
    schemaVersion: 1,
    contract: AWS_RUNNER_BURST_CONTRACT,
    kind: "phase-plan",
    config,
    costEnvelope: {
      currency: "USD",
      maximumCommittedComputeUsd,
      maximumRaceStopUsd,
      maximumBoundedSpendUsd,
      assumption:
        "At most maxConcurrentBuilds over-cap builds can race; the envelope charges both for their full timeout.",
    },
    invariants: {
      trustedExactSourceOnly: true,
      forkPullRequestsRejectedBeforeCloudRunnerSelection: true,
      ephemeralSingleJobCompute: true,
      signingAndPublicationCredentialsForbidden: true,
      staticAwsCredentialsForbidden: true,
      githubLongLivedCredentialsForbidden: true,
      staleOrMissingCostTelemetryFailsClosed: true,
      zeroIdleCompute: true,
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function createRunnerEvidence({
  provider,
  project,
  repository,
  sourceSha,
  sourceRef,
  runId,
  runAttempt,
  job,
  codeBuildBuildId,
  codeBuildBuildArn,
  codeBuildInitiator,
  observedAt = new Date().toISOString(),
} = {}) {
  if (provider !== "aws-codebuild") {
    throw new Error("runner evidence provider must be aws-codebuild");
  }
  if (project !== LINUX_CODEBUILD_POC.project) {
    throw new Error(`runner evidence project must be ${LINUX_CODEBUILD_POC.project}`);
  }
  if (!String(repository || "").includes("/")) {
    throw new Error("runner evidence repository must be owner/name");
  }
  const evidence = {
    schemaVersion: 1,
    contract: AWS_RUNNER_BURST_CONTRACT,
    kind: "runner-evidence",
    phase: LINUX_CODEBUILD_POC.phase,
    provider,
    project,
    repository,
    source: {
      sha: exactSha(sourceSha, "sourceSha"),
      ref: String(sourceRef || "").trim(),
    },
    github: {
      runId: String(runId || "").trim(),
      runAttempt: String(runAttempt || "").trim(),
      job: String(job || "").trim(),
    },
    aws: {
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "",
      buildId: String(codeBuildBuildId || "").trim(),
      buildArn: String(codeBuildBuildArn || "").trim(),
      initiator: String(codeBuildInitiator || "").trim(),
    },
    observedAt: new Date(observedAt).toISOString(),
  };
  for (const [label, value] of Object.entries({
    runId: evidence.github.runId,
    runAttempt: evidence.github.runAttempt,
    job: evidence.github.job,
    buildId: evidence.aws.buildId,
    buildArn: evidence.aws.buildArn,
  })) {
    if (!value) throw new Error(`runner evidence ${label} is required`);
  }
  return { ...evidence, digest: digest(evidence) };
}

export function verifyLinuxCodeBuildQualification({
  jobs = [],
  actualIncrementalSpendUsd,
  idleBuilds = [],
  activeCloudResources = [],
  telemetryObservedAt,
  observedAt = new Date().toISOString(),
} = {}) {
  const plan = linuxCodeBuildPlan();
  const issues = [];
  const now = new Date(observedAt).getTime();
  const telemetryTime = new Date(telemetryObservedAt || "").getTime();
  if (
    !Number.isFinite(telemetryTime) ||
    telemetryTime > now ||
    now - telemetryTime > 6 * 60 * 60 * 1000
  ) {
    issues.push("cost-telemetry-missing-or-stale");
  }
  const spend = finiteNumber(
    actualIncrementalSpendUsd,
    "actualIncrementalSpendUsd",
  );
  if (spend >= plan.config.budgetLimitUsd) {
    issues.push("actual-spend-not-below-budget");
  }
  const accepted = jobs.filter(
    (job) =>
      job?.trusted === true &&
      job?.exactSource === true &&
      job?.status === "succeeded",
  );
  if (accepted.length < plan.config.minimumAcceptedJobs) {
    issues.push("insufficient-trusted-exact-source-jobs");
  }
  const queueSeconds = accepted.map((job) =>
    finiteNumber(job.queueStartSeconds, "job.queueStartSeconds"),
  );
  const p95QueueStartSeconds = percentile(queueSeconds, 0.95);
  if (p95QueueStartSeconds > plan.config.maximumP95QueueStartSeconds) {
    issues.push("queue-start-p95-exceeds-five-minutes");
  }
  const peakConcurrency = jobs.reduce(
    (peak, job) => Math.max(peak, Number(job?.observedConcurrency || 0)),
    0,
  );
  if (peakConcurrency < plan.config.minimumObservedConcurrency) {
    issues.push("concurrency-two-not-observed");
  }
  if (idleBuilds.length > 0) issues.push("idle-builds-remain");
  if (activeCloudResources.length > 0) {
    issues.push("active-cloud-resources-remain");
  }
  const result = {
    schemaVersion: 1,
    contract: AWS_RUNNER_BURST_CONTRACT,
    kind: "phase-verification",
    phase: plan.config.phase,
    status: issues.length === 0 ? "passed" : "failed",
    qualifying: issues.length === 0,
    metrics: {
      acceptedJobs: accepted.length,
      peakConcurrency,
      p95QueueStartSeconds,
      actualIncrementalSpendUsd: spend,
      idleBuilds: idleBuilds.length,
      activeCloudResources: activeCloudResources.length,
    },
    issues,
    planDigest: plan.digest,
    observedAt: new Date(observedAt).toISOString(),
  };
  return { ...result, digest: digest(result) };
}

import { digest } from "./aws-runner-burst-core.mjs";

export const AWS_WINDOWS_JIT_CONTRACT =
  "kungfu-buildchain-aws-windows-jit/v1";

export const WINDOWS_EC2_JIT = Object.freeze({
  phase: "windows-ec2-jit",
  region: "us-east-1",
  repository: "kungfu-systems/kungfu",
  stack: "kungfu-buildchain-windows-jit",
  instanceType: "c7i.4xlarge",
  pricePerHourUsd: 1.45,
  maximumInstanceLifetimeMinutes: 180,
  maxConcurrentInstances: 2,
  maxAcceptedInstances: 6,
  budgetLimitUsd: 40,
  minimumSmokeJobs: 1,
  minimumFullJobs: 3,
  maximumCleanupLatencySeconds: 900,
  runnerVersion: "2.336.0",
  runnerArchive:
    "actions-runner-win-x64-2.336.0.zip",
  runnerArchiveSha256:
    "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162",
  amiSsmParameter:
    "/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base",
  labelPrefix: "aws-us-ec2-windows-jit-",
  jitParameterPrefix: "/kungfu/burst/windows/",
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

function iso(value, label) {
  const parsed = new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return parsed.toISOString();
}

export function windowsJitRunnerLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  const pattern = new RegExp(
    `^${WINDOWS_EC2_JIT.labelPrefix}[a-z0-9][a-z0-9-]{0,31}$`,
  );
  if (!pattern.test(label)) {
    throw new Error(
      `runner label must match ${WINDOWS_EC2_JIT.labelPrefix}<bounded-id>`,
    );
  }
  return label;
}

export function renderWindowsJitBootstrap(template, values = {}) {
  const runnerLabel = windowsJitRunnerLabel(values.runnerLabel);
  const jitParameterName = String(values.jitParameterName || "").trim();
  if (
    !jitParameterName.startsWith(WINDOWS_EC2_JIT.jitParameterPrefix) ||
    !/^\/[A-Za-z0-9._/-]+$/.test(jitParameterName)
  ) {
    throw new Error("jitParameterName must use the dedicated Windows prefix");
  }
  const bounded = {
    REGION: String(values.region || WINDOWS_EC2_JIT.region),
    JIT_PARAMETER_NAME: jitParameterName,
    EVIDENCE_BUCKET: String(values.evidenceBucket || ""),
    RUNNER_LABEL: runnerLabel,
    SOURCE_SHA: exactSha(values.sourceSha, "sourceSha"),
    GITHUB_RUN_ID: String(values.githubRunId || ""),
    GITHUB_RUN_ATTEMPT: String(values.githubRunAttempt || ""),
    AMI_ID: String(values.amiId || ""),
    AMI_NAME: String(values.amiName || ""),
    INSTANCE_TYPE: String(
      values.instanceType || WINDOWS_EC2_JIT.instanceType,
    ),
    LAUNCHED_AT: iso(values.launchedAt, "launchedAt"),
  };
  const patterns = {
    REGION: /^us-[a-z]+-\d$/,
    EVIDENCE_BUCKET: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    GITHUB_RUN_ID: /^\d+$/,
    GITHUB_RUN_ATTEMPT: /^\d+$/,
    AMI_ID: /^ami-[0-9a-f]+$/,
    AMI_NAME: /^[A-Za-z0-9._-]+$/,
    INSTANCE_TYPE: /^[a-z0-9.]+$/,
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    if (!pattern.test(bounded[name])) {
      throw new Error(`${name.toLowerCase()} is invalid`);
    }
  }
  let rendered = String(template || "");
  for (const [name, value] of Object.entries(bounded)) {
    rendered = rendered.replaceAll(`__${name}__`, value);
  }
  const unresolved = rendered.match(/__[A-Z0-9_]+__/g) || [];
  if (unresolved.length) {
    throw new Error(`bootstrap has unresolved variables: ${unresolved.join(",")}`);
  }
  if (/encoded_jit_config|github_pat_|ghp_|gho_/.test(rendered)) {
    throw new Error("bootstrap must not contain a GitHub credential");
  }
  return rendered;
}

export function windowsEc2JitPlan(overrides = {}) {
  const config = { ...WINDOWS_EC2_JIT, ...overrides };
  const money = (value) => Math.round(value * 100) / 100;
  const perInstanceMaximumUsd = money(
    (config.pricePerHourUsd * config.maximumInstanceLifetimeMinutes) / 60,
  );
  const maximumCommittedComputeUsd = money(
    perInstanceMaximumUsd * config.maxAcceptedInstances,
  );
  const maximumRaceStopUsd = money(
    perInstanceMaximumUsd * config.maxConcurrentInstances,
  );
  const maximumBoundedSpendUsd = money(
    maximumCommittedComputeUsd + maximumRaceStopUsd,
  );
  if (maximumBoundedSpendUsd >= config.budgetLimitUsd) {
    throw new Error(
      `bounded Windows EC2 spend ${maximumBoundedSpendUsd.toFixed(2)} must remain below budget ${config.budgetLimitUsd.toFixed(2)}`,
    );
  }
  const plan = {
    schemaVersion: 1,
    contract: AWS_WINDOWS_JIT_CONTRACT,
    kind: "phase-plan",
    config,
    costEnvelope: {
      currency: "USD",
      perInstanceMaximumUsd,
      maximumCommittedComputeUsd,
      maximumRaceStopUsd,
      maximumBoundedSpendUsd,
      assumption:
        "The reaper charges every accepted and race instance for the full three-hour fail-closed lifetime.",
    },
    invariants: {
      repositoryScopedJit: true,
      oneJobPerRunner: true,
      noInboundSecurityGroupRules: true,
      imdsv2Required: true,
      encryptedDeleteOnTerminationRoot: true,
      jitConfigurationDeletedAfterRead: true,
      staticAwsCredentialsForbidden: true,
      signingAndPublicationCredentialsForbidden: true,
      zeroWarmCapacity: true,
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function createWindowsJitEvidence({
  repository,
  sourceSha,
  sourceRef,
  githubRunId,
  githubRunAttempt,
  githubJob,
  runnerName,
  runnerLabels = [],
  instanceId,
  instanceType,
  amiId,
  amiName,
  availabilityZone,
  launchedAt,
  runnerStartedAt,
  runnerExitedAt,
  terminatedAt,
  cleanupResult,
  cacheMode = "off",
  observedAt = new Date().toISOString(),
} = {}) {
  if (repository !== WINDOWS_EC2_JIT.repository) {
    throw new Error(`repository must be ${WINDOWS_EC2_JIT.repository}`);
  }
  if (instanceType !== WINDOWS_EC2_JIT.instanceType) {
    throw new Error(`instanceType must be ${WINDOWS_EC2_JIT.instanceType}`);
  }
  if (!/^i-[0-9a-f]+$/.test(String(instanceId || ""))) {
    throw new Error("instanceId must be an EC2 instance id");
  }
  if (!/^ami-[0-9a-f]+$/.test(String(amiId || ""))) {
    throw new Error("amiId must be an EC2 AMI id");
  }
  const labels = [...new Set(runnerLabels.map((label) => String(label).trim()))]
    .filter(Boolean)
    .sort();
  const customLabel = labels.find((label) =>
    label.startsWith(WINDOWS_EC2_JIT.labelPrefix),
  );
  windowsJitRunnerLabel(customLabel);
  for (const required of ["self-hosted", "Windows", "X64"]) {
    if (!labels.includes(required)) {
      throw new Error(`runnerLabels must include ${required}`);
    }
  }
  const evidence = {
    schemaVersion: 1,
    contract: AWS_WINDOWS_JIT_CONTRACT,
    kind: "runner-evidence",
    phase: WINDOWS_EC2_JIT.phase,
    provider: "aws-ec2",
    repository,
    source: {
      sha: exactSha(sourceSha, "sourceSha"),
      ref: String(sourceRef || "").trim(),
    },
    github: {
      runId: String(githubRunId || "").trim(),
      runAttempt: String(githubRunAttempt || "").trim(),
      job: String(githubJob || "").trim(),
    },
    runner: {
      name: String(runnerName || "").trim(),
      labels,
      version: WINDOWS_EC2_JIT.runnerVersion,
      archiveSha256: WINDOWS_EC2_JIT.runnerArchiveSha256,
      cacheMode: String(cacheMode || "off"),
    },
    aws: {
      region: WINDOWS_EC2_JIT.region,
      instanceId: String(instanceId),
      instanceType,
      amiId: String(amiId),
      amiName: String(amiName || "").trim(),
      availabilityZone: String(availabilityZone || "").trim(),
    },
    lifecycle: {
      launchedAt: iso(launchedAt, "launchedAt"),
      runnerStartedAt: iso(runnerStartedAt, "runnerStartedAt"),
      runnerExitedAt: iso(runnerExitedAt, "runnerExitedAt"),
      terminatedAt: terminatedAt ? iso(terminatedAt, "terminatedAt") : null,
      cleanupResult: String(
        cleanupResult || "runner-exit-termination-pending",
      ).trim(),
    },
    observedAt: iso(observedAt, "observedAt"),
  };
  for (const [label, value] of Object.entries({
    sourceRef: evidence.source.ref,
    runId: evidence.github.runId,
    runAttempt: evidence.github.runAttempt,
    job: evidence.github.job,
    runnerName: evidence.runner.name,
    amiName: evidence.aws.amiName,
    availabilityZone: evidence.aws.availabilityZone,
    cleanupResult: evidence.lifecycle.cleanupResult,
  })) {
    if (!value) throw new Error(`${label} is required`);
  }
  return { ...evidence, digest: digest(evidence) };
}

export function verifyWindowsEc2JitQualification({
  jobs = [],
  cancellationCleanup = {},
  timeoutCleanup = {},
  registeredCloudRunners = [],
  activeInstances = [],
  disposableVolumes = [],
  minCapacity = 0,
  desiredCapacity = 0,
  actualIncrementalSpendUsd,
  observedAt = new Date().toISOString(),
} = {}) {
  const plan = windowsEc2JitPlan();
  const issues = [];
  const accepted = jobs.filter(
    (job) =>
      job?.trusted === true &&
      job?.exactSource === true &&
      job?.status === "succeeded" &&
      job?.oneJobJit === true,
  );
  const smokeJobs = accepted.filter((job) => job.kind === "smoke");
  const fullJobs = accepted.filter((job) => job.kind === "full");
  if (smokeJobs.length < plan.config.minimumSmokeJobs) {
    issues.push("runner-profile-smoke-missing");
  }
  if (fullJobs.length < plan.config.minimumFullJobs) {
    issues.push("insufficient-trusted-full-windows-jobs");
  }
  for (const [kind, cleanup] of Object.entries({
    cancellation: cancellationCleanup,
    timeout: timeoutCleanup,
  })) {
    const latency = finiteNumber(
      cleanup?.cleanupLatencySeconds,
      `${kind}Cleanup.cleanupLatencySeconds`,
    );
    if (
      cleanup?.status !== "passed" ||
      cleanup?.instanceTerminated !== true ||
      cleanup?.runnerRemoved !== true ||
      latency > plan.config.maximumCleanupLatencySeconds
    ) {
      issues.push(`${kind}-cleanup-not-proven`);
    }
  }
  const spend = finiteNumber(
    actualIncrementalSpendUsd,
    "actualIncrementalSpendUsd",
  );
  if (spend >= plan.config.budgetLimitUsd) {
    issues.push("actual-spend-not-below-budget");
  }
  if (Number(minCapacity) !== 0 || Number(desiredCapacity) !== 0) {
    issues.push("provider-capacity-not-zero");
  }
  if (registeredCloudRunners.length) issues.push("registered-runners-remain");
  if (activeInstances.length) issues.push("active-instances-remain");
  if (disposableVolumes.length) issues.push("disposable-volumes-remain");
  const result = {
    schemaVersion: 1,
    contract: AWS_WINDOWS_JIT_CONTRACT,
    kind: "phase-verification",
    phase: plan.config.phase,
    status: issues.length ? "failed" : "passed",
    qualifying: issues.length === 0,
    metrics: {
      acceptedJobs: accepted.length,
      smokeJobs: smokeJobs.length,
      fullJobs: fullJobs.length,
      actualIncrementalSpendUsd: spend,
      registeredCloudRunners: registeredCloudRunners.length,
      activeInstances: activeInstances.length,
      disposableVolumes: disposableVolumes.length,
      minCapacity: Number(minCapacity),
      desiredCapacity: Number(desiredCapacity),
    },
    cleanup: {
      cancellation: cancellationCleanup,
      timeout: timeoutCleanup,
    },
    issues,
    planDigest: plan.digest,
    observedAt: iso(observedAt, "observedAt"),
  };
  return { ...result, digest: digest(result) };
}

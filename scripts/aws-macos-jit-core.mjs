import { digest } from "./aws-runner-burst-core.mjs";

export const AWS_MACOS_JIT_CONTRACT = "kungfu-buildchain-aws-macos-jit/v1";

export const MACOS_EC2_JIT = Object.freeze({
  phase: "macos-ec2-jit",
  region: "us-east-1",
  repository: "kungfu-systems/kungfu",
  workflowId: "323846928",
  stack: "kungfu-buildchain-macos-jit",
  budgetName: "kungfu-buildchain-macos-jit-actual-spend",
  budgetUsageType: "HostUsage:mac2",
  budgetOperation: "RunInstances",
  instanceType: "mac2.metal",
  pricePerHourUsd: 0.65,
  minimumHostAllocationHours: 24,
  maximumHostAllocationHours: 30,
  maxAcceptedHosts: 1,
  budgetLimitUsd: 25,
  minimumJobs: 3,
  minimumFullJobs: 1,
  runnerVersion: "2.336.0",
  runnerArchive: "actions-runner-osx-arm64-2.336.0.tar.gz",
  runnerArchiveSha256:
    "8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079",
  labelPrefix: "aws-us-ec2-macos-jit-",
  jitParameterPrefix: "/kungfu/burst/macos/",
});

function exactSha(value, label) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
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

function elapsedHours(start, end) {
  return (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
}

export function macosJitRunnerLabel(value) {
  const label = String(value || "")
    .trim()
    .toLowerCase();
  const pattern = new RegExp(
    `^${MACOS_EC2_JIT.labelPrefix}[a-z0-9][a-z0-9-]{0,31}$`,
  );
  if (!pattern.test(label)) {
    throw new Error(
      `runner label must match ${MACOS_EC2_JIT.labelPrefix}<bounded-id>`,
    );
  }
  return label;
}

export function macosJitRunnerLabels(value) {
  return ["self-hosted", "macOS", "ARM64", macosJitRunnerLabel(value)];
}

export function renderMacosJitBootstrap(template, values = {}) {
  const runnerLabel = macosJitRunnerLabel(values.runnerLabel);
  const jitParameterName = String(values.jitParameterName || "").trim();
  if (
    !jitParameterName.startsWith(MACOS_EC2_JIT.jitParameterPrefix) ||
    !/^\/[A-Za-z0-9._/-]+$/.test(jitParameterName)
  ) {
    throw new Error("jitParameterName must use the dedicated macOS prefix");
  }
  const bounded = {
    REGION: String(values.region || MACOS_EC2_JIT.region),
    JIT_PARAMETER_NAME: jitParameterName,
    EVIDENCE_BUCKET: String(values.evidenceBucket || ""),
    RUNNER_LABEL: runnerLabel,
    SOURCE_SHA: exactSha(values.sourceSha, "sourceSha"),
    GITHUB_RUN_ID: String(values.githubRunId || ""),
    GITHUB_RUN_ATTEMPT: String(values.githubRunAttempt || ""),
    AMI_ID: String(values.amiId || ""),
    AMI_NAME: String(values.amiName || ""),
    HOST_ID: String(values.hostId || ""),
    INSTANCE_TYPE: String(values.instanceType || MACOS_EC2_JIT.instanceType),
    HOST_ALLOCATED_AT: iso(values.hostAllocatedAt, "hostAllocatedAt"),
  };
  const patterns = {
    REGION: /^us-[a-z]+-\d$/,
    EVIDENCE_BUCKET: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    GITHUB_RUN_ID: /^\d+$/,
    GITHUB_RUN_ATTEMPT: /^\d+$/,
    AMI_ID: /^ami-[0-9a-f]+$/,
    AMI_NAME: /^[A-Za-z0-9._-]+$/,
    HOST_ID: /^h-[0-9a-f]+$/,
    INSTANCE_TYPE: /^mac2\.metal$/,
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
    throw new Error(
      `bootstrap has unresolved variables: ${unresolved.join(",")}`,
    );
  }
  if (/encoded_jit_config|github_pat_|ghp_|gho_/.test(rendered)) {
    throw new Error("bootstrap must not contain a GitHub credential");
  }
  return rendered;
}

export function macosEc2JitPlan(overrides = {}) {
  const config = { ...MACOS_EC2_JIT, ...overrides };
  const money = (value) => Math.round(value * 100) / 100;
  const minimumCommittedComputeUsd = money(
    config.pricePerHourUsd *
      config.minimumHostAllocationHours *
      config.maxAcceptedHosts,
  );
  const maximumBoundedSpendUsd = money(
    config.pricePerHourUsd *
      config.maximumHostAllocationHours *
      config.maxAcceptedHosts,
  );
  if (maximumBoundedSpendUsd >= config.budgetLimitUsd) {
    throw new Error(
      `bounded macOS EC2 spend ${maximumBoundedSpendUsd.toFixed(2)} must remain below budget ${config.budgetLimitUsd.toFixed(2)}`,
    );
  }
  const plan = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTRACT,
    kind: "phase-plan",
    config,
    costEnvelope: {
      currency: "USD",
      minimumCommittedComputeUsd,
      maximumBoundedSpendUsd,
      assumption:
        "One mac2.metal Dedicated Host is retained for at least 24 hours and released no later than the 30-hour fail-closed ceiling.",
    },
    invariants: {
      repositoryScopedJit: true,
      oneJobPerRunner: true,
      oneHostPerCampaign: true,
      oneInstancePerCampaign: true,
      minimumJobsOnHost: config.minimumJobs,
      minimumFullJobsOnHost: config.minimumFullJobs,
      minimumHostAllocationHours: config.minimumHostAllocationHours,
      noInboundSecurityGroupRules: true,
      imdsv2Required: true,
      encryptedDeleteOnTerminationRoot: true,
      jitConfigurationDeletedAfterRead: true,
      jitConfigurationLabels: [
        "self-hosted",
        "macOS",
        "ARM64",
        `${config.labelPrefix}<bounded-id>`,
      ],
      staticAwsCredentialsForbidden: true,
      signingAndPublicationCredentialsForbidden: true,
      zeroWarmCapacityBeforeAndAfterCampaign: true,
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function createMacosJitEvidence({
  repository,
  sourceSha,
  sourceRef,
  githubRunId,
  githubRunAttempt,
  githubJob,
  runnerName,
  runnerLabels = [],
  hostId,
  instanceId,
  instanceType,
  amiId,
  amiName,
  availabilityZone,
  hostAllocatedAt,
  instanceLaunchedAt,
  runnerStartedAt,
  runnerExitedAt,
  cacheMode = "off",
  observedAt = new Date().toISOString(),
} = {}) {
  if (repository !== MACOS_EC2_JIT.repository) {
    throw new Error(`repository must be ${MACOS_EC2_JIT.repository}`);
  }
  if (instanceType !== MACOS_EC2_JIT.instanceType) {
    throw new Error(`instanceType must be ${MACOS_EC2_JIT.instanceType}`);
  }
  if (!/^h-[0-9a-f]+$/.test(String(hostId || ""))) {
    throw new Error("hostId must be an EC2 Dedicated Host id");
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
    label.startsWith(MACOS_EC2_JIT.labelPrefix),
  );
  macosJitRunnerLabel(customLabel);
  for (const required of ["self-hosted", "macOS", "ARM64"]) {
    if (!labels.includes(required)) {
      throw new Error(`runnerLabels must include ${required}`);
    }
  }
  const evidence = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTRACT,
    kind: "runner-evidence",
    phase: MACOS_EC2_JIT.phase,
    provider: "aws-ec2-macos-jit",
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
      version: MACOS_EC2_JIT.runnerVersion,
      archiveSha256: MACOS_EC2_JIT.runnerArchiveSha256,
      cacheMode: String(cacheMode || "off"),
    },
    aws: {
      region: MACOS_EC2_JIT.region,
      hostId: String(hostId),
      instanceId: String(instanceId),
      instanceType,
      amiId: String(amiId),
      amiName: String(amiName || "").trim(),
      availabilityZone: String(availabilityZone || "").trim(),
    },
    lifecycle: {
      hostAllocatedAt: iso(hostAllocatedAt, "hostAllocatedAt"),
      instanceLaunchedAt: iso(instanceLaunchedAt, "instanceLaunchedAt"),
      runnerStartedAt: iso(runnerStartedAt, "runnerStartedAt"),
      runnerExitedAt: iso(runnerExitedAt, "runnerExitedAt"),
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
  })) {
    if (!value) throw new Error(`${label} is required`);
  }
  return { ...evidence, digest: digest(evidence) };
}

export function verifyMacosEc2JitQualification({
  jobs = [],
  hostLifecycle = {},
  registeredCloudRunners = [],
  activeInstances = [],
  allocatedHosts = [],
  disposableVolumes = [],
  actualIncrementalSpendUsd,
  observedAt = new Date().toISOString(),
} = {}) {
  const plan = macosEc2JitPlan();
  const issues = [];
  const accepted = jobs.filter(
    (job) =>
      job?.trusted === true &&
      job?.exactSource === true &&
      job?.status === "succeeded" &&
      job?.oneJobJit === true,
  );
  const fullJobs = accepted.filter((job) => job.kind === "full");
  if (accepted.length < plan.config.minimumJobs) {
    issues.push("insufficient-trusted-macos-jobs");
  }
  if (fullJobs.length < plan.config.minimumFullJobs) {
    issues.push("trusted-full-macos-job-missing");
  }
  const hostIds = new Set(accepted.map((job) => String(job.hostId || "")));
  const instanceIds = new Set(
    accepted.map((job) => String(job.instanceId || "")),
  );
  if (hostIds.size !== 1 || hostIds.has("")) {
    issues.push("jobs-not-bound-to-one-dedicated-host");
  }
  if (instanceIds.size !== 1 || instanceIds.has("")) {
    issues.push("jobs-not-bound-to-one-campaign-instance");
  }
  let allocationHours = 0;
  try {
    const allocatedAt = iso(
      hostLifecycle.allocatedAt,
      "hostLifecycle.allocatedAt",
    );
    const releasedAt = iso(
      hostLifecycle.releasedAt,
      "hostLifecycle.releasedAt",
    );
    allocationHours = elapsedHours(allocatedAt, releasedAt);
    if (
      hostLifecycle.status !== "passed" ||
      hostLifecycle.instanceTerminated !== true ||
      hostLifecycle.scrubCompleted !== true ||
      hostLifecycle.hostReleased !== true ||
      allocationHours < plan.config.minimumHostAllocationHours ||
      allocationHours > plan.config.maximumHostAllocationHours
    ) {
      issues.push("dedicated-host-lifecycle-not-proven");
    }
  } catch {
    issues.push("dedicated-host-lifecycle-not-proven");
  }
  const spend = finiteNumber(
    actualIncrementalSpendUsd,
    "actualIncrementalSpendUsd",
  );
  if (spend >= plan.config.budgetLimitUsd) {
    issues.push("actual-spend-not-below-budget");
  }
  if (registeredCloudRunners.length) issues.push("registered-runners-remain");
  if (activeInstances.length) issues.push("active-instances-remain");
  if (allocatedHosts.length) issues.push("allocated-hosts-remain");
  if (disposableVolumes.length) issues.push("disposable-volumes-remain");
  const result = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTRACT,
    kind: "phase-verification",
    phase: plan.config.phase,
    status: issues.length ? "failed" : "passed",
    qualifying: issues.length === 0,
    metrics: {
      acceptedJobs: accepted.length,
      fullJobs: fullJobs.length,
      distinctHosts: hostIds.size,
      distinctInstances: instanceIds.size,
      hostAllocationHours: Math.round(allocationHours * 1000) / 1000,
      actualIncrementalSpendUsd: spend,
      registeredCloudRunners: registeredCloudRunners.length,
      activeInstances: activeInstances.length,
      allocatedHosts: allocatedHosts.length,
      disposableVolumes: disposableVolumes.length,
    },
    hostLifecycle,
    issues: [...new Set(issues)],
    planDigest: plan.digest,
    observedAt: iso(observedAt, "observedAt"),
  };
  return { ...result, digest: digest(result) };
}

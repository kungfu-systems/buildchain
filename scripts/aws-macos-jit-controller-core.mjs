// SPDX-License-Identifier: Apache-2.0

import { digest } from "./aws-runner-burst-core.mjs";
import {
  MACOS_EC2_JIT,
  macosJitRegionConfig,
  macosJitRunnerLabel,
  macosJitRunnerLabels,
} from "./aws-macos-jit-core.mjs";

export const AWS_MACOS_JIT_CONTROLLER_CONTRACT =
  "kungfu-buildchain-aws-macos-jit-controller/v1";

function exact(value, pattern, label) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function exactSha(value) {
  return exact(value, /^[0-9a-f]{40}$/i, "sourceSha").toLowerCase();
}

function iso(value, label) {
  const parsed = new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return parsed.toISOString();
}

function tag(key, value) {
  return { Key: key, Value: String(value) };
}

function repository(value) {
  const resolved = exact(
    value || MACOS_EC2_JIT.repository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "repository",
  );
  if (resolved !== MACOS_EC2_JIT.repository) {
    throw new Error(`repository must be ${MACOS_EC2_JIT.repository}`);
  }
  return resolved;
}

function source(values) {
  return {
    sha: exactSha(values.sourceSha),
    ref: exact(
      values.sourceRef,
      /^refs\/heads\/[A-Za-z0-9._/-]+$/,
      "sourceRef",
    ),
  };
}

function previousSource(values) {
  return {
    sha: exactSha(values.previousSourceSha),
    ref: exact(
      values.previousSourceRef || values.sourceRef,
      /^refs\/heads\/[A-Za-z0-9._/-]+$/,
      "previousSourceRef",
    ),
  };
}

function campaignId(value) {
  return exact(value, /^[a-z0-9][a-z0-9-]{2,47}$/, "campaignId");
}

function qualificationId(value) {
  return exact(value, /^mac-(?:smoke-0[12]|full-01)$/, "qualificationId");
}

function commonAws(values) {
  const region = exact(
    values.region || MACOS_EC2_JIT.region,
    /^us-[a-z]+-\d$/,
    "region",
  );
  const regionConfig = macosJitRegionConfig(region);
  const instanceType = exact(
    values.instanceType || MACOS_EC2_JIT.instanceType,
    /^mac2\.metal$/,
    "instanceType",
  );
  if (instanceType !== MACOS_EC2_JIT.instanceType) {
    throw new Error(`instanceType must be ${MACOS_EC2_JIT.instanceType}`);
  }
  const availabilityZone = exact(
    values.availabilityZone,
    /^us-[a-z]+-\d[a-z]$/,
    "availabilityZone",
  );
  if (!availabilityZone.startsWith(region)) {
    throw new Error(`availabilityZone must belong to ${region}`);
  }
  return {
    region,
    availabilityZone,
    controlPlaneStack: regionConfig.stack,
    instanceType,
    amiId: exact(values.amiId, /^ami-[0-9a-f]+$/, "amiId"),
    amiName: exact(values.amiName, /^[A-Za-z0-9._-]+$/, "amiName"),
    subnetId: exact(values.subnetId, /^subnet-[0-9a-f]+$/, "subnetId"),
    securityGroupId: exact(
      values.securityGroupId,
      /^sg-[0-9a-f]+$/,
      "securityGroupId",
    ),
    instanceProfileName: exact(
      values.instanceProfileName,
      /^[A-Za-z0-9+=,.@_-]{1,128}$/,
      "instanceProfileName",
    ),
    evidenceBucket: exact(
      values.evidenceBucket,
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
      "evidenceBucket",
    ),
  };
}

function ownershipTags({ id, sourceSha }) {
  return [
    tag("kungfu:owner", "buildchain"),
    tag("kungfu:plane", "aws-us-elastic-runner-burst"),
    tag("kungfu:provider", "macos-ec2-jit"),
    tag("kungfu:campaign-id", id),
    tag("kungfu:source-sha", sourceSha),
  ];
}

export function createMacosJitCampaignPlan(values = {}) {
  const id = campaignId(values.campaignId);
  const boundSource = source(values);
  const aws = commonAws(values);
  const regionConfig = macosJitRegionConfig(aws.region);
  const tags = ownershipTags({ id, sourceSha: boundSource.sha });
  const createdAt = iso(values.createdAt, "createdAt");
  const plan = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "campaign-launch-plan",
    repository: repository(values.repository),
    account: {
      id: exact(values.accountId, /^\d{12}$/, "accountId"),
    },
    github: {
      workflowId: MACOS_EC2_JIT.workflowId,
      requiredState: "disabled_manually",
    },
    campaign: { id, createdAt },
    source: boundSource,
    aws: {
      ...aws,
      hostTags: tags,
      instanceTags: tags,
      volumeTags: tags,
      hostClientToken: `kungfu-mac-host-${id}`,
      instanceClientToken: `kungfu-mac-instance-${id}`,
      rootVolume: {
        deviceName: "/dev/sda1",
        deleteOnTermination: true,
        encrypted: true,
        volumeSizeGiB: 200,
        volumeType: "gp3",
      },
      metadata: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 1,
        instanceMetadataTags: "disabled",
      },
    },
    safety: {
      applyMode: values.execute === true ? "execute" : "dry-run",
      exactSourceRequired: true,
      activeHostCeiling: MACOS_EC2_JIT.maxAcceptedHosts,
      activeInstanceCeiling: 1,
      awsPermissionSimulationRequiredBeforeAllocation: true,
      awsDryRunRequiredBeforeLaunch: true,
      retainHostOnInstanceLaunchFailure: true,
      minimumHostAllocationHours: MACOS_EC2_JIT.minimumHostAllocationHours,
      maximumHostAllocationHours: MACOS_EC2_JIT.maximumHostAllocationHours,
      cleanupOwner: "scheduled-card-scoped-reaper",
      budget: {
        name: regionConfig.budgetName,
        limitUsd: MACOS_EC2_JIT.budgetLimitUsd,
        metrics: ["UnblendedCost"],
        dimensionFilter: {
          usageTypes: regionConfig.budgetUsageTypes,
          operation: MACOS_EC2_JIT.budgetOperation,
          regions: regionConfig.budgetRegions,
        },
        requiredActualThresholds: [80, 95],
      },
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function createMacosJitSourceRebindPlan(values = {}) {
  const id = campaignId(values.campaignId);
  const boundSource = source(values);
  const priorSource = previousSource(values);
  if (boundSource.sha === priorSource.sha) {
    throw new Error("sourceSha must differ from previousSourceSha");
  }
  if (boundSource.ref !== priorSource.ref) {
    throw new Error("sourceRef must remain unchanged during campaign rebind");
  }
  const aws = commonAws(values);
  const regionConfig = macosJitRegionConfig(aws.region);
  const workflowId = exact(values.workflowId, /^\d+$/, "workflowId");
  if (workflowId !== MACOS_EC2_JIT.workflowId) {
    throw new Error(`workflowId must be ${MACOS_EC2_JIT.workflowId}`);
  }
  const plan = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "campaign-source-rebind-plan",
    repository: repository(values.repository),
    account: {
      id: exact(values.accountId, /^\d{12}$/, "accountId"),
    },
    campaign: { id },
    previousSource: priorSource,
    source: boundSource,
    github: {
      workflowId,
      requiredState: "disabled_manually",
    },
    aws: {
      ...aws,
      hostId: exact(values.hostId, /^h-[0-9a-f]+$/, "hostId"),
      instanceId: exact(values.instanceId, /^i-[0-9a-f]+$/, "instanceId"),
    },
    safety: {
      applyMode: values.execute === true ? "execute" : "dry-run",
      noAllocation: true,
      noDispatch: true,
      forwardOnlySource: true,
      sameSourceRefRequired: true,
      workflowDisabledRequired: true,
      zeroPriorJobsRequired: true,
      zeroPriorArtifactsRequired: true,
      zeroJitResidueRequired: true,
      zeroEvidenceRequired: true,
      exactCampaignResourcesRequired: true,
      compensatedRollbackRequired: true,
      budget: {
        name: regionConfig.budgetName,
        limitUsd: MACOS_EC2_JIT.budgetLimitUsd,
        metrics: ["UnblendedCost"],
        dimensionFilter: {
          usageTypes: regionConfig.budgetUsageTypes,
          operation: MACOS_EC2_JIT.budgetOperation,
          regions: regionConfig.budgetRegions,
        },
        requiredActualThresholds: [80, 95],
      },
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function macosAllocateHostsArgs(plan) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "campaign-launch-plan"
  ) {
    throw new Error("macOS JIT campaign launch plan contract is invalid");
  }
  const args = [
    "ec2",
    "allocate-hosts",
    "--availability-zone",
    plan.aws.availabilityZone,
    "--instance-type",
    plan.aws.instanceType,
    "--quantity",
    "1",
    "--auto-placement",
    "off",
    "--client-token",
    plan.aws.hostClientToken,
    "--tag-specifications",
    JSON.stringify([
      { ResourceType: "dedicated-host", Tags: plan.aws.hostTags },
    ]),
    "--output",
    "json",
  ];
  return args;
}

export function macosRunInstancesArgs(plan, { hostId, dryRun = false } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "campaign-launch-plan"
  ) {
    throw new Error("macOS JIT campaign launch plan contract is invalid");
  }
  const resolvedHostId = exact(hostId, /^h-[0-9a-f]+$/, "hostId");
  const args = [
    "ec2",
    "run-instances",
    "--image-id",
    plan.aws.amiId,
    "--instance-type",
    plan.aws.instanceType,
    "--count",
    "1",
    "--client-token",
    plan.aws.instanceClientToken,
    "--iam-instance-profile",
    JSON.stringify({ Name: plan.aws.instanceProfileName }),
    "--subnet-id",
    plan.aws.subnetId,
    "--security-group-ids",
    plan.aws.securityGroupId,
    "--associate-public-ip-address",
    "--placement",
    JSON.stringify({ HostId: resolvedHostId, Tenancy: "host" }),
    "--block-device-mappings",
    JSON.stringify([
      {
        DeviceName: plan.aws.rootVolume.deviceName,
        Ebs: {
          DeleteOnTermination: plan.aws.rootVolume.deleteOnTermination,
          Encrypted: plan.aws.rootVolume.encrypted,
          VolumeSize: plan.aws.rootVolume.volumeSizeGiB,
          VolumeType: plan.aws.rootVolume.volumeType,
        },
      },
    ]),
    "--metadata-options",
    JSON.stringify({
      HttpEndpoint: plan.aws.metadata.httpEndpoint,
      HttpTokens: plan.aws.metadata.httpTokens,
      HttpPutResponseHopLimit: plan.aws.metadata.httpPutResponseHopLimit,
      InstanceMetadataTags: plan.aws.metadata.instanceMetadataTags,
    }),
    "--instance-initiated-shutdown-behavior",
    "stop",
    "--tag-specifications",
    JSON.stringify([
      { ResourceType: "instance", Tags: plan.aws.instanceTags },
      { ResourceType: "volume", Tags: plan.aws.volumeTags },
    ]),
    "--output",
    "json",
  ];
  if (dryRun) args.splice(2, 0, "--dry-run");
  return args;
}

export function createMacosJitJobPlan(values = {}) {
  const id = campaignId(values.campaignId);
  const boundSource = source(values);
  const qualification = qualificationId(values.qualificationId);
  const runnerLabel = macosJitRunnerLabel(values.runnerLabel);
  const expectedLabel = `${MACOS_EC2_JIT.labelPrefix}${qualification}`;
  if (runnerLabel !== expectedLabel) {
    throw new Error(`runnerLabel must be ${expectedLabel}`);
  }
  const runId = exact(values.runId, /^\d+$/, "runId");
  const runAttempt = exact(
    values.runAttempt || "1",
    /^[1-9]\d*$/,
    "runAttempt",
  );
  const hostAllocatedAt = iso(values.hostAllocatedAt, "hostAllocatedAt");
  const jitParameterName = `${MACOS_EC2_JIT.jitParameterPrefix}${id}/${runId}/${runAttempt}/${qualification}`;
  const plan = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "job-run-plan",
    repository: repository(values.repository),
    campaign: { id },
    source: boundSource,
    github: {
      runId,
      runAttempt,
      jobId: exact(values.jobId, /^\d+$/, "jobId"),
      qualificationId: qualification,
      event: "workflow_dispatch",
    },
    runner: {
      name: exact(
        values.runnerName,
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
        "runnerName",
      ),
      label: runnerLabel,
      labels: macosJitRunnerLabels(runnerLabel),
      oneJobJit: true,
    },
    aws: {
      ...commonAws(values),
      hostId: exact(values.hostId, /^h-[0-9a-f]+$/, "hostId"),
      instanceId: exact(values.instanceId, /^i-[0-9a-f]+$/, "instanceId"),
      hostAllocatedAt,
      jitParameterName,
    },
    safety: {
      applyMode: values.execute === true ? "execute" : "dry-run",
      exactSourceRequired: true,
      queuedJobRequired: true,
      sameCampaignHostRequired: true,
      sameCampaignInstanceRequired: true,
      jitConfigTransport: "0600-temporary-file-to-ssm-secure-string",
      bootstrapTransport: "0600-temporary-file-to-ssm-command",
      jitConfigInBootstrap: false,
      jitConfigInArgv: false,
      cleanupOnCommandFailure: ["ssm-parameter", "github-runner-registration"],
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function createMacosJitClosePlan(values = {}) {
  const id = campaignId(values.campaignId);
  const boundSource = source(values);
  const hostAllocatedAt = iso(values.hostAllocatedAt, "hostAllocatedAt");
  const observedAt = iso(values.observedAt, "observedAt");
  const allocationHours =
    (new Date(observedAt).getTime() - new Date(hostAllocatedAt).getTime()) /
    3_600_000;
  if (allocationHours < MACOS_EC2_JIT.minimumHostAllocationHours) {
    throw new Error(
      `Dedicated Host cannot be closed before ${MACOS_EC2_JIT.minimumHostAllocationHours} hours`,
    );
  }
  const plan = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "campaign-close-plan",
    repository: repository(values.repository),
    campaign: { id },
    source: boundSource,
    aws: {
      ...commonAws(values),
      hostId: exact(values.hostId, /^h-[0-9a-f]+$/, "hostId"),
      instanceId: exact(values.instanceId, /^i-[0-9a-f]+$/, "instanceId"),
      hostAllocatedAt,
    },
    lifecycle: {
      observedAt,
      allocationHours,
      minimumHostAllocationHours: MACOS_EC2_JIT.minimumHostAllocationHours,
      maximumHostAllocationHours: MACOS_EC2_JIT.maximumHostAllocationHours,
    },
    safety: {
      applyMode: values.execute === true ? "execute" : "dry-run",
      exactCampaignOwnershipRequired: true,
      instanceTerminationRequiredBeforeRelease: true,
      encryptedDeleteOnTerminationVolumeRequired: true,
      awsDryRunRequiredBeforeRelease: true,
      reaperFallback: true,
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function macosReleaseHostsArgs(plan, { dryRun = false } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "campaign-close-plan"
  ) {
    throw new Error("macOS JIT campaign close plan contract is invalid");
  }
  const args = [
    "ec2",
    "release-hosts",
    "--host-ids",
    plan.aws.hostId,
    "--output",
    "json",
  ];
  if (dryRun) args.splice(2, 0, "--dry-run");
  return args;
}

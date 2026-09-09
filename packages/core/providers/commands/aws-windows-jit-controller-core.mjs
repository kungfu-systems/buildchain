// SPDX-License-Identifier: Apache-2.0

import { digest } from "./aws-runner-burst-core.mjs";
import {
  WINDOWS_EC2_JIT,
  windowsJitCampaignId,
  windowsJitRunnerLabel,
  windowsJitRunnerLabels,
} from "./aws-windows-jit-core.mjs";

export const AWS_WINDOWS_JIT_CONTROLLER_CONTRACT =
  "kungfu-buildchain-aws-windows-jit-controller/v2";

function exact(value, pattern, label) {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
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

function qualificationId(value) {
  return exact(
    value,
    /^win-(?:smoke|full-0[1-3]|cancel|timeout)$/,
    "qualificationId",
  );
}

function tag(key, value) {
  return { Key: key, Value: String(value) };
}

export function createWindowsJitLaunchPlan(values = {}) {
  const repository = exact(
    values.repository || WINDOWS_EC2_JIT.repository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "repository",
  );
  if (repository !== WINDOWS_EC2_JIT.repository) {
    throw new Error(`repository must be ${WINDOWS_EC2_JIT.repository}`);
  }
  const runId = exact(values.runId, /^\d+$/, "runId");
  const runAttempt = exact(
    values.runAttempt || "1",
    /^[1-9]\d*$/,
    "runAttempt",
  );
  const jobId = exact(values.jobId, /^\d+$/, "jobId");
  const qualification = qualificationId(values.qualificationId);
  const campaign = windowsJitCampaignId(values.campaignId);
  const runnerLabel = windowsJitRunnerLabel(values.runnerLabel);
  const expectedLabel = `${WINDOWS_EC2_JIT.labelPrefix}${campaign}-${qualification}`;
  if (runnerLabel !== expectedLabel) {
    throw new Error(`runnerLabel must be ${expectedLabel}`);
  }
  const runnerName = exact(
    values.runnerName,
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
    "runnerName",
  );
  const sourceSha = exactSha(values.sourceSha);
  const sourceRef = exact(
    values.sourceRef,
    /^refs\/heads\/[A-Za-z0-9._/-]+$/,
    "sourceRef",
  );
  const region = exact(
    values.region || WINDOWS_EC2_JIT.region,
    /^us-[a-z]+-\d$/,
    "region",
  );
  if (region !== WINDOWS_EC2_JIT.region) {
    throw new Error(`region must be ${WINDOWS_EC2_JIT.region}`);
  }
  const instanceType = exact(
    values.instanceType || WINDOWS_EC2_JIT.instanceType,
    /^[a-z0-9.]+$/,
    "instanceType",
  );
  if (instanceType !== WINDOWS_EC2_JIT.instanceType) {
    throw new Error(`instanceType must be ${WINDOWS_EC2_JIT.instanceType}`);
  }
  const amiId = exact(values.amiId, /^ami-[0-9a-f]+$/, "amiId");
  const amiName = exact(values.amiName, /^[A-Za-z0-9._-]+$/, "amiName");
  const subnetId = exact(values.subnetId, /^subnet-[0-9a-f]+$/, "subnetId");
  const securityGroupId = exact(
    values.securityGroupId,
    /^sg-[0-9a-f]+$/,
    "securityGroupId",
  );
  const instanceProfileName = exact(
    values.instanceProfileName,
    /^[A-Za-z0-9+=,.@_-]{1,128}$/,
    "instanceProfileName",
  );
  const evidenceBucket = exact(
    values.evidenceBucket,
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    "evidenceBucket",
  );
  const stateTable = exact(
    values.stateTable,
    /^kungfu-buildchain-windows-jit(?:-[A-Za-z0-9_.-]+)?$/,
    "stateTable",
  );
  const launchedAt = iso(values.launchedAt, "launchedAt");
  const clientToken = `kungfu-${runId}-${runAttempt}-${qualification}`;
  const jitParameterName =
    String(values.jitParameterName || "").trim() ||
    `${WINDOWS_EC2_JIT.jitParameterPrefix}${runId}/${runAttempt}/${qualification}`;
  if (
    !jitParameterName.startsWith(WINDOWS_EC2_JIT.jitParameterPrefix) ||
    !/^\/[A-Za-z0-9._/-]+$/.test(jitParameterName)
  ) {
    throw new Error("jitParameterName must use the dedicated Windows prefix");
  }

  const ownershipTags = [
    tag("kungfu:owner", "buildchain"),
    tag("kungfu:plane", "aws-us-elastic-runner-burst"),
    tag("kungfu:provider", "windows-ec2-jit"),
    tag("kungfu:campaign-id", campaign),
    tag("kungfu:github-run-id", runId),
    tag("kungfu:github-run-attempt", runAttempt),
    tag("kungfu:qualification-id", qualification),
    tag("kungfu:source-sha", sourceSha),
    tag("kungfu:runner-label", runnerLabel),
  ];
  const instanceTags = [
    ...ownershipTags,
    tag("kungfu:jit-parameter", jitParameterName),
  ];
  const volumeTags = [...ownershipTags];
  const plan = {
    schemaVersion: 1,
    contract: AWS_WINDOWS_JIT_CONTROLLER_CONTRACT,
    kind: "launch-plan",
    repository,
    campaign: { id: campaign },
    source: { sha: sourceSha, ref: sourceRef },
    github: {
      runId,
      runAttempt,
      jobId,
      qualificationId: qualification,
      event: "workflow_dispatch",
      displayTitle: `AWS Windows JIT ${campaign} ${qualification}`,
    },
    runner: {
      name: runnerName,
      label: runnerLabel,
      labels: windowsJitRunnerLabels(runnerLabel),
      oneJobJit: true,
    },
    aws: {
      region,
      instanceType,
      amiId,
      amiName,
      subnetId,
      securityGroupId,
      instanceProfileName,
      evidenceBucket,
      stateTable,
      jitParameterName,
      launchedAt,
      clientToken,
      rootVolume: {
        deviceName: "/dev/sda1",
        deleteOnTermination: true,
        encrypted: true,
        volumeSizeGiB: 120,
        volumeType: "gp3",
      },
      metadata: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 1,
        instanceMetadataTags: "disabled",
      },
      instanceTags,
      volumeTags,
    },
    safety: {
      applyMode: values.execute === true ? "execute" : "dry-run",
      exactSourceRequired: true,
      queuedJobRequired: true,
      activeInstanceCeiling: WINDOWS_EC2_JIT.maxConcurrentInstances,
      campaignAcceptedInstanceCeiling: WINDOWS_EC2_JIT.maxAcceptedInstances,
      campaignReservationUsd:
        (WINDOWS_EC2_JIT.pricePerHourUsd *
          WINDOWS_EC2_JIT.maximumInstanceLifetimeMinutes) /
        60,
      campaignBudgetLimitUsd: WINDOWS_EC2_JIT.budgetLimitUsd,
      persistentCampaignLedgerRequired: true,
      awsDryRunRequiredBeforeLaunch: true,
      userDataTransport: "fileb://rendered-bootstrap",
      jitConfigTransport: "0600-temporary-file-to-ssm-secure-string",
      jitConfigInUserData: false,
      jitConfigInArgv: false,
      cleanupOnLaunchFailure: [
        "ec2-instance",
        "ssm-parameter",
        "github-runner-registration",
      ],
    },
  };
  return { ...plan, digest: digest(plan) };
}

export function windowsRunInstancesArgs(
  plan,
  { bootstrapPath = "<rendered-bootstrap>", dryRun = false } = {},
) {
  if (plan?.contract !== AWS_WINDOWS_JIT_CONTROLLER_CONTRACT) {
    throw new Error("Windows JIT launch plan contract is invalid");
  }
  const resolvedBootstrap = exact(
    bootstrapPath,
    /^(?:<rendered-bootstrap>|\/[^\0]+|[A-Za-z]:[\\/][^\0]+)$/,
    "bootstrapPath",
  );
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
    plan.aws.clientToken,
    "--iam-instance-profile",
    JSON.stringify({ Name: plan.aws.instanceProfileName }),
    "--subnet-id",
    plan.aws.subnetId,
    "--security-group-ids",
    plan.aws.securityGroupId,
    "--associate-public-ip-address",
    "--user-data",
    `fileb://${resolvedBootstrap}`,
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
    "terminate",
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

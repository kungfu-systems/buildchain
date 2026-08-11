#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import {
  AWS_MACOS_JIT_CONTROLLER_CONTRACT,
  createMacosJitCampaignPlan,
  createMacosJitClosePlan,
  createMacosJitInstanceRehydratePlan,
  createMacosJitJobPlan,
  createMacosJitSourceRebindPlan,
  macosAllocateHostsArgs,
  macosReleaseHostsArgs,
  macosRunInstancesArgs,
} from "./aws-macos-jit-controller-core.mjs";
import { MACOS_EC2_JIT_REGIONS } from "./aws-macos-jit-core.mjs";
import { executeMacosJitInstanceRehydrate } from "./aws-macos-jit-instance-rehydrate.mjs";
import { executeMacosJitJob } from "./aws-macos-jit-job-controller.mjs";
import { executeMacosJitSourceRebind } from "./aws-macos-jit-source-rebind.mjs";
import {
  assertDryRun,
  assertAllowedPolicySimulation,
  assertMacosBudgetLaunchGate,
  assertOwnership,
  awsArgs,
  awsJson,
  commandResult,
  ghJson,
  requireSuccess,
} from "./aws-macos-jit-controller-runtime.mjs";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || "";
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function jsonArrayArg(name) {
  let parsed;
  try {
    parsed = JSON.parse(arg(name));
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON array`);
  }
  return parsed;
}

function assertCampaignLaunchPreflight(plan, profile) {
  const launchGate = assertMacosBudgetLaunchGate(plan, profile);
  const commit = ghJson(
    ["api", `repos/${plan.repository}/commits/${plan.source.sha}`],
    undefined,
    "GitHub exact-source preflight",
  );
  if (String(commit.sha || "").toLowerCase() !== plan.source.sha) {
    throw new Error("GitHub did not resolve the exact campaign source SHA");
  }
  const regionalPlans = Object.keys(MACOS_EC2_JIT_REGIONS).map((region) => ({
    ...plan,
    aws: { ...plan.aws, region },
  }));
  const activeHosts = regionalPlans.flatMap(
    (regionalPlan) =>
      awsJson(
        regionalPlan,
        profile,
        [
          "ec2",
          "describe-hosts",
          "--filter",
          "Name=tag:kungfu:plane,Values=aws-us-elastic-runner-burst",
          "Name=tag:kungfu:provider,Values=macos-ec2-jit",
          "Name=state,Values=available,pending,under-assessment",
          "--output",
          "json",
        ],
        `active macOS JIT host preflight in ${regionalPlan.aws.region}`,
      ).Hosts || [],
  );
  if (activeHosts.length >= plan.safety.activeHostCeiling) {
    throw new Error("macOS JIT active Dedicated Host ceiling is reached");
  }
  const instances = regionalPlans.flatMap((regionalPlan) => {
    const active = awsJson(
      regionalPlan,
      profile,
      [
        "ec2",
        "describe-instances",
        "--filters",
        "Name=tag:kungfu:plane,Values=aws-us-elastic-runner-burst",
        "Name=tag:kungfu:provider,Values=macos-ec2-jit",
        "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down",
        "--output",
        "json",
      ],
      `active macOS JIT instance preflight in ${regionalPlan.aws.region}`,
    );
    return (active.Reservations || []).flatMap(
      (reservation) => reservation.Instances || [],
    );
  });
  if (instances.length >= plan.safety.activeInstanceCeiling) {
    throw new Error("macOS JIT active instance ceiling is reached");
  }
  const image = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-images",
      "--image-ids",
      plan.aws.amiId,
      "--output",
      "json",
    ],
    "macOS AMI preflight",
  ).Images?.[0];
  if (
    !image ||
    image.Name !== plan.aws.amiName ||
    image.Architecture !== "arm64_mac" ||
    image.State !== "available"
  ) {
    throw new Error("macOS AMI identity or availability mismatch");
  }
  const subnet = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-subnets",
      "--subnet-ids",
      plan.aws.subnetId,
      "--output",
      "json",
    ],
    "macOS subnet preflight",
  ).Subnets?.[0];
  if (!subnet || subnet.AvailabilityZone !== plan.aws.availabilityZone) {
    throw new Error(
      "macOS subnet and Dedicated Host availability zone mismatch",
    );
  }
  return {
    ...launchGate,
    exactCommit: plan.source.sha,
    activeHosts: activeHosts.length,
    activeInstances: instances.length,
    amiOwnerId: image.OwnerId,
    subnetAvailabilityZone: subnet.AvailabilityZone,
  };
}

export function executeMacosJitCampaignLaunch(plan, { profile = "" } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "campaign-launch-plan"
  ) {
    throw new Error("macOS JIT campaign launch plan contract is invalid");
  }
  const preflight = assertCampaignLaunchPreflight(plan, profile);
  const allocationPermission = assertAllowedPolicySimulation(
    plan,
    profile,
    preflight.principalArn,
    "ec2:AllocateHosts",
  );
  const hostId = awsJson(
    plan,
    profile,
    macosAllocateHostsArgs(plan),
    "EC2 AllocateHosts",
  ).HostIds?.[0];
  if (!/^h-[0-9a-f]+$/.test(String(hostId || ""))) {
    throw new Error("EC2 AllocateHosts returned no Dedicated Host identity");
  }
  let launched;
  try {
    assertDryRun(
      commandResult(
        "aws",
        awsArgs(
          plan,
          profile,
          macosRunInstancesArgs(plan, { hostId, dryRun: true }),
        ),
      ),
      "EC2 RunInstances DryRun",
    );
    launched = awsJson(
      plan,
      profile,
      macosRunInstancesArgs(plan, { hostId }),
      "EC2 RunInstances",
    );
  } catch (error) {
    throw new Error(
      `${error.message || error}; Dedicated Host ${hostId} remains card-owned and must be retained for the 24-hour minimum before the reaper releases it`,
    );
  }
  const instance = launched.Instances?.[0];
  if (!/^i-[0-9a-f]+$/.test(String(instance?.InstanceId || ""))) {
    throw new Error(
      `EC2 RunInstances returned no instance identity; Dedicated Host ${hostId} remains card-owned for reaper cleanup`,
    );
  }
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "wait",
        "instance-running",
        "--instance-ids",
        instance.InstanceId,
      ]),
    ),
    "macOS campaign instance-running waiter",
  );
  const host = awsJson(
    plan,
    profile,
    ["ec2", "describe-hosts", "--host-ids", hostId, "--output", "json"],
    "macOS Dedicated Host identity readback",
  ).Hosts?.[0];
  if (!host || host.HostId !== hostId) {
    throw new Error("macOS Dedicated Host readback failed");
  }
  assertOwnership(host.Tags, plan);
  return {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "campaign-launch-result",
    status: "launched",
    repository: plan.repository,
    campaign: plan.campaign,
    source: plan.source,
    aws: {
      region: plan.aws.region,
      availabilityZone: plan.aws.availabilityZone,
      hostId,
      hostAllocatedAt: new Date(host.AllocationTime).toISOString(),
      instanceId: instance.InstanceId,
      instanceType: instance.InstanceType,
      imageId: instance.ImageId,
      launchTime: new Date(instance.LaunchTime).toISOString(),
    },
    preflight: { ...preflight, allocationPermission },
    dryRuns: ["RunInstances:DryRunOperation"],
    planDigest: plan.digest,
  };
}

function deleteCampaignResidue(plan, profile) {
  const prefix = `/kungfu/burst/macos/${plan.campaign.id}/`;
  const parameters =
    awsJson(
      plan,
      profile,
      [
        "ssm",
        "describe-parameters",
        "--parameter-filters",
        `Key=Name,Option=BeginsWith,Values=${prefix}`,
        "--output",
        "json",
      ],
      "macOS campaign parameter cleanup lookup",
    ).Parameters || [];
  const names = parameters
    .map((parameter) => String(parameter.Name || ""))
    .filter((name) => name.startsWith(prefix));
  for (const name of names) {
    requireSuccess(
      commandResult(
        "aws",
        awsArgs(plan, profile, ["ssm", "delete-parameter", "--name", name]),
      ),
      `macOS campaign parameter ${name} cleanup`,
    );
  }
  const runners = ghJson(
    ["api", `repos/${plan.repository}/actions/runners?per_page=100`],
    undefined,
    "macOS campaign runner cleanup lookup",
  ).runners;
  const candidates = (runners || []).filter((runner) =>
    (runner.labels || []).some((label) =>
      String(label.name || label).startsWith("aws-us-ec2-macos-jit-"),
    ),
  );
  for (const runner of candidates) {
    requireSuccess(
      commandResult("gh", [
        "api",
        "--method",
        "DELETE",
        `repos/${plan.repository}/actions/runners/${runner.id}`,
      ]),
      `macOS campaign runner ${runner.id} cleanup`,
    );
  }
  return {
    deletedParameters: names,
    deletedRunners: candidates.map(({ id }) => id),
  };
}

function assertCampaignClosePreflight(plan, profile) {
  const host = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-hosts",
      "--host-ids",
      plan.aws.hostId,
      "--output",
      "json",
    ],
    "macOS campaign close host preflight",
  ).Hosts?.[0];
  if (!host || host.HostId !== plan.aws.hostId) {
    throw new Error("macOS campaign close host identity mismatch");
  }
  assertOwnership(host.Tags, plan);
  const allocationHours =
    (new Date(plan.lifecycle.observedAt).getTime() -
      new Date(host.AllocationTime).getTime()) /
    3_600_000;
  if (allocationHours < plan.lifecycle.minimumHostAllocationHours) {
    throw new Error(
      `Dedicated Host actual allocation age ${allocationHours.toFixed(3)}h is below the 24-hour minimum`,
    );
  }
  const instance = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-instances",
      "--instance-ids",
      plan.aws.instanceId,
      "--output",
      "json",
    ],
    "macOS campaign close instance preflight",
  ).Reservations?.[0]?.Instances?.[0];
  if (!instance || instance.Placement?.HostId !== plan.aws.hostId) {
    throw new Error("macOS campaign close instance identity mismatch");
  }
  assertOwnership(instance.Tags, plan);
  const root = (instance.BlockDeviceMappings || []).find(
    ({ Ebs }) => Ebs?.DeleteOnTermination === true,
  );
  if (!root?.Ebs?.VolumeId) {
    throw new Error("macOS campaign root volume is not delete-on-termination");
  }
  const volume = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-volumes",
      "--volume-ids",
      root.Ebs.VolumeId,
      "--output",
      "json",
    ],
    "macOS campaign root volume preflight",
  ).Volumes?.[0];
  if (!volume || volume.Encrypted !== true) {
    throw new Error("macOS campaign root volume is not encrypted");
  }
  return { host, instance, volumeId: root.Ebs.VolumeId, allocationHours };
}

export function executeMacosJitCampaignClose(plan, { profile = "" } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "campaign-close-plan"
  ) {
    throw new Error("macOS JIT campaign close plan contract is invalid");
  }
  const checked = assertCampaignClosePreflight(plan, profile);
  const cleanup = deleteCampaignResidue(plan, profile);
  if (checked.instance.State?.Name !== "terminated") {
    requireSuccess(
      commandResult(
        "aws",
        awsArgs(plan, profile, [
          "ec2",
          "terminate-instances",
          "--instance-ids",
          plan.aws.instanceId,
          "--output",
          "json",
        ]),
      ),
      "macOS campaign instance termination",
    );
    requireSuccess(
      commandResult(
        "aws",
        awsArgs(plan, profile, [
          "ec2",
          "wait",
          "instance-terminated",
          "--instance-ids",
          plan.aws.instanceId,
        ]),
      ),
      "macOS campaign instance-terminated waiter",
    );
  }
  const host = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-hosts",
      "--host-ids",
      plan.aws.hostId,
      "--output",
      "json",
    ],
    "macOS campaign host release preflight",
  ).Hosts?.[0];
  const result = {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "campaign-close-result",
    campaign: plan.campaign,
    source: plan.source,
    aws: {
      region: plan.aws.region,
      hostId: plan.aws.hostId,
      instanceId: plan.aws.instanceId,
      volumeId: checked.volumeId,
    },
    cleanup,
    planDigest: plan.digest,
  };
  if (host?.State !== "available" || (host.Instances || []).length !== 0) {
    return {
      ...result,
      status: "release-pending",
      aws: { ...result.aws, hostState: host?.State || "unknown" },
      fallback: "scheduled-card-scoped-reaper",
    };
  }
  assertDryRun(
    commandResult(
      "aws",
      awsArgs(plan, profile, macosReleaseHostsArgs(plan, { dryRun: true })),
    ),
    "EC2 ReleaseHosts DryRun",
  );
  const released = awsJson(
    plan,
    profile,
    macosReleaseHostsArgs(plan),
    "EC2 ReleaseHosts",
  );
  if (!(released.Successful || []).includes(plan.aws.hostId)) {
    throw new Error(
      "EC2 ReleaseHosts did not confirm the exact Dedicated Host",
    );
  }
  return {
    ...result,
    status: "released",
    lifecycle: {
      ...plan.lifecycle,
      actualAllocationHours: checked.allocationHours,
      instanceTerminated: true,
      encryptedDeleteOnTerminationVolume: true,
      hostReleased: true,
    },
    dryRun: "ReleaseHosts:DryRunOperation",
  };
}

function commonValues(execute) {
  return {
    execute,
    accountId: arg("account-id"),
    repository: arg("repository", "kungfu-systems/kungfu"),
    campaignId: arg("campaign-id"),
    sourceSha: arg("source-sha"),
    sourceRef: arg("source-ref"),
    region: arg("region", "us-east-1"),
    availabilityZone: arg("availability-zone"),
    instanceType: arg("instance-type", "mac2.metal"),
    amiId: arg("ami-id"),
    amiName: arg("ami-name"),
    subnetId: arg("subnet-id"),
    securityGroupId: arg("security-group-id"),
    instanceProfileName: arg("instance-profile-name"),
    evidenceBucket: arg("evidence-bucket"),
  };
}

function confirm(plan) {
  if (arg("confirm-source-sha") !== plan.source.sha) {
    throw new Error("--confirm-source-sha must equal the exact source SHA");
  }
  if (arg("confirm-campaign-id") !== plan.campaign.id) {
    throw new Error("--confirm-campaign-id must equal the campaign id");
  }
  if (plan.kind === "campaign-source-rebind-plan") {
    if (arg("confirm-previous-source-sha") !== plan.previousSource.sha) {
      throw new Error(
        "--confirm-previous-source-sha must equal previousSourceSha",
      );
    }
    if (arg("confirm-host-id") !== plan.aws.hostId) {
      throw new Error("--confirm-host-id must equal the exact host id");
    }
    if (arg("confirm-instance-id") !== plan.aws.instanceId) {
      throw new Error("--confirm-instance-id must equal the exact instance id");
    }
    if (!flag("confirm-zero-allocation")) {
      throw new Error("--confirm-zero-allocation is required");
    }
    if (plan.github.priorRunPolicy === "terminal-failure") {
      const confirmed = jsonArrayArg(
        "confirm-terminal-failure-run-ids-json",
      ).map(String);
      if (
        JSON.stringify(confirmed) !==
        JSON.stringify(plan.github.terminalFailureRunIds)
      ) {
        throw new Error(
          "--confirm-terminal-failure-run-ids-json must equal the exact failed run inventory",
        );
      }
      const confirmedStartupFailures = flag("confirm-startup-failure-runs-json")
        ? jsonArrayArg("confirm-startup-failure-runs-json")
        : [];
      if (
        JSON.stringify(confirmedStartupFailures) !==
        JSON.stringify(plan.github.startupFailureRuns)
      ) {
        throw new Error(
          "--confirm-startup-failure-runs-json must equal the exact startup failure inventory",
        );
      }
    }
  }
  if (plan.kind === "instance-rehydrate-plan") {
    if (arg("confirm-host-id") !== plan.aws.hostId) {
      throw new Error("--confirm-host-id must equal the exact host id");
    }
    if (arg("confirm-replaces-instance-id") !== plan.aws.replacesInstanceId) {
      throw new Error(
        "--confirm-replaces-instance-id must equal replacesInstanceId",
      );
    }
    if (!flag("confirm-no-host-allocation")) {
      throw new Error("--confirm-no-host-allocation is required");
    }
  }
}

function emit(plan, mode, execute, operation) {
  if (!execute || mode.startsWith("plan-")) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  confirm(plan);
  const result = operation();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function main() {
  const mode = process.argv[2] || "plan-campaign";
  const execute = flag("execute");
  if (["plan-campaign", "launch-campaign"].includes(mode)) {
    const plan = createMacosJitCampaignPlan({
      ...commonValues(execute),
      createdAt: arg("created-at", new Date().toISOString()),
    });
    return emit(plan, mode, execute, () =>
      executeMacosJitCampaignLaunch(plan, { profile: arg("aws-profile") }),
    );
  }
  if (["plan-rehydrate", "rehydrate-instance"].includes(mode)) {
    const plan = createMacosJitInstanceRehydratePlan({
      ...commonValues(execute),
      hostId: arg("host-id"),
      hostAllocatedAt: arg("host-allocated-at"),
      replacesInstanceId: arg("replaces-instance-id"),
      rehydrationId: arg("rehydration-id"),
    });
    return emit(plan, mode, execute, () =>
      executeMacosJitInstanceRehydrate(plan, {
        profile: arg("aws-profile"),
      }),
    );
  }
  if (
    [
      "plan-rebind",
      "rebind-campaign",
      "plan-rebind-after-failure",
      "rebind-campaign-after-failure",
    ].includes(mode)
  ) {
    const afterFailure = mode.endsWith("after-failure");
    const plan = createMacosJitSourceRebindPlan({
      ...commonValues(execute),
      previousSourceSha: arg("previous-source-sha"),
      previousSourceRef: arg("previous-source-ref"),
      workflowId: arg("workflow-id"),
      hostId: arg("host-id"),
      instanceId: arg("instance-id"),
      priorRunPolicy: afterFailure ? "terminal-failure" : "unused",
      terminalFailureRunIds: afterFailure
        ? jsonArrayArg("terminal-failure-run-ids-json")
        : [],
      startupFailureRuns:
        afterFailure && flag("startup-failure-runs-json")
          ? jsonArrayArg("startup-failure-runs-json")
          : [],
    });
    return emit(plan, mode, execute, () =>
      executeMacosJitSourceRebind(plan, { profile: arg("aws-profile") }),
    );
  }
  if (["plan-job", "run-job"].includes(mode)) {
    const plan = createMacosJitJobPlan({
      ...commonValues(execute),
      runId: arg("run-id"),
      runAttempt: arg("run-attempt", "1"),
      jobId: arg("job-id"),
      qualificationId: arg("qualification-id"),
      runnerLabel: arg("runner-label"),
      runnerName: arg("runner-name"),
      hostId: arg("host-id"),
      instanceId: arg("instance-id"),
      hostAllocatedAt: arg("host-allocated-at"),
    });
    if (execute && arg("confirm-run-id") !== plan.github.runId) {
      throw new Error("--confirm-run-id must equal the exact GitHub run id");
    }
    return emit(plan, mode, execute, () =>
      executeMacosJitJob(plan, { profile: arg("aws-profile") }),
    );
  }
  if (["plan-close", "close-campaign"].includes(mode)) {
    const plan = createMacosJitClosePlan({
      ...commonValues(execute),
      hostId: arg("host-id"),
      instanceId: arg("instance-id"),
      hostAllocatedAt: arg("host-allocated-at"),
      observedAt: arg("observed-at", new Date().toISOString()),
    });
    return emit(plan, mode, execute, () =>
      executeMacosJitCampaignClose(plan, { profile: arg("aws-profile") }),
    );
  }
  throw new Error(`unsupported aws-macos-jit-controller mode: ${mode}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message || error}`);
    process.exitCode = 1;
  }
}

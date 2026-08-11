// SPDX-License-Identifier: Apache-2.0

import {
  AWS_MACOS_JIT_CONTROLLER_CONTRACT,
  macosRunInstancesArgs,
} from "./aws-macos-jit-controller-core.mjs";
import { MACOS_EC2_JIT_REGIONS } from "./aws-macos-jit-core.mjs";
import {
  assertDryRun,
  assertMacosBudgetLaunchGate,
  assertOwnership,
  awsArgs,
  awsJson,
  commandResult,
  ghJson,
  requireSuccess,
} from "./aws-macos-jit-controller-runtime.mjs";

function assertInstanceRehydratePreflight(plan, profile) {
  const launchGate = assertMacosBudgetLaunchGate(plan, profile);
  const commit = ghJson(
    ["api", `repos/${plan.repository}/commits/${plan.source.sha}`],
    undefined,
    "GitHub exact-source preflight",
  );
  if (String(commit.sha || "").toLowerCase() !== plan.source.sha) {
    throw new Error("GitHub did not resolve the exact campaign source SHA");
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
    "macOS rehydration host preflight",
  ).Hosts?.[0];
  if (
    !host ||
    host.State !== "available" ||
    host.AvailabilityZone !== plan.aws.availabilityZone ||
    host.HostProperties?.InstanceType !== plan.aws.instanceType ||
    (host.Instances || []).length !== 0 ||
    new Date(host.AllocationTime).toISOString() !== plan.aws.hostAllocatedAt
  ) {
    throw new Error("macOS rehydration host identity or capacity mismatch");
  }
  assertOwnership(host.Tags, plan);

  const regionalPlans = Object.keys(MACOS_EC2_JIT_REGIONS).map((region) => ({
    ...plan,
    aws: { ...plan.aws, region },
  }));
  const otherHosts = regionalPlans.flatMap((regionalPlan) =>
    (
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
        `macOS rehydration host ceiling in ${regionalPlan.aws.region}`,
      ).Hosts || []
    ).filter((candidate) => candidate.HostId !== plan.aws.hostId),
  );
  if (otherHosts.length !== 0) {
    throw new Error("macOS rehydration found another active Dedicated Host");
  }
  const activeInstances = regionalPlans.flatMap((regionalPlan) => {
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
  if (activeInstances.length !== 0) {
    throw new Error("macOS rehydration requires zero active JIT instances");
  }
  const runners = ghJson(
    ["api", `repos/${plan.repository}/actions/runners?per_page=100`],
    undefined,
    "macOS rehydration runner preflight",
  ).runners;
  if (
    (runners || []).some((runner) =>
      (runner.labels || []).some((label) =>
        String(label.name || label).startsWith("aws-us-ec2-macos-jit-"),
      ),
    )
  ) {
    throw new Error("macOS rehydration requires zero JIT runner residue");
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
    "macOS rehydration AMI preflight",
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
    "macOS rehydration subnet preflight",
  ).Subnets?.[0];
  if (!subnet || subnet.AvailabilityZone !== plan.aws.availabilityZone) {
    throw new Error(
      "macOS subnet and Dedicated Host availability zone mismatch",
    );
  }
  return {
    ...launchGate,
    exactCommit: plan.source.sha,
    hostId: host.HostId,
    hostState: host.State,
    activeInstances: 0,
    otherActiveHosts: 0,
    amiOwnerId: image.OwnerId,
    subnetAvailabilityZone: subnet.AvailabilityZone,
  };
}

export function executeMacosJitInstanceRehydrate(plan, { profile = "" } = {}) {
  if (
    plan?.contract !== AWS_MACOS_JIT_CONTROLLER_CONTRACT ||
    plan.kind !== "instance-rehydrate-plan"
  ) {
    throw new Error("macOS JIT instance rehydrate plan contract is invalid");
  }
  const preflight = assertInstanceRehydratePreflight(plan, profile);
  assertDryRun(
    commandResult(
      "aws",
      awsArgs(
        plan,
        profile,
        macosRunInstancesArgs(plan, { hostId: plan.aws.hostId, dryRun: true }),
      ),
    ),
    "EC2 same-host RunInstances DryRun",
  );
  const launched = awsJson(
    plan,
    profile,
    macosRunInstancesArgs(plan, { hostId: plan.aws.hostId }),
    "EC2 same-host RunInstances",
  );
  const instanceId = launched.Instances?.[0]?.InstanceId;
  if (!/^i-[0-9a-f]+$/.test(String(instanceId || ""))) {
    throw new Error("EC2 same-host RunInstances returned no instance identity");
  }
  requireSuccess(
    commandResult(
      "aws",
      awsArgs(plan, profile, [
        "ec2",
        "wait",
        "instance-running",
        "--instance-ids",
        instanceId,
      ]),
    ),
    "macOS rehydrated instance-running waiter",
  );
  const instance = awsJson(
    plan,
    profile,
    [
      "ec2",
      "describe-instances",
      "--instance-ids",
      instanceId,
      "--output",
      "json",
    ],
    "macOS rehydrated instance readback",
  ).Reservations?.[0]?.Instances?.[0];
  if (
    !instance ||
    instance.State?.Name !== "running" ||
    instance.Placement?.HostId !== plan.aws.hostId ||
    instance.ImageId !== plan.aws.amiId ||
    instance.InstanceType !== plan.aws.instanceType
  ) {
    throw new Error("macOS rehydrated instance identity or placement mismatch");
  }
  assertOwnership(instance.Tags, plan);
  return {
    schemaVersion: 1,
    contract: AWS_MACOS_JIT_CONTROLLER_CONTRACT,
    kind: "instance-rehydrate-result",
    status: "rehydrated",
    repository: plan.repository,
    campaign: plan.campaign,
    source: plan.source,
    replacement: {
      rehydrationId: plan.aws.rehydrationId,
      replacesInstanceId: plan.aws.replacesInstanceId,
    },
    aws: {
      region: plan.aws.region,
      availabilityZone: plan.aws.availabilityZone,
      hostId: plan.aws.hostId,
      hostAllocatedAt: plan.aws.hostAllocatedAt,
      instanceId,
      instanceType: instance.InstanceType,
      imageId: instance.ImageId,
      launchTime: new Date(instance.LaunchTime).toISOString(),
    },
    preflight,
    dryRun: "RunInstances:DryRunOperation",
    hostAllocated: false,
    planDigest: plan.digest,
  };
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMacosJitEvidence,
  macosEc2JitPlan,
  macosJitRunnerLabel,
  macosJitRunnerLabels,
  renderMacosJitBootstrap,
  verifyMacosEc2JitQualification,
} from "../scripts/aws-macos-jit-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("macOS EC2 JIT plan binds one host below USD 25", () => {
  const plan = macosEc2JitPlan();
  assert.equal(plan.config.maxAcceptedHosts, 1);
  assert.equal(plan.config.minimumHostAllocationHours, 24);
  assert.equal(plan.config.maximumHostAllocationHours, 30);
  assert.equal(plan.costEnvelope.minimumCommittedComputeUsd, 15.6);
  assert.equal(plan.costEnvelope.maximumBoundedSpendUsd, 19.5);
  assert.ok(plan.costEnvelope.maximumBoundedSpendUsd < 25);
  assert.equal(plan.invariants.oneJobPerRunner, true);
  assert.equal(plan.invariants.oneHostPerCampaign, true);
});

test("macOS EC2 JIT plan rejects an unsafe cost envelope", () => {
  assert.throws(
    () => macosEc2JitPlan({ maxAcceptedHosts: 2 }),
    /must remain below budget/,
  );
});

test("macOS JIT runner labels are campaign-scoped and bounded", () => {
  assert.equal(
    macosJitRunnerLabel("aws-us-ec2-macos-jit-full-01"),
    "aws-us-ec2-macos-jit-full-01",
  );
  assert.throws(
    () => macosJitRunnerLabel("kungfu-build-v4-macos-arm64"),
    /must match/,
  );
  assert.deepEqual(macosJitRunnerLabels("aws-us-ec2-macos-jit-full-01"), [
    "self-hosted",
    "macOS",
    "ARM64",
    "aws-us-ec2-macos-jit-full-01",
  ]);
});

test("macOS bootstrap keeps JIT material out of rendered commands", () => {
  const template =
    "param=__JIT_PARAMETER_NAME__;label=__RUNNER_LABEL__;bucket=__EVIDENCE_BUCKET__;sha=__SOURCE_SHA__;run=__GITHUB_RUN_ID__;attempt=__GITHUB_RUN_ATTEMPT__;ami=__AMI_ID__;name=__AMI_NAME__;region=__REGION__;host=__HOST_ID__;type=__INSTANCE_TYPE__;allocated=__HOST_ALLOCATED_AT__";
  const rendered = renderMacosJitBootstrap(template, {
    jitParameterName: "/kungfu/burst/macos/full-01",
    evidenceBucket: "kungfu-macos-jit-evidence",
    runnerLabel: "aws-us-ec2-macos-jit-full-01",
    sourceSha: "a".repeat(40),
    githubRunId: "123",
    githubRunAttempt: "1",
    amiId: "ami-0123456789abcdef0",
    amiName: "amzn-ec2-macos-15.7.7-20260715-arm64",
    hostId: "h-0123456789abcdef0",
    hostAllocatedAt: "2026-07-29T00:00:00Z",
  });
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
  assert.doesNotMatch(rendered, /encoded_jit_config|github_pat_|ghp_|gho_/);
  assert.match(rendered, /\/kungfu\/burst\/macos\/full-01/);
});

test("macOS JIT evidence binds exact source, host, AMI, runner, and lifecycle", () => {
  const evidence = createMacosJitEvidence({
    repository: "kungfu-systems/kungfu",
    sourceSha: "a".repeat(40),
    sourceRef: "refs/heads/dev/v4/v4.0",
    githubRunId: "123",
    githubRunAttempt: "1",
    githubJob: "full",
    runnerName: "aws-mac-full-01",
    runnerLabels: [
      "self-hosted",
      "macOS",
      "ARM64",
      "aws-us-ec2-macos-jit-full-01",
    ],
    hostId: "h-0123456789abcdef0",
    instanceId: "i-0123456789abcdef0",
    instanceType: "mac2.metal",
    amiId: "ami-0123456789abcdef0",
    amiName: "amzn-ec2-macos-15.7.7-arm64",
    availabilityZone: "us-east-1a",
    hostAllocatedAt: "2026-07-29T00:00:00Z",
    instanceLaunchedAt: "2026-07-29T00:05:00Z",
    runnerStartedAt: "2026-07-29T00:10:00Z",
    runnerExitedAt: "2026-07-29T01:00:00Z",
  });
  assert.equal(evidence.source.sha, "a".repeat(40));
  assert.equal(evidence.aws.hostId, "h-0123456789abcdef0");
  assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
});

test("macOS phase requires three jobs, a full job, 24 hours, and zero residue", () => {
  const jobs = [{ kind: "smoke" }, { kind: "smoke" }, { kind: "full" }].map(
    (job, index) => ({
      ...job,
      trusted: true,
      exactSource: true,
      status: "succeeded",
      oneJobJit: true,
      hostId: "h-0123456789abcdef0",
      instanceId: "i-0123456789abcdef0",
      runnerLabel: `aws-us-ec2-macos-jit-job-${index + 1}`,
    }),
  );
  const result = verifyMacosEc2JitQualification({
    jobs,
    hostLifecycle: {
      status: "passed",
      allocatedAt: "2026-07-29T00:00:00Z",
      releasedAt: "2026-07-30T00:05:00Z",
      instanceTerminated: true,
      scrubCompleted: true,
      hostReleased: true,
    },
    registeredCloudRunners: [],
    activeInstances: [],
    allocatedHosts: [],
    disposableVolumes: [],
    actualIncrementalSpendUsd: 15.7,
    observedAt: "2026-07-30T00:06:00Z",
  });
  assert.equal(result.qualifying, true);
  assert.equal(result.metrics.acceptedJobs, 3);
  assert.equal(result.metrics.distinctHosts, 1);
});

test("macOS phase fails closed on early host release or residue", () => {
  const result = verifyMacosEc2JitQualification({
    jobs: [],
    hostLifecycle: {
      status: "failed",
      allocatedAt: "2026-07-29T00:00:00Z",
      releasedAt: "2026-07-29T23:59:00Z",
      instanceTerminated: false,
      scrubCompleted: false,
      hostReleased: false,
    },
    registeredCloudRunners: ["runner-1"],
    activeInstances: ["i-1"],
    allocatedHosts: ["h-1"],
    disposableVolumes: ["vol-1"],
    actualIncrementalSpendUsd: 0,
    observedAt: "2026-07-30T00:00:00Z",
  });
  assert.equal(result.qualifying, false);
  assert.ok(result.issues.includes("dedicated-host-lifecycle-not-proven"));
  assert.ok(result.issues.includes("allocated-hosts-remain"));
});

test("macOS stack and bootstrap enforce one-host JIT cleanup and no ingress", () => {
  const stack = fs.readFileSync(
    path.join(
      root,
      "infra/aws-us-elastic-runner-burst-plane/macos-jit.template.yml",
    ),
    "utf8",
  );
  const bootstrap = fs.readFileSync(
    path.join(
      root,
      "infra/aws-us-elastic-runner-burst-plane/macos-jit-bootstrap.sh",
    ),
    "utf8",
  );
  assert.match(stack, /SecurityGroupIngress: \[\]/);
  assert.match(stack, /MinimumHostAllocationHours/);
  assert.match(stack, /MaximumHostAllocationHours/);
  assert.match(stack, /ec2:AllocateHosts/);
  assert.match(stack, /ec2:ReleaseHosts/);
  assert.match(stack, /ec2:DescribeSubnets/);
  assert.match(stack, /rate\(10 minutes\)/);
  assert.match(stack, /ssm:GetParameter/);
  assert.match(stack, /ssm:DescribeParameters/);
  assert.match(stack, /ssm:DescribeInstanceInformation/);
  assert.match(stack, /Metrics:\n\s+- UnblendedCost/);
  assert.match(stack, /Key: USAGE_TYPE/);
  assert.match(stack, /HostUsage:mac2/);
  assert.match(stack, /USE2-HostUsage:mac2/);
  assert.match(stack, /Key: OPERATION/);
  assert.match(stack, /- RunInstances/);
  assert.match(stack, /Key: REGION/);
  assert.match(stack, /- us-east-1\n\s+- us-east-2/);
  assert.doesNotMatch(stack, /CostFilters:|TagKeyValue:/);
  assert.match(
    stack,
    /BudgetLimitUsd:\n\s+Type: Number\n\s+Default: 25\n\s+MinValue: 1\n\s+MaxValue: 25/,
  );
  assert.match(bootstrap, /latest\/api\/token/);
  assert.match(
    bootstrap,
    /RunnerPath="\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/,
  );
  assert.match(bootstrap, /export PATH="\$RunnerPath"/);
  assert.match(
    bootstrap,
    /install -d -o "\$RunnerUser" -g staff -m 700 "\$RunnerBase"/,
  );
  assert.match(
    bootstrap,
    /sudo -u "\$RunnerUser" -H env \\\n\s+PATH="\$RunnerPath"/,
  );
  assert.match(bootstrap, /aws ssm get-parameter/);
  assert.match(bootstrap, /aws ssm delete-parameter/);
  assert.match(bootstrap, /run\.sh" --jitconfig "\$JitConfig"/);
  assert.match(
    bootstrap,
    /8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079/,
  );
  assert.doesNotMatch(bootstrap, /encoded_jit_config|github_pat_|ghp_|gho_/);
});

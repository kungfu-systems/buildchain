import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createWindowsJitEvidence,
  renderWindowsJitBootstrap,
  verifyWindowsEc2JitQualification,
  windowsEc2JitPlan,
  windowsJitCampaignId,
  windowsJitRunnerLabel,
  windowsJitRunnerLabels,
} from "../scripts/aws-windows-jit-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Windows EC2 JIT plan is bounded below the USD 110 phase cap", () => {
  const plan = windowsEc2JitPlan();
  assert.equal(plan.config.maxAcceptedInstances, 5);
  assert.equal(plan.config.maxConcurrentInstances, 1);
  assert.equal(plan.costEnvelope.maximumCommittedComputeUsd, 21.75);
  assert.equal(plan.costEnvelope.maximumRaceStopUsd, 4.35);
  assert.equal(plan.costEnvelope.maximumBoundedSpendUsd, 26.1);
  assert.ok(plan.costEnvelope.maximumBoundedSpendUsd < 110);
  assert.equal(plan.invariants.oneJobPerRunner, true);
  assert.equal(plan.invariants.zeroWarmCapacity, true);
});

test("Windows EC2 JIT plan rejects an unsafe cost envelope", () => {
  assert.throws(
    () => windowsEc2JitPlan({ maxAcceptedInstances: 25 }),
    /must remain below budget/,
  );
});

test("Windows JIT runner labels are card-scoped and bounded", () => {
  assert.equal(
    windowsJitRunnerLabel("aws-us-ec2-windows-jit-full-01"),
    "aws-us-ec2-windows-jit-full-01",
  );
  assert.throws(
    () => windowsJitRunnerLabel("kungfu-build-v4-windows-x64"),
    /must match/,
  );
  assert.deepEqual(windowsJitRunnerLabels("aws-us-ec2-windows-jit-full-01"), [
    "self-hosted",
    "Windows",
    "X64",
    "aws-us-ec2-windows-jit-full-01",
  ]);
  assert.throws(
    () => windowsJitCampaignId("win-this-campaign-id-is-too-long"),
    /bounded Windows campaign id/,
  );
});

test("Windows bootstrap keeps JIT material out of user data", () => {
  const template =
    "campaign=__CAMPAIGN_ID__;param=__JIT_PARAMETER_NAME__;label=__RUNNER_LABEL__;bucket=__EVIDENCE_BUCKET__;sha=__SOURCE_SHA__;run=__GITHUB_RUN_ID__;attempt=__GITHUB_RUN_ATTEMPT__;ami=__AMI_ID__;name=__AMI_NAME__;region=__REGION__;type=__INSTANCE_TYPE__;launched=__LAUNCHED_AT__";
  const rendered = renderWindowsJitBootstrap(template, {
    campaignId: "win-20260802-ledger",
    jitParameterName: "/kungfu/burst/windows/full-01",
    evidenceBucket: "kungfu-windows-jit-evidence",
    runnerLabel: "aws-us-ec2-windows-jit-full-01",
    sourceSha: "a".repeat(40),
    githubRunId: "123",
    githubRunAttempt: "1",
    amiId: "ami-0123456789abcdef0",
    amiName: "Windows_Server-2025-English-Full-Base-2026.07.15",
    launchedAt: "2026-07-29T00:00:00Z",
  });
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
  assert.doesNotMatch(rendered, /encoded_jit_config|github_pat_|ghp_|gho_/);
  assert.match(rendered, /\/kungfu\/burst\/windows\/full-01/);
  assert.match(rendered, /campaign=win-20260802-ledger/);
});

test("Windows JIT evidence binds exact source, AMI, runner, and lifecycle", () => {
  const evidence = createWindowsJitEvidence({
    repository: "kungfu-systems/kungfu",
    campaignId: "win-20260802-ledger",
    sourceSha: "a".repeat(40),
    sourceRef: "refs/heads/dev/v4/v4.0",
    githubRunId: "123",
    githubRunAttempt: "1",
    githubJob: "full",
    runnerName: "aws-win-full-01",
    runnerLabels: [
      "self-hosted",
      "Windows",
      "X64",
      "aws-us-ec2-windows-jit-full-01",
    ],
    instanceId: "i-0123456789abcdef0",
    instanceType: "c7i.4xlarge",
    amiId: "ami-0123456789abcdef0",
    amiName: "Windows_Server-2025-English-Full-Base",
    availabilityZone: "us-east-1a",
    launchedAt: "2026-07-29T00:00:00Z",
    runnerStartedAt: "2026-07-29T00:10:00Z",
    runnerExitedAt: "2026-07-29T01:00:00Z",
    terminatedAt: "2026-07-29T01:01:00Z",
    cleanupResult: "terminated",
  });
  assert.equal(evidence.source.sha, "a".repeat(40));
  assert.equal(evidence.campaign.id, "win-20260802-ledger");
  assert.equal(evidence.aws.instanceId, "i-0123456789abcdef0");
  assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
});

test("Windows phase requires smoke, three full jobs, both cleanups, and zero residue", () => {
  const jobs = [
    { kind: "smoke" },
    { kind: "full" },
    { kind: "full" },
    { kind: "full" },
  ].map((job) => ({
    ...job,
    campaignId: "win-20260802-ledger",
    trusted: true,
    exactSource: true,
    status: "succeeded",
    oneJobJit: true,
  }));
  const cleanup = {
    status: "passed",
    cleanupLatencySeconds: 120,
    instanceTerminated: true,
    runnerRemoved: true,
  };
  const result = verifyWindowsEc2JitQualification({
    campaignId: "win-20260802-ledger",
    jobs,
    cancellationCleanup: cleanup,
    timeoutCleanup: cleanup,
    registeredCloudRunners: [],
    activeInstances: [],
    disposableVolumes: [],
    minCapacity: 0,
    desiredCapacity: 0,
    actualIncrementalSpendUsd: 8.2,
    observedAt: "2026-07-29T02:00:00Z",
  });
  assert.equal(result.qualifying, true);
  assert.equal(result.metrics.fullJobs, 3);
  const mismatched = verifyWindowsEc2JitQualification({
    campaignId: "win-20260802-ledger",
    jobs: jobs.map((job, index) =>
      index === 0 ? { ...job, campaignId: "win-other-campaign" } : job,
    ),
    cancellationCleanup: cleanup,
    timeoutCleanup: cleanup,
    actualIncrementalSpendUsd: 8.2,
  });
  assert.ok(mismatched.issues.includes("accepted-jobs-not-bound-to-campaign"));
});

test("Windows phase fails closed on residue or missing timeout cleanup", () => {
  const result = verifyWindowsEc2JitQualification({
    campaignId: "win-20260802-ledger",
    jobs: [],
    cancellationCleanup: {
      status: "passed",
      cleanupLatencySeconds: 1,
      instanceTerminated: true,
      runnerRemoved: true,
    },
    timeoutCleanup: {
      status: "failed",
      cleanupLatencySeconds: 901,
      instanceTerminated: false,
      runnerRemoved: false,
    },
    registeredCloudRunners: ["runner-1"],
    activeInstances: ["i-1"],
    disposableVolumes: ["vol-1"],
    actualIncrementalSpendUsd: 0,
    observedAt: "2026-07-29T02:00:00Z",
  });
  assert.equal(result.qualifying, false);
  assert.ok(result.issues.includes("timeout-cleanup-not-proven"));
  assert.ok(result.issues.includes("active-instances-remain"));
});

test("Windows stack and bootstrap enforce JIT, IMDSv2, cleanup, and no ingress", () => {
  const stack = fs.readFileSync(
    path.join(
      root,
      "infra/aws-us-elastic-runner-burst-plane/windows-jit.template.yml",
    ),
    "utf8",
  );
  const bootstrap = fs.readFileSync(
    path.join(
      root,
      "infra/aws-us-elastic-runner-burst-plane/windows-jit-bootstrap.ps1",
    ),
    "utf8",
  );
  const budgetGuard = fs.readFileSync(
    path.join(
      root,
      "infra/aws-us-elastic-runner-burst-plane/windows-jit-budget-guard.template.yml",
    ),
    "utf8",
  );
  assert.match(stack, /SecurityGroupIngress: \[\]/);
  assert.match(stack, /MaximumInstanceLifetimeMinutes/);
  assert.match(stack, /rate\(5 minutes\)/);
  assert.match(stack, /reaper\/\$\{AWS::StackName\}/);
  assert.match(stack, /ec2:TerminateInstances/);
  assert.match(stack, /ssm:GetParameter/);
  assert.match(stack, /s3:PutObject/);
  assert.match(stack, /Type: AWS::DynamoDB::Table/);
  assert.match(stack, /PointInTimeRecoveryEnabled: true/);
  assert.match(stack, /dynamodb:TransactWriteItems/);
  assert.match(stack, /dynamodb:GetItem/);
  assert.match(stack, /STATE_TABLE: !Ref CampaignState/);
  assert.match(stack, /kill_campaign\(/);
  assert.match(stack, /ConsistentRead=True/);
  assert.match(stack, /control = campaign_control\(\)/);
  assert.match(stack, /ProjectionExpression="#state, campaign_id"/);
  assert.match(stack, /campaign_id = control\["campaign_id"\]/);
  assert.match(stack, /if not campaign_id:/);
  assert.match(
    stack,
    /{"Name": "tag:kungfu:campaign-id", "Values": \[campaign_id\]}/,
  );
  assert.match(stack, /kill_all = sns_kill or control_killed/);
  assert.match(stack, /if sns_kill and not control_killed:/);
  assert.match(stack, /runner-lifetime-violation/);
  assert.match(stack, /ProviderBudgetKillParameterName/);
  assert.match(stack, /budgets:ViewBudget/);
  assert.match(stack, /billing:GetBillingViewData/);
  assert.doesNotMatch(stack, /Type: AWS::Budgets::Budget/);
  assert.match(budgetGuard, /Type: AWS::Budgets::Budget/);
  assert.match(
    budgetGuard,
    /!Sub "user:\$\{ProviderTagKey\}\$\$\{ProviderTagValue\}"/,
  );
  assert.match(budgetGuard, /provider-budget-killed/);
  assert.match(budgetGuard, /aws-tag-filtered-budget-notification/);
  assert.match(budgetGuard, /ec2:TerminateInstances/);
  assert.match(
    stack,
    /BudgetLimitUsd:\n\s+Type: Number\n\s+Default: 110\n\s+MinValue: 1\n\s+MaxValue: 110/,
  );
  assert.match(bootstrap, /latest\/api\/token/);
  assert.match(bootstrap, /AWS\.Tools\.SimpleSystemsManagement/);
  assert.match(bootstrap, /AWS\.Tools\.S3/);
  assert.match(bootstrap, /PowerShell-\$PowerShellVersion-win-x64\.msi/);
  assert.match(
    bootstrap,
    /d11942df52fd12470169797abfa4781d9480efdc81000ba4fa55a5b921ed8dd0/,
  );
  assert.match(bootstrap, /\$Root\\bin;\$Root\\cmd;\$env:PATH/);
  assert.doesNotMatch(bootstrap, /\\usr\\bin/);
  assert.match(bootstrap, /Remove-SSMParameter/);
  assert.match(bootstrap, /Join-Path \$RunnerRoot "\.env"/);
  assert.match(
    bootstrap,
    /BUILDCHAIN_RUNNER_LABELS_JSON=\$\(\$env:BUILDCHAIN_RUNNER_LABELS_JSON\)/,
  );
  assert.doesNotMatch(bootstrap, /encoded_jit_config=.*\.env|Jit=.*\.env/);
  assert.match(bootstrap, /run\.cmd" --jitconfig \$Jit/);
  assert.match(bootstrap, /Stop-Computer -Force/);
  assert.doesNotMatch(bootstrap, /encoded_jit_config|github_pat_|ghp_|gho_/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRunnerEvidence,
  linuxCodeBuildPlan,
  verifyLinuxCodeBuildQualification,
} from "../scripts/aws-runner-burst-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Linux CodeBuild plan has a strict sub-USD-49 worst-case envelope", () => {
  const plan = linuxCodeBuildPlan();
  assert.equal(plan.config.maxConcurrentBuilds, 2);
  assert.equal(plan.config.minimumAcceptedJobs, 10);
  assert.equal(plan.config.maxAcceptedBuilds, 17);
  assert.equal(plan.costEnvelope.maximumCommittedComputeUsd, 40.8);
  assert.equal(plan.costEnvelope.maximumRaceStopUsd, 4.8);
  assert.equal(plan.costEnvelope.maximumBoundedSpendUsd, 45.6);
  assert.ok(plan.costEnvelope.maximumBoundedSpendUsd < 49);
  assert.equal(plan.invariants.staleOrMissingCostTelemetryFailsClosed, true);
});

test("Linux CodeBuild plan rejects an unsafe cost envelope", () => {
  assert.throws(
    () => linuxCodeBuildPlan({ maxAcceptedBuilds: 19 }),
    /must remain below budget/,
  );
});

test("runner evidence binds exact source, GitHub job, and CodeBuild build", () => {
  const evidence = createRunnerEvidence({
    provider: "aws-codebuild",
    project: "kungfu-buildchain-linux-burst-poc",
    repository: "kungfu-systems/kungfu",
    sourceSha: "a".repeat(40),
    sourceRef: "refs/heads/dev/v4/v4.0",
    runId: "123",
    runAttempt: "1",
    job: "build-native",
    codeBuildBuildId: "project:build-id",
    codeBuildBuildArn: "arn:aws:codebuild:us-east-1:123:build/project:build-id",
    codeBuildInitiator: "GitHub-Hookshot/abc",
    observedAt: "2026-07-28T12:00:00Z",
  });
  assert.equal(evidence.source.sha, "a".repeat(40));
  assert.equal(evidence.github.runId, "123");
  assert.match(evidence.digest, /^sha256:[0-9a-f]{64}$/);
});

test("phase verification accepts ten exact-source jobs and zero idle compute", () => {
  const jobs = Array.from({ length: 10 }, (_, index) => ({
    trusted: true,
    exactSource: true,
    status: "succeeded",
    queueStartSeconds: 30 + index,
    observedConcurrency: index < 2 ? 2 : 1,
  }));
  const result = verifyLinuxCodeBuildQualification({
    jobs,
    actualIncrementalSpendUsd: 4.2,
    idleBuilds: [],
    activeCloudResources: [],
    telemetryObservedAt: "2026-07-28T11:30:00Z",
    observedAt: "2026-07-28T12:00:00Z",
  });
  assert.equal(result.qualifying, true);
  assert.equal(result.metrics.acceptedJobs, 10);
});

test("phase verification fails closed on stale telemetry or cloud residue", () => {
  const result = verifyLinuxCodeBuildQualification({
    jobs: [],
    actualIncrementalSpendUsd: 0,
    idleBuilds: ["build-id"],
    activeCloudResources: ["project"],
    telemetryObservedAt: "2026-07-27T00:00:00Z",
    observedAt: "2026-07-28T12:00:00Z",
  });
  assert.equal(result.qualifying, false);
  assert.ok(result.issues.includes("cost-telemetry-missing-or-stale"));
  assert.ok(result.issues.includes("idle-builds-remain"));
});

test("workflow keeps trust ahead of dynamic CodeBuild runner selection", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );
  const trust = workflow.indexOf("  trust-gate:");
  const native = workflow.indexOf("  build-native:");
  assert.ok(trust >= 0 && native > trust);
  const nativeBlock = workflow.slice(native, workflow.indexOf("\n  build-linux-container:", native));
  assert.match(
    nativeBlock,
    /if: \$\{\{ needs\.trust-gate\.outputs\.trusted == 'true'/,
  );
  assert.match(
    nativeBlock,
    /codebuild-\{0\}-\{1\}-\{2\}/,
  );
  assert.match(nativeBlock, /aws-runner-burst\.mjs evidence/);
});

test("workflow bounds CodeBuild jobs and lifecycle stages with the caller timeout", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/.build.yml"),
    "utf8",
  );
  assert.match(
    workflow,
    /lifecycle-timeout-minutes:\n\s+description: "Maximum minutes for the build matrix job and fallback timeout for each lifecycle stage"\n\s+default: 120\n\s+type: number/,
  );
  assert.equal(
    (
      workflow.match(
        /timeout-minutes: \$\{\{ inputs\.lifecycle-timeout-minutes \}\}/g,
      ) || []
    ).length,
    8,
  );
});

test("CodeBuild stack is credential-free, bounded, and fail closed", () => {
  const template = fs.readFileSync(
    path.join(
      root,
      "infra/aws-us-elastic-runner-burst-plane/codebuild-poc.template.yml",
    ),
    "utf8",
  );
  assert.match(template, /Type: CODECONNECTIONS/);
  assert.match(template, /ConcurrentBuildLimit: 2/);
  assert.match(template, /TimeoutInMinutes: 120/);
  assert.match(template, /ComputeType: BUILD_GENERAL1_LARGE/);
  assert.match(template, /Triggers:\n\s+Webhook: false\n\s+Tags:/);
  assert.doesNotMatch(template, /Webhook: false\n\s+FilterGroups:/);
  assert.match(template, /codebuild\.delete_webhook/);
  assert.match(template, /cost-telemetry-missing/);
  assert.match(template, /dynamodb\.transact_write_items/);
  assert.match(template, /BUILD#\{build_id\}/);
  assert.match(template, /TransactionCanceledException/);
  assert.doesNotMatch(
    template,
    /PERSONAL_ACCESS_TOKEN|AWS_ACCESS_KEY_ID|SecretAccessKey|ssh-rsa/,
  );
});
